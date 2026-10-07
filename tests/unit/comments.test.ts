import { beforeEach, describe, expect, it, type Mock, mock } from 'bun:test';
import type { BookStackClient } from '../../src/api/client';
import { CommentTools } from '../../src/tools/comments';
import type { MCPTool } from '../../src/types';
import type { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';

/** See tests/unit/books.test.ts: bun:test has no `jest.Mocked<T>`. */
type MockedMethods<T, K extends keyof T> = {
  [P in K]: T[P] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never;
};

type MockClient = MockedMethods<
  BookStackClient,
  'listComments' | 'createComment' | 'getComment' | 'updateComment' | 'deleteComment'
>;

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

describe('CommentTools', () => {
  let client: MockClient;
  let tools: MCPTool[];

  beforeEach(() => {
    client = {
      listComments: mock(),
      createComment: mock(),
      getComment: mock(),
      updateComment: mock(),
      deleteComment: mock(),
    };
    // The real strict validator: schema defaults are part of what reaches the client.
    tools = new CommentTools(
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

  it('registers the five comment tools', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'bookstack_comments_list',
      'bookstack_comments_create',
      'bookstack_comments_read',
      'bookstack_comments_update',
      'bookstack_comments_delete',
    ]);
  });

  it('lists with the schema defaults and passes filters through', async () => {
    const listing = { data: [], total: 0 };
    client.listComments.mockResolvedValue(listing);

    const result = await call('bookstack_comments_list', {
      filter: { commentable_id: 42, parent_id: 1 },
    });

    expect(client.listComments).toHaveBeenCalledWith({
      count: 20,
      offset: 0,
      sort: 'id',
      filter: { commentable_id: 42, parent_id: 1 },
    });
    expect(result).toBe(listing);
  });

  it('creates a reply anchored to page text', async () => {
    const input = {
      page_id: 42,
      html: '<p>Done.</p>',
      reply_to: 1,
      content_ref: 'bkmrk-page-title:7341676876991010:3-14',
    };

    await call('bookstack_comments_create', input);

    expect(client.createComment).toHaveBeenCalledWith(input);
  });

  it('refuses a content_ref BookStack would silently store as empty', async () => {
    await expect(
      call('bookstack_comments_create', { page_id: 42, html: '<p>x</p>', content_ref: 'title' })
    ).rejects.toThrow();
    expect(client.createComment).not.toHaveBeenCalled();
  });

  it('refuses a blank comment body', async () => {
    await expect(call('bookstack_comments_create', { page_id: 42, html: '  ' })).rejects.toThrow();
    expect(client.createComment).not.toHaveBeenCalled();
  });

  it('reads a comment by its global id', async () => {
    await call('bookstack_comments_read', { id: 22 });

    expect(client.getComment).toHaveBeenCalledWith(22);
  });

  it('splits the id from the changes on update', async () => {
    await call('bookstack_comments_update', { id: 167, html: '<p>Edited</p>', archived: true });

    expect(client.updateComment).toHaveBeenCalledWith(167, {
      html: '<p>Edited</p>',
      archived: true,
    });
  });

  it('refuses an update with nothing to change', async () => {
    await expect(call('bookstack_comments_update', { id: 167 })).rejects.toThrow(
      /html, archived, or both/
    );
    expect(client.updateComment).not.toHaveBeenCalled();
  });

  it('accepts an update carrying only archived: false', async () => {
    await call('bookstack_comments_update', { id: 167, archived: false });

    expect(client.updateComment).toHaveBeenCalledWith(167, { archived: false });
  });

  it('publishes that an update needs html or archived', () => {
    const update = tools.find((tool) => tool.name === 'bookstack_comments_update');

    expect(update?.inputSchema.anyOf).toEqual([{ required: ['html'] }, { required: ['archived'] }]);
  });

  it('deletes a comment and reports success', async () => {
    client.deleteComment.mockResolvedValue(undefined);

    const result = await call('bookstack_comments_delete', { id: 167 });

    expect(client.deleteComment).toHaveBeenCalledWith(167);
    expect(result).toEqual({ success: true, message: 'Comment 167 deleted successfully' });
  });
});
