import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { type BookStackStub, startBookStackStub } from '../transport/stub-bookstack';

const logger = Logger.getInstance();

function configFor(stub: BookStackStub, apiToken?: string): Config {
  return {
    bookstack: { baseUrl: stub.baseUrl, apiToken, timeout: 5_000 },
    server: { name: 'credential-test', version: '1.0.0', port: 3000 },
    rateLimit: { requestsPerMinute: 60_000, burstLimit: 10_000 },
    validation: { enabled: true, strictMode: true },
    logging: { level: 'error', format: 'json' },
    development: { nodeEnv: 'test', debug: false },
  };
}

describe('BookStackClient credential', () => {
  let stub: BookStackStub;

  beforeAll(() => {
    stub = startBookStackStub();
  });

  afterAll(async () => {
    await stub.stop();
  });

  it('sends the configured API token by default', async () => {
    const client = new BookStackClient(
      configFor(stub, stub.apiToken),
      logger,
      new ErrorHandler(logger)
    );

    await client.listBooks();

    expect(stub.requests.at(-1)?.authorization).toBe(`Token ${stub.apiToken}`);
  });

  it('sends a Bearer credential instead of the API token when given one', async () => {
    stub.acceptedBearerTokens.add('exchanged-access-token');
    const client = new BookStackClient(
      configFor(stub, stub.apiToken),
      logger,
      new ErrorHandler(logger),
      { scheme: 'Bearer', secret: 'exchanged-access-token', principal: 'issuer\u0000user-1' }
    );

    await client.listBooks();

    expect(stub.requests.at(-1)?.authorization).toBe('Bearer exchanged-access-token');
  });

  it('refuses to build without any credential', () => {
    expect(() => new BookStackClient(configFor(stub), logger, new ErrorHandler(logger))).toThrow(
      /BOOKSTACK_API_TOKEN/
    );
  });
});
