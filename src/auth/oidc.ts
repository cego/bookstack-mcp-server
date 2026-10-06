import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { usesSecureTransport } from '../config/manager';

/** Timeout for every call this server makes to the authorization server. */
export const AUTH_SERVER_TIMEOUT_MS = 5_000;

/** The authorization server could not be reached or answered unusably; retryable. */
export class AuthServerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuthServerUnavailableError';
  }
}

/** The parts of the issuer's OpenID Connect discovery document this server uses. */
export interface IssuerMetadata {
  issuer: string;
  jwksUri: string;
  tokenEndpoint: string;
}

/** A discovery endpoint URL, refused unless it is absolute and over TLS (or loopback). */
function endpoint(value: unknown, name: string): string {
  if (typeof value === 'string') {
    try {
      if (usesSecureTransport(new URL(value))) {
        return value;
      }
    } catch {
      // Falls through to the refusal below.
    }
  }
  throw new AuthServerUnavailableError(`OIDC discovery returned an unusable ${name}`);
}

/**
 * The configured OIDC issuer: its discovery document and signing keys.
 *
 * Discovery is fetched once and kept; a failure is not cached, so the next request retries.
 * Keys come from jose's remote key set, which caches them and refetches on an unknown key ID.
 */
export class OidcIssuer {
  private discovered: Promise<IssuerMetadata> | undefined;
  private keys: JWTVerifyGetKey | undefined;

  constructor(readonly issuer: string) {}

  metadata(): Promise<IssuerMetadata> {
    if (!this.discovered) {
      const attempt = this.discover();
      this.discovered = attempt;
      attempt.catch(() => {
        if (this.discovered === attempt) {
          this.discovered = undefined;
        }
      });
    }
    return this.discovered;
  }

  /** Fetch discovery afresh, bypassing the cache; for readiness checks. */
  async probe(): Promise<void> {
    await this.discover();
  }

  async keySet(): Promise<JWTVerifyGetKey> {
    if (!this.keys) {
      const { jwksUri } = await this.metadata();
      this.keys ??= createRemoteJWKSet(new URL(jwksUri), {
        timeoutDuration: AUTH_SERVER_TIMEOUT_MS,
      });
    }
    return this.keys;
  }

  private async discover(): Promise<IssuerMetadata> {
    const url = `${this.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    let document: Record<string, unknown>;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(AUTH_SERVER_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new AuthServerUnavailableError(`OIDC discovery answered HTTP ${response.status}`);
      }
      document = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof AuthServerUnavailableError) {
        throw error;
      }
      throw new AuthServerUnavailableError('OIDC discovery failed', { cause: error });
    }

    // OIDC Discovery 1.0 section 4.3: the document must name exactly the issuer it was fetched for.
    if (document.issuer !== this.issuer) {
      throw new AuthServerUnavailableError('OIDC discovery names a different issuer');
    }

    return {
      issuer: this.issuer,
      jwksUri: endpoint(document.jwks_uri, 'jwks_uri'),
      tokenEndpoint: endpoint(document.token_endpoint, 'token_endpoint'),
    };
  }
}
