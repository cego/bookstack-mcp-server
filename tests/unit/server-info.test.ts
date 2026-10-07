import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ConfigManager } from '../../src/config/manager';
import { ServerInfoTools } from '../../src/tools/server-info';
import type { MCPResource, MCPServerInfo, MCPTool } from '../../src/types';
import { Logger } from '../../src/utils/logger';
import { buildTools, createRecordingClient, requireTool } from '../helpers/strict-tools';

const PINNED_ENV = ['BOOKSTACK_BASE_URL', 'BOOKSTACK_API_TOKEN'] as const;
const savedEnv = new Map(PINNED_ENV.map((key) => [key, process.env[key]]));

beforeEach(() => {
  process.env.BOOKSTACK_BASE_URL = 'http://127.0.0.1:9/api';
  process.env.BOOKSTACK_API_TOKEN = 'server-info-id:server-info-secret';
  ConfigManager.resetInstance();
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ConfigManager.resetInstance();
});

describe('bookstack_server_info authentication', () => {
  it('names both supported authentication methods', async () => {
    const tools = new ServerInfoTools(
      Logger.getInstance(),
      new Map<string, MCPTool>(),
      new Map<string, MCPResource>()
    );
    const tool = tools.getTools().find((t) => t.name === 'bookstack_server_info');
    if (!tool) throw new Error('bookstack_server_info tool is missing');

    const info = (await tool.handler({})) as unknown as MCPServerInfo;

    expect(info.capabilities.authentication.required).toBe(true);
    expect(info.capabilities.authentication.methods).toEqual([
      'BookStack API token',
      'OAuth access token (HTTP transport with MCP_AUTH_MODE=oauth)',
    ]);
  });
});

describe('bookstack_tool_categories', () => {
  it('files every registered tool under exactly one category, as its own `category` says', async () => {
    const tools = buildTools(createRecordingClient().client);
    const { categories } = (await requireTool(tools, 'bookstack_tool_categories').handler({})) as {
      categories: Array<{ name: string; tools: string[] }>;
    };

    const listed = categories.flatMap((category) => category.tools);
    expect([...listed].sort()).toEqual([...tools.keys()].sort());
    for (const category of categories) {
      for (const name of category.tools) {
        const declared = requireTool(tools, name).category;
        if (declared !== undefined) {
          expect(declared, name).toBe(category.name);
        }
      }
    }
  });

  it('offers exactly the category names it lists, in the same order', async () => {
    const tools = buildTools(createRecordingClient().client);
    const tool = requireTool(tools, 'bookstack_tool_categories');
    const { categories } = (await tool.handler({})) as { categories: Array<{ name: string }> };

    expect(tool.inputSchema.properties?.category?.enum).toEqual(categories.map((c) => c.name));
  });
});
