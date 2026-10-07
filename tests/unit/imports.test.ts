import { beforeEach, describe, expect, it, type Mock, mock } from 'bun:test';
import type { BookStackClient } from '../../src/api/client';
import { ImportTools } from '../../src/tools/imports';
import type { MCPTool } from '../../src/types';
import type { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';

/** See tests/unit/books.test.ts: bun:test has no `jest.Mocked<T>`. */
type MockedMethods<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never;
};

type MockClient = MockedMethods<
  BookStackClient,
  'listImports' | 'createImport' | 'getImport' | 'runImport' | 'deleteImport'
>;

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

describe('ImportTools', () => {
  let client: MockClient;
  let tools: MCPTool[];

  beforeEach(() => {
    client = {
      listImports: mock(),
      createImport: mock(),
      getImport: mock(),
      runImport: mock(),
      deleteImport: mock(),
    };
    tools = new ImportTools(
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

  it('registers the five import tools', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'bookstack_imports_list',
      'bookstack_imports_create',
      'bookstack_imports_read',
      'bookstack_imports_run',
      'bookstack_imports_delete',
    ]);
  });

  it('lists with the schema defaults and passes filters through', async () => {
    await call('bookstack_imports_list', { sort: '-created_at', filter: { type: 'book' } });

    expect(client.listImports).toHaveBeenCalledWith({
      count: 20,
      offset: 0,
      sort: '-created_at',
      filter: { type: 'book' },
    });
  });

  it('hands base64 content to the client as `file`', async () => {
    await call('bookstack_imports_create', { file: 'UEsDBA==' });

    expect(client.createImport).toHaveBeenCalledWith({ file: 'UEsDBA==' });
  });

  it('hands a server path to the client as `file_path`, for it to guard', async () => {
    await call('bookstack_imports_create', { file_path: '/srv/uploads/handbook.zip' });

    expect(client.createImport).toHaveBeenCalledWith({ file_path: '/srv/uploads/handbook.zip' });
  });

  it('refuses neither or both sources before the client is reached', async () => {
    await expect(call('bookstack_imports_create', {})).rejects.toThrow();
    await expect(
      call('bookstack_imports_create', { file: 'UEsDBA==', file_path: '/srv/a.zip' })
    ).rejects.toThrow();
    expect(client.createImport).not.toHaveBeenCalled();
  });

  it('reads an import by id', async () => {
    await call('bookstack_imports_read', { id: 31 });

    expect(client.getImport).toHaveBeenCalledWith(31);
  });

  it('runs into a parent, splitting the id from the body', async () => {
    await call('bookstack_imports_run', { id: 31, parent_type: 'book', parent_id: 28 });

    expect(client.runImport).toHaveBeenCalledWith(31, { parent_type: 'book', parent_id: 28 });
  });

  it('runs a book import with no parent', async () => {
    await call('bookstack_imports_run', { id: 25 });

    expect(client.runImport).toHaveBeenCalledWith(25, {});
  });

  it('refuses half a parent', async () => {
    await expect(call('bookstack_imports_run', { id: 31, parent_type: 'book' })).rejects.toThrow();
    await expect(call('bookstack_imports_run', { id: 31, parent_id: 28 })).rejects.toThrow();
    expect(client.runImport).not.toHaveBeenCalled();
  });

  it('deletes an import and reports success', async () => {
    client.deleteImport.mockResolvedValue(undefined);

    const result = await call('bookstack_imports_delete', { id: 31 });

    expect(client.deleteImport).toHaveBeenCalledWith(31);
    expect(result).toEqual({ success: true, message: 'Import 31 deleted successfully' });
  });
});
