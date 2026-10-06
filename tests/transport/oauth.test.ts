/**
 * OAuth mode of the HTTP transport, end to end: the real Express app between a signing
 * OIDC provider stub and the BookStack stub.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type Config,
  ConfigManager,
  DEFAULT_HTTP_BODY_LIMIT_BYTES,
  type HttpTransportConfig,
} from '../../src/config/manager';
import { createHttpApp } from '../../src/server';
import { resetSharedRateLimiters } from '../../src/utils/rateLimit';
import { type BookStackStub, startBookStackStub } from './stub-bookstack';
import { type IdpStub, startIdpStub } from './stub-idp';

const RESOURCE = 'https://bookstack-mcp.test/message';
const METADATA_URL = 'https://bookstack-mcp.test/.well-known/oauth-protected-resource/message';
const PINNED_ENV = [
  'BOOKSTACK_BASE_URL',
  'BOOKSTACK_API_TOKEN',
  'BOOKSTACK_UPLOAD_ROOT',
  'LOG_LEVEL',
  'LOG_FORMAT',
] as const;

const savedEnv = new Map<string, string | undefined>();
const running: Server[] = [];
let idp: IdpStub;
let bookstack: BookStackStub;
let config: Config;

beforeAll(async () => {
  for (const key of PINNED_ENV) {
    savedEnv.set(key, process.env[key]);
  }
  bookstack = startBookStackStub();
  idp = await startIdpStub({ onIssue: (token) => bookstack.acceptedBearerTokens.add(token) });

  process.env.BOOKSTACK_BASE_URL = bookstack.baseUrl;
  delete process.env.BOOKSTACK_API_TOKEN;
  process.env.LOG_LEVEL = 'debug';
  process.env.LOG_FORMAT = 'json';
  config = ConfigManager.getInstance().reload();
});

afterEach(async () => {
  idp.exchangeOverride = undefined;
  idp.discoveryDown = false;
  resetSharedRateLimiters();
  await Promise.all(
    running.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

afterAll(async () => {
  for (const key of PINNED_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  ConfigManager.resetInstance();
  await idp.stop();
  await bookstack.stop();
});

function oauthHttp(): HttpTransportConfig {
  return {
    bodyLimitBytes: DEFAULT_HTTP_BODY_LIMIT_BYTES,
    oauth: {
      issuer: idp.issuer,
      resource: RESOURCE,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      bookstackAudience: 'bookstack-api',
    },
  };
}

async function startApp(appConfig: Config = config): Promise<string> {
  const app = createHttpApp({ config: appConfig, http: oauthHttp() });
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  running.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A token the issuer would give an MCP client (`bookstack-mcp`) for this server. */
async function userToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return idp.mint({
    iss: idp.issuer,
    aud: [RESOURCE, 'bookstack-mcp-server'],
    azp: 'bookstack-mcp',
    sub: 'user-1',
    iat: now,
    exp: now + 300,
    ...overrides,
  });
}

const LIST_BOOKS = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'bookstack_books_list', arguments: {} },
});

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'oauth-test', version: '1.0.0' },
  },
});

function postMessage(
  url: string,
  body: string,
  token?: string,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return fetch(`${url}/message`, { method: 'POST', headers, body });
}

describe('OAuth mode startup', () => {
  it('refuses to start with BOOKSTACK_API_TOKEN configured', () => {
    const withToken = { ...config, bookstack: { ...config.bookstack, apiToken: 'id:secret' } };

    expect(() => createHttpApp({ config: withToken, http: oauthHttp() })).toThrow(
      /BOOKSTACK_API_TOKEN/
    );
  });
});

describe('OAuth mode upload root', () => {
  it('refuses BOOKSTACK_UPLOAD_ROOT, which every user could read from', () => {
    process.env.BOOKSTACK_UPLOAD_ROOT = '/tmp';
    try {
      expect(() => createHttpApp({ config, http: oauthHttp() })).toThrow(/BOOKSTACK_UPLOAD_ROOT/);
    } finally {
      delete process.env.BOOKSTACK_UPLOAD_ROOT;
    }
  });
});

describe('OAuth discovery', () => {
  it('serves protected resource metadata naming the issuer', async () => {
    const url = await startApp();

    const response = await fetch(`${url}/.well-known/oauth-protected-resource/message`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: RESOURCE,
      authorization_servers: [idp.issuer],
      bearer_methods_supported: ['header'],
    });
  });

  it('challenges a request without a token with the metadata location', async () => {
    const url = await startApp();

    const response = await postMessage(url, INITIALIZE);

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}"`
    );
  });
});

describe('OAuth token validation', () => {
  it.each([
    ['a token for BookStack rather than this server', { aud: ['bookstack-api'] }],
    ['an expired token', { exp: Math.floor(Date.now() / 1000) - 600 }],
    ['a token from another issuer', { iss: 'https://evil.example/issuer' }],
  ])('rejects %s with invalid_token and never exchanges it', async (_label, overrides) => {
    const url = await startApp();
    const before = idp.exchanges.length;

    const response = await postMessage(url, LIST_BOOKS, await userToken(overrides));

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="${METADATA_URL}"`
    );
    expect(idp.exchanges.length).toBe(before);
  });

  it('rejects an opaque shared secret', async () => {
    const url = await startApp();

    const response = await postMessage(url, LIST_BOOKS, 'test-inbound-secret-0123456789');

    expect(response.status).toBe(401);
  });

  it('answers MCP initialize for a valid token', async () => {
    const url = await startApp();

    const response = await postMessage(url, INITIALIZE, await userToken());

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(payload.result?.serverInfo?.name).toBe(config.server.name);
  });
});

describe('OAuth calls to BookStack', () => {
  it('calls BookStack with an exchanged token, never the inbound one', async () => {
    const url = await startApp();
    const token = await userToken();
    const before = bookstack.requests.length;

    const response = await postMessage(url, LIST_BOOKS, token);

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: { isError?: boolean } };
    expect(payload.result?.isError).toBeUndefined();
    const sent = bookstack.requests.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.authorization).toBe(`Bearer ${idp.issued.at(-1)}`);
      expect(request.authorization).not.toContain(token);
    }
  });

  it('exchanges once per inbound token', async () => {
    const url = await startApp();
    const token = await userToken({ sub: 'user-2' });
    const before = idp.exchanges.length;

    await postMessage(url, LIST_BOOKS, token);
    await postMessage(url, LIST_BOOKS, token);

    expect(idp.exchanges.length - before).toBe(1);
  });

  it('asks the client to re-authenticate when the exchange is refused', async () => {
    const url = await startApp();
    idp.exchangeOverride = { status: 400, body: { error: 'invalid_grant' } };
    const before = bookstack.requests.length;

    const response = await postMessage(url, LIST_BOOKS, await userToken());

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(bookstack.requests.length).toBe(before);
  });

  it('answers 403 when the authorization server denies this user the exchange', async () => {
    const url = await startApp();
    idp.exchangeOverride = { status: 403, body: { error: 'access_denied' } };

    const response = await postMessage(url, LIST_BOOKS, await userToken());

    expect(response.status).toBe(403);
  });

  it('answers 500 when this server cannot exchange tokens', async () => {
    const url = await startApp();
    idp.exchangeOverride = { status: 401, body: { error: 'invalid_client' } };

    const response = await postMessage(url, LIST_BOOKS, await userToken());

    expect(response.status).toBe(500);
  });

  it('answers 503 when the token endpoint is down', async () => {
    const url = await startApp();
    idp.exchangeOverride = 'drop';

    const response = await postMessage(url, LIST_BOOKS, await userToken());

    expect(response.status).toBe(503);
  });

  it('answers 503 when discovery is down', async () => {
    const url = await startApp();
    idp.discoveryDown = true;

    const response = await postMessage(url, LIST_BOOKS, await userToken());

    expect(response.status).toBe(503);
  });

  it.each([
    ['x-bookstack-url', 'https://attacker.example/api'],
    ['x-bookstack-token', 'other-id:other-secret'],
  ])('refuses the %s override before spending a token', async (header, value) => {
    const url = await startApp();
    const exchangesBefore = idp.exchanges.length;
    const requestsBefore = bookstack.requests.length;

    const response = await postMessage(url, LIST_BOOKS, await userToken(), { [header]: value });

    expect(response.status).toBe(400);
    expect(idp.exchanges.length).toBe(exchangesBefore);
    expect(bookstack.requests.length).toBe(requestsBefore);
  });
});

describe('OAuth readiness', () => {
  it('reports the authorization server and BookStack as reachable', async () => {
    const url = await startApp();

    const response = await fetch(`${url}/health`);
    const body = (await response.json()) as {
      status: string;
      checks: Array<{ name: string; healthy: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.checks.map((check) => check.name).sort()).toEqual([
      'authorization_server',
      'bookstack_reachable',
    ]);
  });

  it('reports unhealthy when the authorization server is down', async () => {
    idp.discoveryDown = true;
    const url = await startApp();

    const response = await fetch(`${url}/health`);

    expect(response.status).toBe(503);
  });
});

describe('OAuth secrets stay out of logs', () => {
  it('never writes inbound tokens, exchanged tokens or the client secret', async () => {
    const url = await startApp();
    const valid = await userToken({ sub: 'user-log' });
    const foreign = await userToken({ aud: 'bookstack-api' });
    let output = '';
    const realStdout = process.stdout.write;
    const realStderr = process.stderr.write;
    const record = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      for (const arg of rest) {
        if (typeof arg === 'function') {
          (arg as () => void)();
        }
      }
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = record;
    process.stderr.write = record;

    try {
      await postMessage(url, LIST_BOOKS, valid);
      await postMessage(url, LIST_BOOKS, foreign);
      idp.exchangeOverride = { status: 400, body: { error: 'invalid_grant' } };
      await postMessage(url, LIST_BOOKS, await userToken({ sub: 'user-log-2' }));
      idp.exchangeOverride = { status: 401, body: { error: 'invalid_client' } };
      await postMessage(url, LIST_BOOKS, await userToken({ sub: 'user-log-3' }));
    } finally {
      process.stdout.write = realStdout;
      process.stderr.write = realStderr;
    }

    expect(output.length).toBeGreaterThan(0);
    for (const secret of [valid, foreign, idp.clientSecret, ...idp.issued]) {
      expect(output).not.toContain(secret);
    }
  });
});
