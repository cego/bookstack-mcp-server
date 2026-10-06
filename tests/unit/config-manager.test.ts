import { afterEach, describe, expect, it } from 'bun:test';
import { ConfigManager } from '../../src/config/manager';

const PINNED_ENV = ['BOOKSTACK_BASE_URL', 'BOOKSTACK_API_TOKEN', 'NODE_ENV', 'DEBUG'] as const;
const savedEnv = new Map(PINNED_ENV.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ConfigManager.resetInstance();
});

describe('ConfigManager environment handling', () => {
  it('starts with a NODE_ENV outside development/production/test', () => {
    process.env.BOOKSTACK_BASE_URL = 'http://127.0.0.1:9/api';
    process.env.BOOKSTACK_API_TOKEN = 'config-test-id:config-test-secret';
    process.env.NODE_ENV = 'staging';

    ConfigManager.resetInstance();

    expect(() => ConfigManager.getInstance()).not.toThrow();
    expect(ConfigManager.getInstance().getConfig().bookstack.apiToken).toBe(
      'config-test-id:config-test-secret'
    );
  });

  it('exposes no development section', () => {
    process.env.BOOKSTACK_BASE_URL = 'http://127.0.0.1:9/api';
    process.env.BOOKSTACK_API_TOKEN = 'config-test-id:config-test-secret';
    process.env.DEBUG = 'true';

    ConfigManager.resetInstance();

    expect(Object.keys(ConfigManager.getInstance().getConfig()).sort()).toEqual([
      'bookstack',
      'logging',
      'rateLimit',
      'server',
      'validation',
    ]);
  });
});
