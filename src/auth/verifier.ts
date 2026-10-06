import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { errors, jwtVerify } from 'jose';
import { AuthServerUnavailableError, type OidcIssuer } from './oidc';

/** Algorithms accepted on inbound tokens; RS256 matches what BookStack's OIDC support verifies. */
const ALLOWED_ALGORITHMS = ['RS256'];

/** Tolerated clock skew between this server and the issuer, in seconds. */
const CLOCK_TOLERANCE_SECONDS = 30;

/** jose error codes that mean the token itself is bad, as opposed to the key set being unreachable. */
const TOKEN_FAULT_CODES: ReadonlySet<string> = new Set([
  errors.JWTExpired.code,
  errors.JWTClaimValidationFailed.code,
  errors.JWTInvalid.code,
  errors.JWSInvalid.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JWKSNoMatchingKey.code,
  errors.JWKSMultipleMatchingKeys.code,
  errors.JOSEAlgNotAllowed.code,
  errors.JOSENotSupported.code,
]);

/** The inbound access token is missing, malformed, expired or not issued for this server. */
export class AccessTokenRejectedError extends Error {
  constructor(readonly reason: string) {
    super('The access token is invalid, expired or not issued for this server');
    this.name = 'AccessTokenRejectedError';
  }
}

export interface JwtAccessTokenVerifierOptions {
  issuer: OidcIssuer;
  /** This server's canonical URL, which the token's audience must contain. */
  resource: string;
}

/**
 * Validates inbound JWT access tokens as an OAuth resource server (MCP authorization).
 *
 * Signature against the issuer's published keys, exact issuer, expiry, a subject, and an
 * audience naming this server. A token for any other audience - including one for BookStack
 * itself, or an ID token for the client - is refused.
 */
export class JwtAccessTokenVerifier implements OAuthTokenVerifier {
  private readonly audiences: string[];

  constructor(private readonly options: JwtAccessTokenVerifierOptions) {
    const withoutSlash = options.resource.replace(/\/$/, '');
    this.audiences = [withoutSlash, `${withoutSlash}/`];
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const keySet = await this.options.issuer.keySet();

    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: this.options.issuer.issuer,
        audience: this.audiences,
        algorithms: ALLOWED_ALGORITHMS,
        requiredClaims: ['exp', 'sub'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }));
    } catch (error) {
      if (error instanceof errors.JOSEError && TOKEN_FAULT_CODES.has(error.code)) {
        throw new AccessTokenRejectedError(error.code);
      }
      throw new AuthServerUnavailableError('Could not load the issuer signing keys', {
        cause: error,
      });
    }

    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new AccessTokenRejectedError('ERR_JWT_MISSING_SUBJECT');
    }
    // Issuers that label token kinds in `typ` call access tokens `Bearer`; ID or refresh tokens must not pass.
    if (payload.typ !== undefined && payload.typ !== 'Bearer') {
      throw new AccessTokenRejectedError('ERR_JWT_NOT_ACCESS_TOKEN');
    }

    return {
      token,
      clientId: typeof payload.azp === 'string' ? payload.azp : '',
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
      expiresAt: payload.exp as number,
      resource: new URL(this.options.resource),
      extra: { issuer: this.options.issuer.issuer, subject: payload.sub },
    };
  }
}
