/**
 * What ErrorHandler hands back to the caller, as opposed to what it logs.
 *
 * McpError `data` crosses the wire to the MCP client. A stack trace there tells any caller this
 * server's source layout and install paths; the log keeps the frames for the operator.
 */

import { describe, expect, it } from 'bun:test';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ErrorHandler } from '../../src/utils/errors';
import type { Logger } from '../../src/utils/logger';
import { PageContentError, PageStaleError } from '../../src/utils/page-content';

const logged: unknown[] = [];
const recordingLogger = {
  debug() {},
  info() {},
  warn() {},
  error(_message: string, meta?: unknown) {
    logged.push(meta);
  },
} as unknown as Logger;

describe('ErrorHandler caller-facing data', () => {
  it('sends no stack trace with an internal error, while still logging the error', () => {
    const error = new Error('boom');
    logged.length = 0;

    const handled = new ErrorHandler(recordingLogger).handleError(error);

    expect(handled.code).toBe(ErrorCode.InternalError);
    expect(handled.data).toEqual({ type: 'internal_error' });
    expect(JSON.stringify(handled.data)).not.toContain('error-handler.test.ts');
    expect(logged).toEqual([{ err: error }]);
  });
});

/** The message line and the parsed JSON hints of a tool error result. */
function readToolError(result: ReturnType<ErrorHandler['toToolErrorResult']>): {
  message: string;
  data: Record<string, unknown> | undefined;
  text: string;
} {
  expect(result.isError).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe('text');
  const text = result.content[0]?.text ?? '';
  const split = text.indexOf('\n\n');
  if (split === -1) {
    return { message: text, data: undefined, text };
  }
  return {
    message: text.slice(0, split),
    data: JSON.parse(text.slice(split + 2)) as Record<string, unknown>,
    text,
  };
}

describe('ErrorHandler tool error results', () => {
  const handler = new ErrorHandler(recordingLogger);

  it('carries recovery hints from a page edit that could not be applied', () => {
    const result = handler.toToolErrorResult(
      new PageContentError('Section "Setpu" not found', {
        available_sections: ['Intro', 'Setup'],
        found_with_different_whitespace: 'Set  up',
      })
    );

    const { message, data } = readToolError(result);
    expect(message).toBe('Section "Setpu" not found');
    expect(data).toEqual({
      type: 'page_content_error',
      available_sections: ['Intro', 'Setup'],
      found_with_different_whitespace: 'Set  up',
    });
  });

  it('carries the concurrent-modification type and its details', () => {
    const result = handler.toToolErrorResult(
      new PageStaleError('Page changed since it was read', { matched_sections: ['Setup'] })
    );

    const { data } = readToolError(result);
    expect(data).toEqual({ type: 'concurrent_modification', matched_sections: ['Setup'] });
  });

  it('drops the JSON-RPC code prefix from the message', () => {
    const result = handler.toToolErrorResult(
      new McpError(ErrorCode.InvalidParams, 'Validation failed', { type: 'validation_error' })
    );

    expect(readToolError(result).message).toBe('Validation failed');
  });

  it('never puts a stack trace or the upstream request path in the text', () => {
    const internal = new Error('boom');
    const upstream = new McpError(ErrorCode.InvalidRequest, 'Requested resource not found', {
      type: 'not_found_error',
      status: 404,
      url: '/books/999',
      details: { error: { message: 'Book not found' }, stack: internal.stack },
      stack: internal.stack,
    });

    for (const error of [internal, upstream]) {
      const { text } = readToolError(handler.toToolErrorResult(error));
      expect(text).not.toContain('error-handler.test.ts');
      expect(text).not.toContain('"stack"');
      expect(text).not.toContain('/books/999');
    }
    expect(readToolError(handler.toToolErrorResult(upstream)).data).toEqual({
      type: 'not_found_error',
      status: 404,
      details: { error: { message: 'Book not found' } },
    });
  });
});
