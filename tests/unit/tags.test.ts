import { beforeEach, describe, expect, it, type Mock, mock } from 'bun:test';
import type { BookStackClient } from '../../src/api/client';
import { TagTools } from '../../src/tools/tags';
import type { MCPTool } from '../../src/types';
import type { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';

/** See tests/unit/books.test.ts: bun:test has no `jest.Mocked<T>`. */
type MockedMethods<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never;
};

type MockClient = MockedMethods<BookStackClient, 'listTagNames' | 'listTagValues'>;

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

describe('TagTools', () => {
  let client: MockClient;
  let tools: MCPTool[];

  beforeEach(() => {
    client = { listTagNames: mock(), listTagValues: mock() };
    tools = new TagTools(
      client as unknown as BookStackClient,
      new ValidationHandler({ enabled: true, strictMode: true }),
      silentLogger
    ).getTools();
  });

  const call = (name: string, params: unknown): Promise<unknown> => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Expected tool ${name} to be registered`);
    }
    return tool.handler(params);
  };

  it('registers the two tag tools', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'bookstack_tags_list_names',
      'bookstack_tags_list_values',
    ]);
  });

  it('lists names with the schema defaults', async () => {
    const listing = { data: [], total: 0 };
    client.listTagNames.mockResolvedValue(listing);

    const result = await call('bookstack_tags_list_names', {});

    expect(client.listTagNames).toHaveBeenCalledWith({ count: 20, offset: 0, sort: 'name' });
    expect(result).toBe(listing);
  });

  it('lists the values of one name, filter included', async () => {
    await call('bookstack_tags_list_values', {
      name: 'Category',
      sort: '-usages',
      filter: { value: 'Guide' },
    });

    expect(client.listTagValues).toHaveBeenCalledWith({
      name: 'Category',
      count: 20,
      offset: 0,
      sort: '-usages',
      filter: { value: 'Guide' },
    });
  });

  it('refuses a missing or blank name, which BookStack requires', async () => {
    await expect(call('bookstack_tags_list_values', {})).rejects.toThrow();
    await expect(call('bookstack_tags_list_values', { name: ' ' })).rejects.toThrow();
    expect(client.listTagValues).not.toHaveBeenCalled();
  });

  it('refuses a filter field BookStack does not filter on', async () => {
    await expect(
      call('bookstack_tags_list_names', { filter: { value: 'Guide' } })
    ).rejects.toThrow();
    expect(client.listTagNames).not.toHaveBeenCalled();
  });
});
