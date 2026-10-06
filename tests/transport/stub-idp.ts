/**
 * In-process OIDC provider stub: discovery, JWKS and an RFC 8693 token endpoint.
 *
 * Mirrors what the server needs from an OIDC provider. Tokens are really signed (RS256), so the
 * server's verification runs for real; `mint` can also sign with a key the JWKS does not
 * publish, to prove signatures are checked.
 */

import { type CryptoKey, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';

const KEY_ID = 'stub-signing-key';
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** One token endpoint request, as the stub received it. */
export interface RecordedExchange {
  authorization: string | undefined;
  form: Record<string, string>;
}

/** What the token endpoint answers with instead of a successful exchange. */
export type ExchangeOverride =
  | { status: number; body: unknown; headers?: Record<string, string> }
  | 'drop';

export interface IdpStub {
  issuer: string;
  clientId: string;
  clientSecret: string;
  readonly exchanges: RecordedExchange[];
  /** Access tokens the stub has issued from exchanges, oldest first. */
  readonly issued: string[];
  /** Set to make the token endpoint fail; cleared by the test. */
  exchangeOverride: ExchangeOverride | undefined;
  /** Set to make discovery answer 503. */
  discoveryDown: boolean;
  /** Requests that reached the redirect sink, which no client should follow a redirect to. */
  readonly sinkHits: number;
  /** Sign `claims` with the published key, or with a key the JWKS does not publish. */
  mint(claims: JWTPayload, options?: { untrusted?: boolean }): Promise<string>;
  stop(): Promise<void>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export async function startIdpStub(
  options: { onIssue?: (accessToken: string) => void } = {}
): Promise<IdpStub> {
  const trusted = await generateKeyPair('RS256', { extractable: true });
  const untrusted = await generateKeyPair('RS256');
  const publicJwk = {
    ...(await exportJWK(trusted.publicKey)),
    kid: KEY_ID,
    alg: 'RS256',
    use: 'sig',
  };

  const exchanges: RecordedExchange[] = [];
  const issued: string[] = [];
  const clientId = 'bookstack-mcp-server';
  const clientSecret = 'stub-client-secret';
  const expectedAuthorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;

  const state = {
    exchangeOverride: undefined as ExchangeOverride | undefined,
    discoveryDown: false,
    sinkHits: 0,
  };

  let issuer = '';

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const base = new URL(issuer).pathname;

      if (url.pathname === `${base}/.well-known/openid-configuration`) {
        if (state.discoveryDown) {
          return json({ error: 'unavailable' }, 503);
        }
        return json({
          issuer,
          jwks_uri: `${issuer}/jwks`,
          token_endpoint: `${issuer}/token`,
        });
      }

      if (url.pathname === `${base}/sink`) {
        state.sinkHits += 1;
        return json({ error: 'sink' }, 400);
      }

      if (url.pathname === `${base}/jwks`) {
        return json({ keys: [publicJwk] });
      }

      if (url.pathname === `${base}/token` && request.method === 'POST') {
        const form = Object.fromEntries(new URLSearchParams(await request.text()));
        const authorization = request.headers.get('authorization') ?? undefined;
        exchanges.push({ authorization, form });

        const override = state.exchangeOverride;
        if (override === 'drop') {
          return new Response('upstream gone', { status: 502 });
        }
        if (override) {
          const response = json(override.body, override.status);
          for (const [name, value] of Object.entries(override.headers ?? {})) {
            response.headers.set(name, value);
          }
          return response;
        }
        if (authorization !== expectedAuthorization) {
          return json({ error: 'invalid_client' }, 401);
        }
        if (form.grant_type !== TOKEN_EXCHANGE_GRANT) {
          return json({ error: 'unsupported_grant_type' }, 400);
        }

        const accessToken = `stub-exchanged-${issued.length + 1}`;
        issued.push(accessToken);
        options.onIssue?.(accessToken);
        return json({
          access_token: accessToken,
          expires_in: 300,
          token_type: 'Bearer',
          issued_token_type: ACCESS_TOKEN_TYPE,
        });
      }

      return json({ error: 'not_found' }, 404);
    },
  });

  issuer = `http://127.0.0.1:${server.port}/issuer`;

  async function mint(claims: JWTPayload, options: { untrusted?: boolean } = {}): Promise<string> {
    const key: CryptoKey = options.untrusted ? untrusted.privateKey : trusted.privateKey;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KEY_ID, typ: 'JWT' })
      .sign(key);
  }

  return {
    issuer,
    clientId,
    clientSecret,
    exchanges,
    issued,
    get exchangeOverride() {
      return state.exchangeOverride;
    },
    set exchangeOverride(value) {
      state.exchangeOverride = value;
    },
    get sinkHits() {
      return state.sinkHits;
    },
    get discoveryDown() {
      return state.discoveryDown;
    },
    set discoveryDown(value) {
      state.discoveryDown = value;
    },
    mint,
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}
