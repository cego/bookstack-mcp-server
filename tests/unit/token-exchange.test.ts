import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { BookStackTokenExchanger, TokenExchangeError } from '../../src/auth/exchange';
import { OidcIssuer } from '../../src/auth/oidc';
import {
  ACCESS_TOKEN_TYPE,
  type IdpStub,
  startIdpStub,
  TOKEN_EXCHANGE_GRANT,
} from '../transport/stub-idp';

describe('BookStackTokenExchanger', () => {
  let idp: IdpStub;
  let counter = 0;

  function exchanger(overrides: { clientSecret?: string; maxEntries?: number } = {}) {
    return new BookStackTokenExchanger({
      issuer: new OidcIssuer(idp.issuer),
      clientId: idp.clientId,
      clientSecret: overrides.clientSecret ?? idp.clientSecret,
      audience: 'bookstack-api',
      ...(overrides.maxEntries === undefined ? {} : { maxEntries: overrides.maxEntries }),
    });
  }

  /** A verified inbound token as the middleware hands it over. */
  function inbound(expiresInSeconds = 300, subject = 'user-1'): AuthInfo {
    counter += 1;
    return {
      token: `inbound-token-${counter}`,
      clientId: 'bookstack-mcp',
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + expiresInSeconds,
      extra: { issuer: idp.issuer, subject },
    };
  }

  beforeAll(async () => {
    idp = await startIdpStub();
  });

  afterEach(() => {
    idp.exchangeOverride = undefined;
  });

  afterAll(async () => {
    await idp.stop();
  });

  it('exchanges the inbound token for the BookStack audience, as the configured client', async () => {
    const auth = inbound();

    const credential = await exchanger().exchange(auth);

    expect(credential).toEqual({
      scheme: 'Bearer',
      secret: idp.issued.at(-1) as string,
      principal: `${idp.issuer}\u0000user-1`,
    });
    const request = idp.exchanges.at(-1);
    expect(request?.authorization).toBe(`Basic ${btoa(`${idp.clientId}:${idp.clientSecret}`)}`);
    expect(request?.form).toEqual({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: auth.token,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      audience: 'bookstack-api',
    });
  });

  it('reuses an exchanged token for the same inbound token', async () => {
    const subject = exchanger();
    const auth = inbound();
    const before = idp.exchanges.length;

    const [first, second] = await Promise.all([subject.exchange(auth), subject.exchange(auth)]);
    const third = await subject.exchange(auth);

    expect(idp.exchanges.length - before).toBe(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('exchanges again for a different inbound token', async () => {
    const subject = exchanger();
    const before = idp.exchanges.length;

    await subject.exchange(inbound());
    await subject.exchange(inbound());

    expect(idp.exchanges.length - before).toBe(2);
  });

  it('reuses an exchanged token until shortly before it expires', async () => {
    const subject = exchanger();
    const auth = inbound(20);
    const before = idp.exchanges.length;

    await subject.exchange(auth);
    await subject.exchange(auth);

    expect(idp.exchanges.length - before).toBe(1);
  });

  it('does not reuse an exchanged token about to expire', async () => {
    const subject = exchanger();
    const auth = inbound();
    idp.exchangeOverride = { status: 200, body: { access_token: 'short-lived', expires_in: 20 } };
    const before = idp.exchanges.length;

    await subject.exchange(auth);
    await subject.exchange(auth);

    expect(idp.exchanges.length - before).toBe(2);
  });

  it('stays within its cache bound', async () => {
    const subject = exchanger({ maxEntries: 2 });
    const first = inbound();
    await subject.exchange(first);
    await subject.exchange(inbound());
    await subject.exchange(inbound());
    const before = idp.exchanges.length;

    await subject.exchange(first);

    expect(idp.exchanges.length - before).toBe(1);
  });

  it.each([
    ['invalid_grant', 400, 'rejected'],
    ['invalid_token', 401, 'rejected'],
    ['invalid_client', 401, 'misconfigured'],
    ['unauthorized_client', 400, 'misconfigured'],
    ['access_denied', 403, 'forbidden'],
    ['server_error', 500, 'unavailable'],
    ['too_many_requests', 429, 'unavailable'],
  ] as const)('classifies %s (%i) as %s', async (code, status, kind) => {
    idp.exchangeOverride = { status, body: { error: code, error_description: 'detail' } };

    const failure = await exchanger()
      .exchange(inbound())
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TokenExchangeError);
    expect((failure as TokenExchangeError).kind).toBe(kind);
  });

  it('classifies a non-JSON gateway failure as unavailable', async () => {
    idp.exchangeOverride = 'drop';

    const failure = await exchanger()
      .exchange(inbound())
      .catch((error: unknown) => error);

    expect((failure as TokenExchangeError).kind).toBe('unavailable');
  });

  it('classifies a success without an access token as unavailable', async () => {
    idp.exchangeOverride = { status: 200, body: { token_type: 'Bearer' } };

    const failure = await exchanger()
      .exchange(inbound())
      .catch((error: unknown) => error);

    expect((failure as TokenExchangeError).kind).toBe('unavailable');
  });

  it('does not cache a failed exchange', async () => {
    const subject = exchanger();
    const auth = inbound();
    idp.exchangeOverride = { status: 500, body: { error: 'server_error' } };
    await subject.exchange(auth).catch(() => undefined);
    idp.exchangeOverride = undefined;

    await expect(subject.exchange(auth)).resolves.toMatchObject({ scheme: 'Bearer' });
  });

  it('does not follow a redirect with the subject token and client secret', async () => {
    idp.exchangeOverride = {
      status: 307,
      body: {},
      headers: { location: `${idp.issuer}/sink` },
    };

    const failure = await exchanger()
      .exchange(inbound())
      .catch((error: unknown) => error);

    expect((failure as TokenExchangeError).kind).toBe('unavailable');
    expect(idp.sinkHits).toBe(0);
  });

  it('reports a wrong client secret as misconfiguration', async () => {
    const failure = await exchanger({ clientSecret: 'wrong' })
      .exchange(inbound())
      .catch((error: unknown) => error);

    expect((failure as TokenExchangeError).kind).toBe('misconfigured');
  });
});
