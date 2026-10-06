import type { Request, RequestHandler, Response } from 'express';
import type { BookStackCredential } from '../api/client';
import type { Logger } from '../utils/logger';
import { type BookStackTokenExchanger, TokenExchangeError } from './exchange';
import { bearerChallenge } from './metadata';
import { AuthServerUnavailableError } from './oidc';
import { AccessTokenRejectedError, type JwtAccessTokenVerifier } from './verifier';

export interface OAuthMiddlewareOptions {
  verifier: JwtAccessTokenVerifier;
  exchanger: BookStackTokenExchanger;
  resource: string;
  logger: Logger;
  /** Most body bytes read and discarded before an early answer; past it the request is dropped. */
  bodyLimitBytes: number;
}

/** The BookStack credential the OAuth middleware resolved for this request. */
export function bookstackCredential(res: Response): BookStackCredential {
  return res.locals.bookstackCredential as BookStackCredential;
}

function challenge(res: Response, resource: string, invalid: boolean): void {
  res.setHeader(
    'WWW-Authenticate',
    bearerChallenge(resource, invalid ? 'invalid_token' : undefined)
  );
  res.status(401).json({
    error: 'Unauthorized',
    message: invalid
      ? 'The access token is invalid, expired or not issued for this server.'
      : 'POST /message requires an OAuth access token; see the WWW-Authenticate header.',
  });
}

function unavailable(res: Response): void {
  res.status(503).json({
    error: 'Service Unavailable',
    message: 'The authorization server could not be reached. Try again shortly.',
  });
}

/**
 * Read and discard an unread request body before answering early, as Node does on its own.
 * Under Bun, a request answered after an await without its body read is never released.
 */
function discardBody(req: Request, limitBytes: number): Promise<void> {
  if (req.readableEnded || req.destroyed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let seen = 0;
    req.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > limitBytes) {
        req.destroy();
      }
    });
    req.once('end', () => resolve());
    req.once('close', () => resolve());
    req.once('error', () => resolve());
  });
}

/**
 * Authenticate a request as an OAuth resource server, then exchange the caller's token
 * for a BookStack credential (stored for bookstackCredential()). The inbound token goes
 * no further than the authorization server.
 */
export function requireOAuth(options: OAuthMiddlewareOptions): RequestHandler {
  const { verifier, exchanger, resource, logger, bodyLimitBytes } = options;

  return async (req, res, next) => {
    const token = req.headers.authorization?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
    if (token === undefined) {
      challenge(res, resource, false);
      return;
    }

    try {
      const auth = await verifier.verifyAccessToken(token);
      res.locals.bookstackCredential = await exchanger.exchange(auth);
    } catch (error) {
      await discardBody(req, bodyLimitBytes);
      if (error instanceof AccessTokenRejectedError) {
        logger.info('OAuth access token rejected', { type: error.reason });
        challenge(res, resource, true);
      } else if (error instanceof TokenExchangeError && error.kind === 'rejected') {
        logger.info('OAuth token exchange refused the access token', {
          status: error.status,
          oauth_error: error.oauthError,
        });
        challenge(res, resource, true);
      } else if (error instanceof TokenExchangeError && error.kind === 'forbidden') {
        logger.warn('OAuth token exchange denied for this user', {
          status: error.status,
          oauth_error: error.oauthError,
        });
        res.status(403).json({
          error: 'Forbidden',
          message: 'The authorization server does not allow BookStack access for this account.',
        });
      } else if (error instanceof TokenExchangeError && error.kind === 'misconfigured') {
        logger.error('OAuth token exchange is misconfigured', {
          status: error.status,
          oauth_error: error.oauthError,
        });
        res.status(500).json({
          error: 'Internal Server Error',
          message: 'This server could not obtain a BookStack token; see its logs.',
        });
      } else if (
        error instanceof TokenExchangeError ||
        error instanceof AuthServerUnavailableError
      ) {
        logger.warn('OAuth authorization server unavailable', { err: error });
        unavailable(res);
      } else {
        next(error);
      }
      return;
    }

    next();
  };
}
