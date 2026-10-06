import type { RequestHandler } from 'express';
import type { OAuthConfig } from '../config/manager';
import type { Logger } from '../utils/logger';
import { BookStackTokenExchanger } from './exchange';
import { protectedResourceMetadata, protectedResourceMetadataPath } from './metadata';
import { requireOAuth } from './middleware';
import { OidcIssuer } from './oidc';
import { JwtAccessTokenVerifier } from './verifier';

export { bookstackCredential } from './middleware';

/** Everything the HTTP transport needs to act as an OAuth resource server. */
export interface OAuthResourceServer {
  issuer: OidcIssuer;
  /** Authenticates POST /message and resolves the caller's BookStack credential. */
  authenticate: RequestHandler;
  metadataPath: string;
  metadata: ReturnType<typeof protectedResourceMetadata>;
}

export function createOAuthResourceServer(
  oauth: OAuthConfig,
  logger: Logger,
  bodyLimitBytes: number
): OAuthResourceServer {
  const issuer = new OidcIssuer(oauth.issuer);
  return {
    issuer,
    authenticate: requireOAuth({
      verifier: new JwtAccessTokenVerifier({ issuer, resource: oauth.resource }),
      exchanger: new BookStackTokenExchanger({
        issuer,
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        audience: oauth.bookstackAudience,
      }),
      resource: oauth.resource,
      logger,
      bodyLimitBytes,
    }),
    metadataPath: protectedResourceMetadataPath(oauth.resource),
    metadata: protectedResourceMetadata(oauth.resource, oauth.issuer),
  };
}
