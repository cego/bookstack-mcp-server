/**
 * Connection-level failures and timeouts in `BookStackClient` (src/api/client.ts) and how
 * `ErrorHandler` (src/utils/errors.ts) reports them.
 *
 * Same approach as tests/unit/retry.test.ts: a real local server, the real axios stack and
 * the real ErrorHandler, with `globalThis.setTimeout` replaced so every retry wait is
 * recorded and served instantly. The server here is raw TCP rather than `Bun.serve`,
 * because the failures under test - a connection dropped before any response - are below
 * what an HTTP handler can express. Each response closes its connection, so every attempt
 * arrives on a fresh socket and is counted exactly once.
 *
 * The timeout tests run on real timers: an instantly-firing clock would abort every request.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createServer, type Server, type Socket } from 'node:net';
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { ErrorHandler } from '../../src/utils/errors';
import type { Logger } from '../../src/utils/logger';
import { resetSharedRateLimiters } from '../../src/utils/rateLimit';

/** The retry policy's own constants, mirrored here so the bounds can be asserted. */
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;
const JITTER_RATIO = 0.25;

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

/** What the stub does with one request: drop the connection, answer 200, or never answer. */
type Step = 'drop' | 'ok' | 'hang';

interface TcpStub {
  port: number;
  baseUrl: string;
  /** The request line of every attempt that arrived, in order. */
  requests: string[];
  plan: Step[];
  fallback: Step;
  reset(): void;
  stop(): Promise<void>;
}

const OK_BODY = JSON.stringify({ data: [], total: 0 });

async function startTcpStub(): Promise<TcpStub> {
  const sockets = new Set<Socket>();
  const requests: string[] = [];

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    let head = '';
    let handled = false;
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      handled = true;

      requests.push(head.split('\r\n')[0] ?? '');
      const step = stub.plan[requests.length - 1] ?? stub.fallback;
      if (step === 'drop') {
        socket.destroy();
      } else if (step === 'ok') {
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(OK_BODY)}\r\nConnection: close\r\n\r\n${OK_BODY}`
        );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port');

  const stub: TcpStub = {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}/api`,
    requests,
    plan: [],
    fallback: 'ok',
    reset() {
      requests.length = 0;
      stub.plan = [];
      stub.fallback = 'ok';
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return stub;
}

/** A port nothing listens on: bound, read, released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function configFor(baseUrl: string, timeout: number, token: string): Config {
  return {
    bookstack: { baseUrl, apiToken: token, timeout },
    server: { name: 'bookstack-mcp-server-transport-test', version: '1.0.0', port: 3000 },
    rateLimit: { requestsPerMinute: 60_000, burstLimit: 10_000 },
    validation: { enabled: true, strictMode: true },
    logging: { level: 'error', format: 'pretty' },
  };
}

/** The private retry loop, for HEAD and OPTIONS, which no public method issues. */
interface RetryDriver {
  requestWithRetry<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>>;
}

/** Settle a promise into its rejection, failing if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`Expected a rejection, got ${JSON.stringify(value)}`);
    },
    (caught: unknown) => caught
  );
}

const realSetTimeout = globalThis.setTimeout;
const waits: number[] = [];

describe('connection failures', () => {
  let stub: TcpStub;
  let client: BookStackClient;
  let driver: RetryDriver;

  beforeAll(async () => {
    stub = await startTcpStub();
    client = new BookStackClient(
      configFor(stub.baseUrl, 0, 'transport-test-id:transport-test-secret'),
      noopLogger,
      new ErrorHandler(noopLogger)
    );
    driver = client as unknown as RetryDriver;

    globalThis.setTimeout = ((
      handler: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      // Retry waits are at least 250 ms; shorter timers belong to the runtime.
      if (typeof ms === 'number' && ms >= 250) {
        waits.push(ms);
      }
      return realSetTimeout(handler, 0, ...args);
    }) as typeof setTimeout;
  });

  afterAll(async () => {
    globalThis.setTimeout = realSetTimeout;
    await stub.stop();
    resetSharedRateLimiters();
  });

  beforeEach(() => {
    stub.reset();
    waits.length = 0;
  });

  it('retries a GET whose connection dropped and returns the eventual success', async () => {
    stub.plan = ['drop', 'ok'];

    const result = await client.listBooks();

    expect(stub.requests).toHaveLength(2);
    expect(result).toEqual({ data: [], total: 0 });
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(BASE_DELAY_MS);
    expect(waits[0]).toBeLessThanOrEqual(Math.round(BASE_DELAY_MS * (1 + JITTER_RATIO)));
  });

  for (const method of ['HEAD', 'OPTIONS']) {
    it(`retries ${method} whose connection dropped`, async () => {
      stub.plan = ['drop', 'ok'];

      const response = await driver.requestWithRetry<unknown>({ method, url: '/books' });

      expect(response.status).toBe(200);
      expect(stub.requests.map((line) => line.split(' ')[0])).toEqual([method, method]);
    });
  }

  it('gives up after the attempt cap and reports network_error', async () => {
    stub.fallback = 'drop';

    const error = await rejectionOf(client.listBooks());

    expect(stub.requests).toHaveLength(MAX_ATTEMPTS);
    expect(waits).toHaveLength(MAX_ATTEMPTS - 1);
    expect(String(error)).toContain('BookStack could not be reached');
  });

  const writes: { verb: string; call: () => Promise<unknown> }[] = [
    { verb: 'POST', call: () => client.createBook({ name: 'must not be duplicated' }) },
    { verb: 'PUT', call: () => client.updateBook(5, { name: 'must not be replayed' }) },
    { verb: 'DELETE', call: () => client.deleteBook(5) },
  ];

  for (const { verb, call } of writes) {
    it(`does NOT retry ${verb} whose connection dropped`, async () => {
      stub.plan = ['drop'];
      stub.fallback = 'ok';

      const error = await rejectionOf(call());

      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.split(' ')[0]).toBe(verb);
      expect(waits).toEqual([]);
      expect(String(error)).toContain('BookStack could not be reached');
    });
  }

  it('retries a refused GET within the budget, then reports it without the address', async () => {
    const port = await closedPort();
    const refused = new BookStackClient(
      configFor(`http://127.0.0.1:${port}/api`, 0, 'refused-id:refused-secret'),
      noopLogger,
      new ErrorHandler(noopLogger)
    );

    const error = await rejectionOf(refused.listBooks());

    expect(waits).toHaveLength(MAX_ATTEMPTS - 1);
    const text = new ErrorHandler(noopLogger).toToolErrorResult(error).content[0]?.text ?? '';
    expect(text).toContain('BookStack could not be reached');
    expect(text).toContain('"type": "network_error"');
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain(String(port));
    expect(text).not.toContain('ECONNREFUSED');
  });

  it('does not retry a refused POST', async () => {
    const port = await closedPort();
    const refused = new BookStackClient(
      configFor(`http://127.0.0.1:${port}/api`, 0, 'refused-post-id:refused-post-secret'),
      noopLogger,
      new ErrorHandler(noopLogger)
    );

    await expect(refused.createBook({ name: 'x' })).rejects.toThrow(
      'BookStack could not be reached'
    );
    expect(waits).toEqual([]);
  });
});

describe('timeouts', () => {
  const TIMEOUT_MS = 150;
  let stub: TcpStub;

  beforeAll(async () => {
    stub = await startTcpStub();
  });

  afterAll(async () => {
    await stub.stop();
    resetSharedRateLimiters();
  });

  afterEach(() => {
    stub.reset();
  });

  it('does not retry a timed-out GET and names the configured timeout', async () => {
    stub.fallback = 'hang';
    const client = new BookStackClient(
      configFor(stub.baseUrl, TIMEOUT_MS, 'timeout-id:timeout-secret'),
      noopLogger,
      new ErrorHandler(noopLogger)
    );

    const error = await rejectionOf(client.listBooks());

    expect(stub.requests).toHaveLength(1);
    const text = new ErrorHandler(noopLogger).toToolErrorResult(error).content[0]?.text ?? '';
    expect(text).toContain(`BookStack did not respond within ${TIMEOUT_MS} ms`);
    expect(text).toContain('"type": "timeout_error"');
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain(String(stub.port));
  });
});

describe('ErrorHandler on transport failures', () => {
  const handler = new ErrorHandler(noopLogger);

  /** An AxiosError as the http adapter raises it: a request went out, nothing came back. */
  function noResponse(code: string | undefined, message: string, timeout = 30_000): unknown {
    return {
      isAxiosError: true,
      code,
      message,
      request: {},
      config: { method: 'get', url: '/books', timeout },
    };
  }

  const connectionFailures: { label: string; error: unknown }[] = [
    {
      label: 'ECONNREFUSED',
      error: noResponse('ECONNREFUSED', 'connect ECONNREFUSED 10.9.8.7:6875'),
    },
    { label: 'ECONNRESET', error: noResponse('ECONNRESET', 'read ECONNRESET') },
    { label: 'EPIPE', error: noResponse('EPIPE', 'write EPIPE') },
    {
      label: 'ERR_SOCKET_CONNECTION_TIMEOUT',
      error: noResponse('ERR_SOCKET_CONNECTION_TIMEOUT', 'Socket connection timeout'),
    },
    { label: 'socket hang up, no code', error: noResponse(undefined, 'socket hang up') },
    {
      label: 'no response, unknown code',
      error: noResponse('EHOSTUNREACH', 'connect EHOSTUNREACH'),
    },
  ];

  for (const { label, error } of connectionFailures) {
    it(`maps ${label} to network_error and calls it retryable`, () => {
      const mapped = handler.handleError(error);

      expect(mapped.message).toContain('BookStack could not be reached');
      expect((mapped.data as { type?: string }).type).toBe('network_error');
      expect(mapped.message).not.toContain('10.9.8.7');
      expect(handler.isRetryable(error)).toBe(true);
      expect(handler.isRetryable(mapped)).toBe(true);
    });
  }

  for (const code of ['ECONNABORTED', 'ETIMEDOUT']) {
    it(`maps ${code} to timeout_error with the configured timeout and never retries it`, () => {
      const error = noResponse(code, 'timeout of 12000ms exceeded', 12_000);
      const mapped = handler.handleError(error);

      expect(mapped.message).toContain('BookStack did not respond within 12000 ms');
      expect((mapped.data as { type?: string }).type).toBe('timeout_error');
      expect(handler.isRetryable(error)).toBe(false);
      expect(handler.isRetryable(mapped)).toBe(false);
    });
  }

  it('does not treat a cancelled request as a network failure', () => {
    const error = noResponse('ERR_CANCELED', 'canceled');

    expect(handler.isRetryable(error)).toBe(false);
    expect((handler.handleError(error).data as { type?: string }).type).not.toBe('network_error');
  });
});

describe('connection pooling', () => {
  it('shares one keep-alive agent per protocol across clients, keeping the per-client timeout', () => {
    const make = (timeout: number, token: string): AxiosInstance =>
      (
        new BookStackClient(
          configFor('http://127.0.0.1:9/api', timeout, token),
          noopLogger,
          new ErrorHandler(noopLogger)
        ) as unknown as { client: AxiosInstance }
      ).client;

    const first = make(1_000, 'pool-a-id:pool-a-secret');
    const second = make(2_000, 'pool-b-id:pool-b-secret');
    resetSharedRateLimiters();

    expect(first.defaults.httpAgent).toBeDefined();
    expect(first.defaults.httpsAgent).toBeDefined();
    expect(second.defaults.httpAgent).toBe(first.defaults.httpAgent);
    expect(second.defaults.httpsAgent).toBe(first.defaults.httpsAgent);
    expect(first.defaults.httpAgent.keepAlive).toBe(true);
    expect(first.defaults.httpsAgent.keepAlive).toBe(true);
    expect(first.defaults.timeout).toBe(1_000);
    expect(second.defaults.timeout).toBe(2_000);
  });
});
