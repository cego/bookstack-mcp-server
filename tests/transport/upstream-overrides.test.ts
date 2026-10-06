/**
 * Transport tests: the per-request `x-bookstack-url` / `x-bookstack-token` overrides.
 *
 * `x-bookstack-url` decides which host this server calls on the caller's behalf, so it is
 * the server's outbound-request surface. Two BookStack stubs stand in for the configured
 * instance and for a second one, and every assertion reads what each stub actually received:
 * a refusal has to happen before any BookStack call, and the configured BOOKSTACK_API_TOKEN
 * must never reach a host the caller chose.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Config, ConfigManager } from '../../src/config/manager';
import { createHttpApp } from '../../src/server';
import { resetSharedRateLimiters } from '../../src/utils/rateLimit';
import { type BookStackStub, STUB_BOOKS, startBookStackStub } from './stub-bookstack';

const TEST_AUTH_TOKEN = 'overrides-inbound-secret-0123456789';
const BODY_LIMIT_BYTES = 1024 * 1024;
/** Deliberately not a token either stub accepts, so it is recognisable wherever it lands. */
const CONFIGURED_TOKEN = 'configured-id:configured-secret';

const PINNED_ENV = [
  'BOOKSTACK_BASE_URL',
  'BOOKSTACK_API_TOKEN',
  'LOG_LEVEL',
  'LOG_FORMAT',
] as const;
const savedEnv = new Map<string, string | undefined>();

let config: Config;
/** The BookStack this server is configured for. */
let configured: BookStackStub;
/** A second BookStack, reachable only by naming it in x-bookstack-url. */
let other: BookStackStub;

beforeAll(() => {
  for (const key of PINNED_ENV) {
    savedEnv.set(key, process.env[key]);
  }
  configured = startBookStackStub();
  other = startBookStackStub();

  process.env.BOOKSTACK_BASE_URL = configured.baseUrl;
  process.env.BOOKSTACK_API_TOKEN = CONFIGURED_TOKEN;
  process.env.LOG_LEVEL = 'error';
  process.env.LOG_FORMAT = 'json';
  config = ConfigManager.getInstance().reload();
});

afterAll(async () => {
  await configured.stop();
  await other.stop();
  for (const key of PINNED_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  ConfigManager.resetInstance();
  resetSharedRateLimiters();
});

const running: Server[] = [];

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  configured.requests.length = 0;
  other.requests.length = 0;
});

async function startApp(allowedBaseUrls?: string[]): Promise<string> {
  const app = createHttpApp({
    config,
    http: {
      bodyLimitBytes: BODY_LIMIT_BYTES,
      authToken: TEST_AUTH_TOKEN,
      ...(allowedBaseUrls ? { allowedBaseUrls } : {}),
    },
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  running.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A books list call, which reaches BookStack whenever it is dispatched at all. */
async function listBooks(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${url}/message`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TEST_AUTH_TOKEN}`,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'bookstack_books_list', arguments: { count: 1 } },
    }),
  });
}

/** A 400 with the transport's JSON error shape, that does not repeat what it refused. */
async function expectRefusal(response: Response, unechoed: string[]): Promise<string> {
  expect(response.status).toBe(400);
  expect(response.headers.get('content-type')).toContain('application/json');
  const text = await response.text();
  for (const value of unechoed) {
    expect(text).not.toContain(value);
  }
  const payload = JSON.parse(text) as { error?: string; message?: string };
  expect(payload.error).toBe('Bad Request');
  return payload.message ?? '';
}

describe('x-bookstack-url', () => {
  it('is refused when BOOKSTACK_ALLOWED_BASE_URLS is unset', async () => {
    const url = await startApp();

    const response = await listBooks(url, {
      'x-bookstack-url': other.baseUrl,
      'x-bookstack-token': other.apiToken,
    });

    const message = await expectRefusal(response, [other.baseUrl, other.apiToken]);
    expect(message).toContain('BOOKSTACK_ALLOWED_BASE_URLS');
    expect(configured.requests).toEqual([]);
    expect(other.requests).toEqual([]);
  });

  it('is refused when it names a URL that is not on the list', async () => {
    const url = await startApp([configured.baseUrl]);

    for (const named of [
      other.baseUrl,
      'https://books.example/api?api_token=override-leak-marker',
    ]) {
      const response = await listBooks(url, {
        'x-bookstack-url': named,
        'x-bookstack-token': other.apiToken,
      });

      await expectRefusal(response, [named, 'override-leak-marker', other.apiToken]);
    }
    expect(configured.requests).toEqual([]);
    expect(other.requests).toEqual([]);
  });

  it('is refused without x-bookstack-token, so the configured token stays home', async () => {
    const url = await startApp([other.baseUrl]);

    const response = await listBooks(url, { 'x-bookstack-url': other.baseUrl });

    const message = await expectRefusal(response, [other.baseUrl, CONFIGURED_TOKEN]);
    expect(message).toContain('x-bookstack-token');
    expect(configured.requests).toEqual([]);
    expect(other.requests).toEqual([]);
  });

  it('calls an allowed URL with the caller token, matching it canonically', async () => {
    // Trailing slash and upper-case scheme: the same upstream, spelled two other ways.
    const url = await startApp([`${other.baseUrl}/`]);

    const response = await listBooks(url, {
      'x-bookstack-url': other.baseUrl.replace('http://', 'HTTP://'),
      'x-bookstack-token': other.apiToken,
    });

    expect(response.status).toBe(200);
    const reply = (await response.json()) as {
      result?: { content?: Array<{ text: string }> };
      error?: unknown;
    };
    expect(reply.error).toBeUndefined();
    const books = JSON.parse(reply.result?.content?.[0]?.text ?? '{}') as {
      data?: Array<{ name: string }>;
    };
    expect(books.data?.map((book) => book.name)).toEqual([STUB_BOOKS[0].name]);

    expect(other.requests.map((request) => [request.path, request.authorization])).toEqual([
      ['/books', `Token ${other.apiToken}`],
    ]);
    expect(configured.requests).toEqual([]);
  });
});

describe('x-bookstack-token alone', () => {
  it('is still spent against the configured BOOKSTACK_BASE_URL, with no allowlist needed', async () => {
    const url = await startApp();

    await listBooks(url, { 'x-bookstack-token': 'caller-id:caller-secret' });

    expect(configured.requests.map((request) => [request.path, request.authorization])).toEqual([
      ['/books', 'Token caller-id:caller-secret'],
    ]);
    expect(other.requests).toEqual([]);
  });
});
