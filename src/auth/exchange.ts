import { createHash } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { BookStackCredential } from '../api/client';
import { AUTH_SERVER_TIMEOUT_MS, type OidcIssuer } from './oidc';

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** Stop reusing an exchanged token this long before it expires. */
const EXPIRY_MARGIN_MS = 30_000;

/** Default bound on cached exchanged tokens. */
const DEFAULT_MAX_ENTRIES = 1_000;

/** OAuth error codes that mean the user's token no longer works, so the client should re-authenticate. */
const USER_TOKEN_ERRORS: ReadonlySet<string> = new Set(['invalid_grant', 'invalid_token']);

/** RFC 6749 / 8693 error codes; anything else is logged as "other". */
const KNOWN_OAUTH_ERRORS: ReadonlySet<string> = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'invalid_target',
  'invalid_token',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
]);

/**
 * Why an exchange failed.
 * - `rejected`: the user's token was refused; the MCP client should re-authenticate (401).
 * - `forbidden`: the authorization server denied this user the exchange (403).
 * - `misconfigured`: this server's client or the realm setup is wrong (500).
 * - `unavailable`: the authorization server could not be reached, was throttling, or answered unusably (503).
 */
export type TokenExchangeFailure = 'rejected' | 'forbidden' | 'misconfigured' | 'unavailable';

export class TokenExchangeError extends Error {
  constructor(
    readonly kind: TokenExchangeFailure,
    /** HTTP status from the token endpoint, when there was one. */
    readonly status?: number,
    /** The OAuth error code, limited to the known vocabulary so it is safe to log. */
    readonly oauthError?: string
  ) {
    super(`Token exchange failed (${kind})`);
    this.name = 'TokenExchangeError';
  }
}

export interface BookStackTokenExchangerOptions {
  issuer: OidcIssuer;
  clientId: string;
  clientSecret: string;
  /** Audience BookStack requires on access tokens (OIDC_API_AUDIENCE). */
  audience: string;
  maxEntries?: number;
}

interface CachedToken {
  secret: string;
  reuseUntilMs: number;
}

function classifyFailure(status: number, code: string | undefined): TokenExchangeFailure {
  if (status >= 500 || status === 429) {
    return 'unavailable';
  }
  if (code === 'access_denied') {
    return 'forbidden';
  }
  return code !== undefined && USER_TOKEN_ERRORS.has(code) ? 'rejected' : 'misconfigured';
}

/** RFC 6749 section 2.3.1: client credentials are form-encoded before Basic encoding. */
function basicAuthorization(clientId: string, clientSecret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`;
}

/**
 * Exchanges a verified inbound token for a BookStack API token (RFC 8693), as this server's
 * own confidential client. The inbound token is never sent to BookStack.
 *
 * Results are cached under a digest of the inbound token until shortly before the exchanged
 * token expires, and concurrent requests for the same token share one exchange.
 */
export class BookStackTokenExchanger {
  private readonly cache = new Map<string, CachedToken>();
  private readonly pending = new Map<string, Promise<BookStackCredential>>();
  private readonly maxEntries: number;

  constructor(private readonly options: BookStackTokenExchangerOptions) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async exchange(auth: AuthInfo): Promise<BookStackCredential> {
    const principal = `${String(auth.extra?.issuer)}\u0000${String(auth.extra?.subject)}`;
    const key = createHash('sha256').update(auth.token).digest('hex');

    const cached = this.cache.get(key);
    if (cached && cached.reuseUntilMs > Date.now()) {
      return { scheme: 'Bearer', secret: cached.secret, principal };
    }
    this.cache.delete(key);

    let inFlight = this.pending.get(key);
    if (!inFlight) {
      inFlight = this.request(auth, key, principal).finally(() => this.pending.delete(key));
      this.pending.set(key, inFlight);
    }
    return inFlight;
  }

  private async request(
    auth: AuthInfo,
    key: string,
    principal: string
  ): Promise<BookStackCredential> {
    const { tokenEndpoint } = await this.options.issuer.metadata();

    let response: Response;
    try {
      response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          authorization: basicAuthorization(this.options.clientId, this.options.clientSecret),
        },
        body: new URLSearchParams({
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: auth.token,
          subject_token_type: ACCESS_TOKEN_TYPE,
          requested_token_type: ACCESS_TOKEN_TYPE,
          audience: this.options.audience,
        }),
        // A redirect would resend the subject token and client secret to wherever it points.
        redirect: 'error',
        signal: AbortSignal.timeout(AUTH_SERVER_TIMEOUT_MS),
      });
    } catch {
      throw new TokenExchangeError('unavailable');
    }

    const body = (await response.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;

    if (!response.ok) {
      const code = typeof body?.error === 'string' ? body.error : undefined;
      throw new TokenExchangeError(
        classifyFailure(response.status, code),
        response.status,
        code === undefined || KNOWN_OAUTH_ERRORS.has(code) ? code : 'other'
      );
    }

    const secret = body?.access_token;
    if (typeof secret !== 'string' || secret === '') {
      throw new TokenExchangeError('unavailable', response.status);
    }

    this.remember(key, secret, auth, body?.expires_in);
    return { scheme: 'Bearer', secret, principal };
  }

  private remember(key: string, secret: string, auth: AuthInfo, expiresIn: unknown): void {
    const now = Date.now();
    // Bounded by the exchanged token only: the inbound token is re-verified on every request.
    const exchangedExpiryMs =
      typeof expiresIn === 'number' ? now + expiresIn * 1000 : (auth.expiresAt ?? 0) * 1000;
    const reuseUntilMs = exchangedExpiryMs - EXPIRY_MARGIN_MS;
    if (reuseUntilMs <= now) {
      return;
    }

    if (this.cache.size >= this.maxEntries) {
      for (const [cachedKey, entry] of this.cache) {
        if (entry.reuseUntilMs <= now) {
          this.cache.delete(cachedKey);
        }
      }
    }
    while (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { secret, reuseUntilMs });
  }
}
