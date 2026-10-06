/**
 * BookStackClient never follows a redirect.
 *
 * Every request carries the BookStack credential, and a redirect hands the next hop to whoever
 * answered: a 3xx from an upstream, or from a proxy in front of it, would otherwise send this
 * server to a host nobody configured. Exports go through the same axios instance, so both the
 * JSON and the export path are driven here against two real local servers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { ErrorHandler } from '../../src/utils/errors';
import type { Logger } from '../../src/utils/logger';
import { resetSharedRateLimiters } from '../../src/utils/rateLimit';

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

interface RecordingServer {
  url: string;
  paths: string[];
  stop(): void;
}

function startServer(answer: (path: string) => Response): RecordingServer {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request: Request): Response {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return answer(path);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    paths,
    stop: () => server.stop(true),
  };
}

describe('BookStackClient redirects', () => {
  let elsewhere: RecordingServer;
  let upstream: RecordingServer;
  let client: BookStackClient;

  beforeAll(() => {
    elsewhere = startServer(() => Response.json({ version: 'elsewhere' }));
    upstream = startServer(
      (path) =>
        new Response(null, { status: 302, headers: { location: `${elsewhere.url}${path}` } })
    );

    const config: Config = {
      bookstack: {
        baseUrl: `${upstream.url}/api`,
        apiToken: 'redirect-test-id:redirect-test-secret',
        timeout: 5_000,
      },
      server: { name: 'bookstack-mcp-server-redirect-test', version: '1.0.0', port: 3000 },
      rateLimit: { requestsPerMinute: 60_000, burstLimit: 10_000 },
      validation: { enabled: true, strictMode: true },
      logging: { level: 'error', format: 'pretty' },
    };
    client = new BookStackClient(config, noopLogger, new ErrorHandler(noopLogger));
  });

  beforeEach(() => {
    upstream.paths.length = 0;
    elsewhere.paths.length = 0;
  });

  afterAll(() => {
    upstream.stop();
    elsewhere.stop();
    resetSharedRateLimiters();
  });

  it('fails a JSON call answered with a 302 instead of following it', async () => {
    await expect(client.getSystemInfo()).rejects.toThrow();

    expect(upstream.paths).toEqual(['/api/system']);
    expect(elsewhere.paths).toEqual([]);
  });

  it('fails an export answered with a 302 instead of following it', async () => {
    await expect(client.exportPage(1, 'markdown')).rejects.toThrow();

    expect(upstream.paths).toEqual(['/api/pages/1/export/markdown']);
    expect(elsewhere.paths).toEqual([]);
  });
});
