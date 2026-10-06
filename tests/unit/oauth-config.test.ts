import { describe, expect, it } from 'bun:test';
import { loadHttpTransportConfig } from '../../src/config/manager';

const OAUTH_ENV = {
  MCP_AUTH_MODE: 'oauth',
  MCP_OAUTH_ISSUER: 'https://idp.example/tenant',
  MCP_OAUTH_RESOURCE: 'https://bookstack-mcp.example/message',
  MCP_OAUTH_CLIENT_ID: 'bookstack-mcp-server',
  MCP_OAUTH_CLIENT_SECRET: 'client-secret-value',
  BOOKSTACK_OAUTH_AUDIENCE: 'bookstack-api',
};

describe('HTTP transport auth mode', () => {
  it('defaults to the shared-secret mode with no OAuth settings', () => {
    const http = loadHttpTransportConfig({ MCP_AUTH_TOKEN: 's3cret' });

    expect(http.authToken).toBe('s3cret');
    expect(http.oauth).toBeUndefined();
  });

  it('reads the OAuth settings when MCP_AUTH_MODE=oauth', () => {
    const http = loadHttpTransportConfig(OAUTH_ENV);

    expect(http.authToken).toBeUndefined();
    expect(http.oauth).toEqual({
      issuer: 'https://idp.example/tenant',
      resource: 'https://bookstack-mcp.example/message',
      clientId: 'bookstack-mcp-server',
      clientSecret: 'client-secret-value',
      bookstackAudience: 'bookstack-api',
    });
  });

  it('rejects an unknown MCP_AUTH_MODE instead of falling back to a default', () => {
    expect(() => loadHttpTransportConfig({ MCP_AUTH_MODE: 'oidc' })).toThrow(/MCP_AUTH_MODE/);
  });

  it.each([
    'MCP_OAUTH_ISSUER',
    'MCP_OAUTH_RESOURCE',
    'MCP_OAUTH_CLIENT_ID',
    'MCP_OAUTH_CLIENT_SECRET',
    'BOOKSTACK_OAUTH_AUDIENCE',
  ])('fails closed when %s is missing in OAuth mode', (name) => {
    const env: Record<string, string> = { ...OAUTH_ENV, [name]: '' };

    expect(() => loadHttpTransportConfig(env)).toThrow(name);
  });

  it('refuses MCP_AUTH_TOKEN in OAuth mode, where it would have no effect', () => {
    expect(() => loadHttpTransportConfig({ ...OAUTH_ENV, MCP_AUTH_TOKEN: 's3cret' })).toThrow(
      /MCP_AUTH_TOKEN/
    );
  });

  it.each([
    ['plain http to a remote issuer', { MCP_OAUTH_ISSUER: 'http://idp.example/tenant' }],
    ['plain http to a remote resource', { MCP_OAUTH_RESOURCE: 'http://mcp.example/message' }],
    ['a resource with a fragment', { MCP_OAUTH_RESOURCE: 'https://mcp.example/message#x' }],
    ['an issuer with a query', { MCP_OAUTH_ISSUER: 'https://idp.example/tenant?x=1' }],
    ['a non-URL issuer', { MCP_OAUTH_ISSUER: 'idp' }],
  ])('rejects %s', (_label, override) => {
    expect(() => loadHttpTransportConfig({ ...OAUTH_ENV, ...override })).toThrow(
      /HTTP transport configuration/
    );
  });

  it('allows plain http on loopback, for local development', () => {
    const http = loadHttpTransportConfig({
      ...OAUTH_ENV,
      MCP_OAUTH_ISSUER: 'http://127.0.0.1:8080/tenant',
      MCP_OAUTH_RESOURCE: 'http://localhost:3000/message',
    });

    expect(http.oauth?.resource).toBe('http://localhost:3000/message');
  });

  it('refuses a client ID equal to the resource up to a trailing slash', () => {
    expect(() =>
      loadHttpTransportConfig({
        ...OAUTH_ENV,
        MCP_OAUTH_CLIENT_ID: 'https://bookstack-mcp.example/message/',
      })
    ).toThrow(/MCP_OAUTH_RESOURCE/);
  });

  it('refuses a resource equal to the client ID, which ID tokens would satisfy as audience', () => {
    expect(() =>
      loadHttpTransportConfig({
        ...OAUTH_ENV,
        MCP_OAUTH_RESOURCE: 'https://bookstack-mcp.example/message',
        MCP_OAUTH_CLIENT_ID: 'https://bookstack-mcp.example/message',
      })
    ).toThrow(/MCP_OAUTH_RESOURCE/);
  });
});
