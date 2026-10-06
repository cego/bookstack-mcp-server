import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { SignJWT } from 'jose';
import { AuthServerUnavailableError, OidcIssuer } from '../../src/auth/oidc';
import { AccessTokenRejectedError, JwtAccessTokenVerifier } from '../../src/auth/verifier';
import { type IdpStub, startIdpStub } from '../transport/stub-idp';

const RESOURCE = 'http://127.0.0.1:3000/message';

describe('JwtAccessTokenVerifier', () => {
  let idp: IdpStub;
  let verifier: JwtAccessTokenVerifier;

  /** Claims of a token the issuer would give an MCP client (`bookstack-mcp`) for this server. */
  function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: idp.issuer,
      aud: [RESOURCE, 'bookstack-mcp-server'],
      azp: 'bookstack-mcp',
      sub: 'user-1',
      scope: 'openid profile email',
      typ: 'Bearer',
      iat: now,
      exp: now + 300,
      ...overrides,
    };
  }

  beforeAll(async () => {
    idp = await startIdpStub();
    verifier = new JwtAccessTokenVerifier({
      issuer: new OidcIssuer(idp.issuer),
      resource: RESOURCE,
    });
  });

  afterAll(async () => {
    await idp.stop();
  });

  it('accepts a token issued for this resource and describes it', async () => {
    const token = await idp.mint(claims());

    const auth = await verifier.verifyAccessToken(token);

    expect(auth.token).toBe(token);
    expect(auth.clientId).toBe('bookstack-mcp');
    expect(auth.scopes).toEqual(['openid', 'profile', 'email']);
    expect(auth.resource?.href).toBe(RESOURCE);
    expect(auth.extra).toEqual({ issuer: idp.issuer, subject: 'user-1' });
    expect(typeof auth.expiresAt).toBe('number');
  });

  it('accepts the resource with a trailing slash in the audience', async () => {
    const token = await idp.mint(claims({ aud: `${RESOURCE}/` }));

    await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
      clientId: 'bookstack-mcp',
    });
  });

  it.each([
    ['another audience only', { aud: ['bookstack-api', 'bookstack-mcp-server'] }],
    ['an ID token for the client', { aud: 'bookstack-mcp', typ: 'ID' }],
    ['an ID token carrying this resource as audience', { typ: 'ID' }],
    ['a refresh token carrying this resource as audience', { typ: 'Refresh' }],
    ['another issuer', { iss: 'https://evil.example/issuer' }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 600 }],
    ['a token without a subject', { sub: undefined }],
    ['a token without an expiry', { exp: undefined }],
  ])('rejects %s', async (_label, overrides) => {
    const token = await idp.mint(claims(overrides));

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(
      AccessTokenRejectedError
    );
  });

  it('rejects a token signed by a key the issuer does not publish', async () => {
    const token = await idp.mint(claims(), { untrusted: true });

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(
      AccessTokenRejectedError
    );
  });

  it('rejects a symmetric (HS256) token', async () => {
    const token = await new SignJWT(claims())
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('a-guessable-shared-secret-of-32-bytes!'));

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(
      AccessTokenRejectedError
    );
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims())}.`;

    await expect(verifier.verifyAccessToken(token)).rejects.toBeInstanceOf(
      AccessTokenRejectedError
    );
  });

  it('rejects a string that is not a JWT', async () => {
    await expect(verifier.verifyAccessToken('not-a-jwt')).rejects.toBeInstanceOf(
      AccessTokenRejectedError
    );
  });

  it('reports an unreachable issuer as unavailable, not as a bad token', async () => {
    const offline = new JwtAccessTokenVerifier({
      issuer: new OidcIssuer('http://127.0.0.1:9/issuer'),
      resource: RESOURCE,
    });

    await expect(offline.verifyAccessToken(await idp.mint(claims()))).rejects.toBeInstanceOf(
      AuthServerUnavailableError
    );
  });

  it('accepts a token without a typ claim', async () => {
    const token = await idp.mint(claims({ typ: undefined }));

    await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
      clientId: 'bookstack-mcp',
    });
  });

  it('probes discovery afresh even after it was cached', async () => {
    const issuer = new OidcIssuer(idp.issuer);
    await issuer.metadata();
    idp.discoveryDown = true;

    try {
      await expect(issuer.metadata()).resolves.toMatchObject({ issuer: idp.issuer });
      await expect(issuer.probe()).rejects.toBeInstanceOf(AuthServerUnavailableError);
    } finally {
      idp.discoveryDown = false;
    }
  });

  it('refuses discovery that names a different issuer', async () => {
    const lying = new OidcIssuer(`${idp.issuer}/`);

    await expect(lying.metadata()).rejects.toBeInstanceOf(AuthServerUnavailableError);
  });
});
