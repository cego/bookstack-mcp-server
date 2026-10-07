import type { BookStackClient } from '../api/client';
import {
  COMMENT_CONTENT_REF_PATTERN,
  type CommentsListParams,
  type CreateCommentParams,
  type MCPTool,
  NONBLANK_PATTERN,
  type UpdateCommentParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { IdRequest, ValidationHandler } from '../validation/validator';

/** The BookStack release that added the comments API. */
const COMMENTS_VERSION_NOTE = 'Requires BookStack v25.11+.';

/** The whole `bookstack_comments_update` request: which comment, plus the changes. */
type UpdateCommentRequest = UpdateCommentParams & IdRequest;

/** Page comment tools: list, create, read, update and delete. */
export class CommentTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /** Get all comment tools */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListCommentsTool(),
      this.createCreateCommentTool(),
      this.createReadCommentTool(),
      this.createUpdateCommentTool(),
      this.createDeleteCommentTool(),
    ]);
  }

  /** List comments tool */
  private createListCommentsTool(): MCPTool {
    return {
      name: 'bookstack_comments_list',
      description: `List the comments on pages the authenticated user can see, with pagination, sorting and exact-match filters. Entries carry no \`html\` and no \`archived\` flag - read a comment for those. \`parent_id\` and \`local_id\` are numbers scoped to the page, not global comment IDs. ${COMMENTS_VERSION_NOTE}`,
      category: 'comments',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of comments to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of comments to skip',
          },
          sort: {
            type: 'string',
            enum: [
              'id',
              'commentable_id',
              'commentable_type',
              'parent_id',
              'local_id',
              'content_ref',
              'created_by',
              'updated_by',
              'created_at',
              'updated_at',
              '-id',
              '-commentable_id',
              '-commentable_type',
              '-parent_id',
              '-local_id',
              '-content_ref',
              '-created_by',
              '-updated_by',
              '-created_at',
              '-updated_at',
            ],
            default: 'id',
            description: 'Sort field. Prefix with "-" to sort descending.',
          },
          filter: {
            type: 'object',
            properties: {
              commentable_id: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by the ID of the page the comment is on',
              },
              commentable_type: {
                type: 'string',
                enum: ['page'],
                description: 'Filter by the type of item commented on. Only pages take comments.',
              },
              parent_id: {
                type: 'integer',
                minimum: 1,
                description:
                  "Filter to replies to one comment, given as that comment's local_id. Combine with commentable_id, since local_id is only unique within a page.",
              },
              local_id: {
                type: 'integer',
                minimum: 1,
                description:
                  "Filter by a comment's page-scoped number. Combine with commentable_id.",
              },
              content_ref: {
                type: 'string',
                description: 'Filter by the page text reference the comment is anchored to',
              },
              created_by: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by the ID of the user who wrote the comment',
              },
              updated_by: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by the ID of the user who last updated the comment',
              },
            },
            description: 'Optional filters to apply. All filters match exactly.',
          },
        },
      },
      examples: [
        {
          description: 'List the comments on one page',
          input: { filter: { commentable_id: 42 } },
          expected_output: 'Array of comment objects without their html',
          use_case: 'Reviewing the discussion on a page',
        },
        {
          description: 'List the replies to the first comment on a page',
          input: { filter: { commentable_id: 42, parent_id: 1 } },
          expected_output: 'The direct replies to comment #1 on page 42',
          use_case: 'Following one thread',
        },
      ],
      usage_patterns: [
        'Filter by commentable_id to see the comments on one page',
        'Use bookstack_comments_read for the comment text and its direct replies',
      ],
      related_tools: ['bookstack_comments_read', 'bookstack_pages_read'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CommentsListParams>(
          params,
          'commentsList'
        );
        // Filter KEYS only, after validation. See the same line in src/tools/books.ts.
        this.logger.debug('Listing comments', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        return await this.client.listComments(validatedParams);
      },
    };
  }

  /** Create comment tool */
  private createCreateCommentTool(): MCPTool {
    return {
      name: 'bookstack_comments_create',
      description: `Add a comment to a page, or reply to an existing comment on it. Requires the BookStack "comment-create-all" permission and view access to the page; draft pages cannot be commented on. BookStack keeps only simple HTML in a comment (p, a, ol, ul, li, strong, em, span, br, code) and strips the rest. ${COMMENTS_VERSION_NOTE}`,
      inputSchema: {
        type: 'object',
        required: ['page_id', 'html'],
        properties: {
          page_id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the page to comment on',
          },
          html: {
            type: 'string',
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            description: 'The comment content as HTML, e.g. "<p>Looks good</p>"',
          },
          reply_to: {
            type: 'integer',
            minimum: 1,
            description:
              'The local_id of the comment to reply to, on the same page - NOT its global id. A local_id that does not exist on the page is silently ignored and the comment is posted at top level.',
          },
          content_ref: {
            type: 'string',
            maxLength: 255,
            pattern: COMMENT_CONTENT_REF_PATTERN,
            description:
              "Anchor the comment to page text, as 'bkmrk-<element id>:<hash>:<start>-<end>' (e.g. 'bkmrk-page-title:7341676876991010:3-14'). BookStack stores any other value as '', so a malformed one is refused here.",
          },
        },
      },
      examples: [
        {
          description: 'Comment on a page',
          input: { page_id: 42, html: '<p>Can the title be updated?</p>' },
          expected_output: 'Comment object with its id and local_id',
          use_case: 'Leaving review feedback',
        },
        {
          description: 'Reply to the first comment on a page',
          input: { page_id: 42, html: '<p>Done.</p>', reply_to: 1 },
          expected_output: 'Comment object whose parent_id is 1',
          use_case: 'Answering a question in its thread',
        },
      ],
      usage_patterns: [
        'Take reply_to from the local_id of the comment being answered, never its id',
      ],
      related_tools: ['bookstack_comments_list', 'bookstack_comments_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Page not found or not visible',
          recovery_suggestion: 'Verify page_id',
        },
        {
          code: 'UNAUTHORIZED',
          description: 'Missing the comment-create-all permission',
          recovery_suggestion: 'Ask an administrator to grant comment creation to your role',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CreateCommentParams>(
          params,
          'commentCreate'
        );
        // The body's size, not the body. See the same line in src/tools/books.ts.
        this.logger.info('Creating comment', {
          page_id: validatedParams.page_id,
          reply_to: validatedParams.reply_to,
          html_length: validatedParams.html.length,
        });
        return await this.client.createComment(validatedParams);
      },
    };
  }

  /** Read comment tool */
  private createReadCommentTool(): MCPTool {
    return {
      name: 'bookstack_comments_read',
      description: `Get one comment with its HTML content, archived status and direct replies. Visible when the page it is on is visible to the authenticated user. ${COMMENTS_VERSION_NOTE}`,
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The global ID of the comment (not its local_id).',
          },
        },
      },
      examples: [
        {
          description: 'Read a comment and its replies',
          input: { id: 22 },
          expected_output: 'Comment object with html, archived and replies',
          use_case: 'Reading a discussion thread',
        },
      ],
      usage_patterns: ['Replies carry their own html, so one read covers a thread one level deep'],
      related_tools: ['bookstack_comments_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Comment not found or not visible',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Reading comment', { id });
        return await this.client.getComment(id);
      },
    };
  }

  /** Update comment tool */
  private createUpdateCommentTool(): MCPTool {
    return {
      name: 'bookstack_comments_update',
      description: `Change the content of a comment, or archive or unarchive it: send html, archived, or both. Requires the BookStack "comment-update-all" permission, or "comment-update-own" for your own comments. Only top-level comments can be archived: BookStack answers 400 for a reply. ${COMMENTS_VERSION_NOTE}`,
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The global ID of the comment to update',
          },
          html: {
            type: 'string',
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            description: 'New comment content as HTML. Replaces the existing content.',
          },
          archived: {
            type: 'boolean',
            description:
              'true archives the comment, false unarchives it. Send only to change the archive state.',
          },
        },
        anyOf: [{ required: ['html'] }, { required: ['archived'] }],
      },
      examples: [
        {
          description: 'Archive a resolved comment',
          input: { id: 167, archived: true },
          expected_output: 'Updated comment object with archived: true',
          use_case: 'Marking feedback as dealt with',
        },
      ],
      usage_patterns: ['Read the comment first to check parent_id is null before archiving'],
      related_tools: ['bookstack_comments_read'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Comment not found or not visible',
          recovery_suggestion: 'Verify ID',
        },
        {
          code: 'UNAUTHORIZED',
          description: 'Missing comment-update-all, or comment-update-own on your own comment',
          recovery_suggestion: 'Ask an administrator for the comment update permission',
        },
      ],
      handler: async (params: unknown) => {
        // Validate first, destructure second: see src/tools/attachments.ts.
        const { id, ...updateParams } = this.validator.validateParams<UpdateCommentRequest>(
          params,
          'commentUpdate'
        );
        this.logger.info('Updating comment', { id, fields: Object.keys(updateParams) });
        return await this.client.updateComment(id, updateParams);
      },
    };
  }

  /** Delete comment tool */
  private createDeleteCommentTool(): MCPTool {
    return {
      name: 'bookstack_comments_delete',
      description: `Permanently delete a comment. Requires the BookStack "comment-delete-all" permission, or "comment-delete-own" for your own comments. Comments do not go to the recycle bin. ${COMMENTS_VERSION_NOTE}`,
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The global ID of the comment to delete',
          },
        },
      },
      examples: [
        {
          description: 'Delete a comment',
          input: { id: 167 },
          expected_output: 'Success message',
          use_case: 'Removing an obsolete comment',
        },
      ],
      usage_patterns: ['Consider archiving a top-level comment instead, which keeps it readable'],
      related_tools: ['bookstack_comments_update'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Comment not found or not visible',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.warn('Deleting comment', { id });
        await this.client.deleteComment(id);
        return { success: true, message: `Comment ${id} deleted successfully` };
      },
    };
  }
}

export default CommentTools;
