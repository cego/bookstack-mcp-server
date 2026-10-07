// Live coverage for the comment, tag and import tools and ZIP export; needs RUN_INTEGRATION.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Buffer } from 'node:buffer';
import { BookStackClient } from '../../src/api/client';
import type { Config } from '../../src/config/manager';
import { CommentTools } from '../../src/tools/comments';
import { ImportTools } from '../../src/tools/imports';
import { PageTools } from '../../src/tools/pages';
import { TagTools } from '../../src/tools/tags';
import type { MCPTool } from '../../src/types';
import { ErrorHandler } from '../../src/utils/errors';
import { Logger } from '../../src/utils/logger';
import { ValidationHandler } from '../../src/validation/validator';
import {
  apiFetchRetrying,
  apiJson,
  type BookStackHarness,
  CleanupTracker,
  ensureBookStack,
  shouldRunIntegration,
} from './helpers/bookstack';

const TEST_TIMEOUT_MS = 180_000;
const RATE_LIMIT_ATTEMPTS = 10;
const RATE_LIMIT_BACKOFF_MS = 8000;

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRateLimited(error: unknown): boolean {
  return (error as { data?: { status?: number } } | null)?.data?.status === 429;
}

async function withRateLimitRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= RATE_LIMIT_ATTEMPTS || !isRateLimited(error)) {
        throw error;
      }
      await Bun.sleep(RATE_LIMIT_BACKOFF_MS);
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: tool results are asserted field by field below
type Json = any;

const runIntegration = await shouldRunIntegration();

describe.skipIf(!runIntegration)('comment, tag and import tools (live BookStack)', () => {
  let harness: BookStackHarness;
  let tools: MCPTool[];
  let bookId: number;
  let chapterId: number;
  let pageId: number;
  const tagName = uniqueName('itest-tag');
  const cleanup = new CleanupTracker();

  const run = async (name: string, params: Record<string, unknown>): Promise<Json> => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Expected tool ${name} to be registered`);
    }
    return await withRateLimitRetry(async () => await tool.handler(params));
  };

  const createRaw = async (path: string, body: Record<string, unknown>): Promise<number> => {
    const res = await apiFetchRetrying(harness, path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await apiJson<{ id: number }>(res)).id;
  };

  beforeAll(async () => {
    harness = await ensureBookStack();
    const logger = Logger.getInstance();
    const config: Config = {
      bookstack: { baseUrl: harness.baseUrl, apiToken: harness.token, timeout: 30_000 },
      server: { name: 'bookstack-mcp-server-itest', version: '1.0.0', port: 3000 },
      rateLimit: { requestsPerMinute: 120, burstLimit: 12 },
      validation: { enabled: true, strictMode: true },
      logging: { level: 'error', format: 'json' },
    };
    const client = new BookStackClient(config, logger, new ErrorHandler(logger));
    const validator = new ValidationHandler({ enabled: true, strictMode: true });
    tools = [
      ...new CommentTools(client, validator, logger).getTools(),
      ...new TagTools(client, validator, logger).getTools(),
      ...new ImportTools(client, validator, logger).getTools(),
      ...new PageTools(client, validator, logger).getTools(),
    ];

    bookId = await createRaw('/books', { name: uniqueName('itest-extras-book') });
    cleanup.track('book', bookId);
    chapterId = await createRaw('/chapters', {
      book_id: bookId,
      name: uniqueName('itest-extras-chapter'),
    });
    cleanup.track('chapter', chapterId);
    pageId = await createRaw('/pages', {
      book_id: bookId,
      name: uniqueName('itest-extras-page'),
      html: '<p id="bkmrk-body">Body for comments, tags and exports.</p>',
      tags: [
        { name: tagName, value: 'Alpha' },
        { name: tagName, value: 'Beta' },
      ],
    });
    cleanup.track('page', pageId);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness) {
      await cleanup.run(harness);
    }
  }, TEST_TIMEOUT_MS);

  it(
    'creates, lists, reads, updates and deletes comments with a reply',
    async () => {
      const top = await run('bookstack_comments_create', {
        page_id: pageId,
        html: '<p>Top-level comment</p>',
      });
      expect(top.parent_id).toBeNull();
      expect(top.archived).toBe(false);

      const reply = await run('bookstack_comments_create', {
        page_id: pageId,
        html: '<p>A reply</p>',
        reply_to: top.local_id,
      });
      expect(reply.parent_id).toBe(top.local_id);

      const listed = await run('bookstack_comments_list', {
        filter: { commentable_id: pageId },
        sort: '-id',
      });
      expect(listed.total).toBe(2);
      expect(listed.data.map((comment: Json) => comment.id)).toEqual([reply.id, top.id]);

      const read = await run('bookstack_comments_read', { id: top.id });
      expect(read.html).toContain('Top-level comment');
      expect(read.replies.map((comment: Json) => comment.id)).toEqual([reply.id]);

      await run('bookstack_comments_update', { id: top.id, html: '<p>Edited comment</p>' });
      expect((await run('bookstack_comments_read', { id: top.id })).html).toContain(
        'Edited comment'
      );
      expect(
        (await run('bookstack_comments_update', { id: top.id, archived: true })).archived
      ).toBe(true);
      expect(
        (await run('bookstack_comments_update', { id: top.id, archived: false })).archived
      ).toBe(false);

      await run('bookstack_comments_delete', { id: reply.id });
      await run('bookstack_comments_delete', { id: top.id });
      await expect(run('bookstack_comments_read', { id: top.id })).rejects.toBeDefined();
    },
    TEST_TIMEOUT_MS
  );

  it(
    'lists tag names and the values used for a name',
    async () => {
      const names = await run('bookstack_tags_list_names', { filter: { name: tagName } });
      expect(names.total).toBe(1);
      // page_count counts tag uses on pages, so two values on one page count twice.
      expect(names.data[0]).toMatchObject({ name: tagName, values: 2, usages: 2, page_count: 2 });

      const values = await run('bookstack_tags_list_values', { name: tagName, sort: 'value' });
      expect(values.data.map((row: Json) => row.value)).toEqual(['Alpha', 'Beta']);

      const unknown = await run('bookstack_tags_list_values', { name: uniqueName('itest-none') });
      expect(unknown.total).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  it(
    'exports a page as a zip, imports it into a chapter, and deletes an import',
    async () => {
      const exported = await run('bookstack_pages_export', { id: pageId, format: 'zip' });
      expect(exported.encoding).toBe('base64');
      expect(exported.mime_type).toBe('application/zip');
      const zip = Buffer.from(exported.content, 'base64');
      expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');

      const created = await run('bookstack_imports_create', { file: exported.content });
      expect(created.type).toBe('page');

      const listed = await run('bookstack_imports_list', { filter: { type: 'page' }, sort: '-id' });
      expect(listed.data.some((entry: Json) => entry.id === created.id)).toBe(true);
      expect((await run('bookstack_imports_read', { id: created.id })).details).toBeDefined();

      const imported = await run('bookstack_imports_run', {
        id: created.id,
        parent_type: 'chapter',
        parent_id: chapterId,
      });
      cleanup.track('page', imported.id);
      expect(imported.chapter_id).toBe(chapterId);
      await expect(run('bookstack_imports_read', { id: created.id })).rejects.toBeDefined();

      const discarded = await run('bookstack_imports_create', { file: exported.content });
      await run('bookstack_imports_delete', { id: discarded.id });
      await expect(run('bookstack_imports_read', { id: discarded.id })).rejects.toBeDefined();
    },
    TEST_TIMEOUT_MS
  );
});
