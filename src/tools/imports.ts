import type { BookStackClient } from '../api/client';
import {
  type CreateImportParams,
  type ImportsListParams,
  type MCPTool,
  type RunImportParams,
  UPLOAD_MAX_BASE64_LENGTH,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { IdRequest, ValidationHandler } from '../validation/validator';

/** The whole `bookstack_imports_run` request: which import, plus where it goes. */
type RunImportRequest = RunImportParams & IdRequest;

/** The version and permission note every import tool carries. */
const IMPORT_PERMISSION_NOTE =
  'Requires BookStack v25.07+ and the "content-import" permission; without "settings-manage" only your own imports are visible.';

/** ZIP import tools: list, upload, read, run and delete pending imports. */
export class ImportTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /** Get all import tools */
  getTools(): MCPTool[] {
    return withClosedSchemas([
      this.createListImportsTool(),
      this.createCreateImportTool(),
      this.createReadImportTool(),
      this.createRunImportTool(),
      this.createDeleteImportTool(),
    ]);
  }

  /** List imports tool */
  private createListImportsTool(): MCPTool {
    return {
      name: 'bookstack_imports_list',
      description: `List pending ZIP imports - uploaded but not yet run. ${IMPORT_PERMISSION_NOTE}`,
      category: 'imports',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of imports to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of imports to skip',
          },
          sort: {
            type: 'string',
            enum: [
              'id',
              'name',
              'size',
              'type',
              'created_by',
              'created_at',
              'updated_at',
              '-id',
              '-name',
              '-size',
              '-type',
              '-created_by',
              '-created_at',
              '-updated_at',
            ],
            default: 'id',
            description: 'Sort field. Prefix with "-" to sort descending.',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Filter by the name of the top-level item in the ZIP',
              },
              size: {
                type: 'integer',
                minimum: 0,
                description: 'Filter by ZIP size in bytes',
              },
              type: {
                type: 'string',
                enum: ['book', 'chapter', 'page'],
                description: 'Filter by what the import will create',
              },
              created_by: {
                type: 'integer',
                minimum: 1,
                description: 'Filter by the ID of the user who uploaded the ZIP',
              },
            },
            description: 'Optional filters to apply. All filters match exactly.',
          },
        },
      },
      examples: [
        {
          description: 'List pending book imports',
          input: { filter: { type: 'book' } },
          expected_output: 'Array of import objects',
          use_case: 'Finding an uploaded ZIP to run',
        },
      ],
      usage_patterns: ['A run import is removed from this list, so it holds only pending work'],
      related_tools: ['bookstack_imports_read', 'bookstack_imports_run'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Missing the content-import permission',
          recovery_suggestion: 'Ask an administrator to grant content import to your role',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<ImportsListParams>(
          params,
          'importsList'
        );
        // Filter KEYS only, after validation. See the same line in src/tools/books.ts.
        this.logger.debug('Listing imports', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        return await this.client.listImports(validatedParams);
      },
    };
  }

  /** Create import tool */
  private createCreateImportTool(): MCPTool {
    return {
      name: 'bookstack_imports_create',
      description: `Upload a BookStack ZIP export so it can be imported. BookStack validates and stores the ZIP but creates no content until bookstack_imports_run is called. Provide EXACTLY ONE of file or file_path. ${IMPORT_PERMISSION_NOTE}`,
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            minLength: 1,
            maxLength: UPLOAD_MAX_BASE64_LENGTH,
            description:
              'Base64 encoded ZIP content, at most 50000 KB. Mutually exclusive with file_path.',
          },
          file_path: {
            type: 'string',
            minLength: 1,
            description:
              'Path to a ZIP on the server to upload instead of inlining base64. Mutually exclusive with file. Requires the operator to set BOOKSTACK_UPLOAD_ROOT, under every transport, and the path must resolve inside it.',
          },
        },
        oneOf: [
          {
            title: 'Upload inline base64 content',
            required: ['file'],
            not: { required: ['file_path'] },
          },
          {
            title: 'Upload a file already on the server',
            required: ['file_path'],
            not: { required: ['file'] },
          },
        ],
      },
      examples: [
        {
          description: 'Upload a ZIP from the server',
          input: { file_path: '/srv/uploads/handbook.zip' },
          expected_output: 'Import object with its id, name, type and size',
          use_case: 'Staging a book exported from another BookStack instance',
        },
      ],
      usage_patterns: [
        'The ZIP must be in BookStack\'s own export format, e.g. from bookstack_books_export with format "zip"',
        'Check `type` on the result: a chapter or page import needs a parent when it is run',
      ],
      related_tools: ['bookstack_imports_run', 'bookstack_books_export'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description:
            'Neither or both of file and file_path supplied, or BookStack rejected the ZIP contents (its 422 lists the problems)',
          recovery_suggestion: 'Send exactly one source, holding a BookStack ZIP export',
        },
        {
          code: 'VALIDATION_ERROR',
          description: 'file_path refused, or resolves outside BOOKSTACK_UPLOAD_ROOT',
          recovery_suggestion:
            'Send the content as base64, or ask the operator to set BOOKSTACK_UPLOAD_ROOT to a directory holding the file',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<CreateImportParams>(
          params,
          'importCreate'
        );
        this.logger.info('Creating import', {
          source: validatedParams.file_path ? 'file_path' : 'base64',
        });
        return await this.client.createImport(validatedParams);
      },
    };
  }

  /** Read import tool */
  private createReadImportTool(): MCPTool {
    return {
      name: 'bookstack_imports_read',
      description: `Get a pending ZIP import, with \`details\` describing the content it holds - its shape depends on \`type\`. ${IMPORT_PERMISSION_NOTE}`,
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The ID of the import',
          },
        },
      },
      examples: [
        {
          description: 'Inspect an import before running it',
          input: { id: 31 },
          expected_output: 'Import object with details of its chapters, pages and tags',
          use_case: 'Checking what a ZIP will create',
        },
      ],
      usage_patterns: ['Read before running to confirm the type and contents'],
      related_tools: ['bookstack_imports_run'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Import not found, already run, or not yours',
          recovery_suggestion: 'List imports to find a pending one',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.debug('Reading import', { id });
        return await this.client.getImport(id);
      },
    };
  }

  /** Run import tool */
  private createRunImportTool(): MCPTool {
    return {
      name: 'bookstack_imports_run',
      description: `WRITE ACTION: run a pending ZIP import, creating its book, chapter or page - with any images and attachments it holds - in BookStack. On success the new item is returned and the import is deleted. A chapter import needs parent_type "book"; a page import needs a book or chapter parent; a book import takes no parent and ignores one. ${IMPORT_PERMISSION_NOTE} Creating the content also needs the matching create permissions.`,
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The ID of the import to run',
          },
          parent_type: {
            type: 'string',
            enum: ['book', 'chapter'],
            description: 'Type of the parent to import into. Send together with parent_id.',
          },
          parent_id: {
            type: 'integer',
            minimum: 1,
            description: 'ID of the parent to import into. Send together with parent_type.',
          },
        },
        // Both parent fields or neither.
        anyOf: [
          { required: ['parent_type', 'parent_id'] },
          { not: { anyOf: [{ required: ['parent_type'] }, { required: ['parent_id'] }] } },
        ],
      },
      examples: [
        {
          description: 'Import a chapter ZIP into a book',
          input: { id: 31, parent_type: 'book', parent_id: 28 },
          expected_output: 'The created chapter',
          use_case: 'Restoring a chapter into an existing book',
        },
        {
          description: 'Import a book ZIP',
          input: { id: 25 },
          expected_output: 'The created book',
          use_case: 'Migrating a book between instances',
        },
      ],
      usage_patterns: [
        'Read the import first: its type decides whether a parent is required',
        'Not idempotent - each successful run creates new content',
      ],
      related_tools: ['bookstack_imports_read', 'bookstack_imports_create'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description:
            'Only one of parent_type and parent_id supplied, or a parent is missing for a chapter or page import',
          recovery_suggestion: 'Send both parent fields for a chapter or page import',
        },
        {
          code: 'INTERNAL_ERROR',
          description:
            'BookStack could not import the ZIP, e.g. a chapter given a chapter parent or missing permissions; its 500 lists the problems and nothing is created',
          recovery_suggestion: 'Fix the listed problems and run the import again',
        },
      ],
      handler: async (params: unknown) => {
        const { id, ...runParams } = this.validator.validateParams<RunImportRequest>(
          params,
          'importRun'
        );
        this.logger.warn('Running import', {
          id,
          parent_id: runParams.parent_id,
          fields: Object.keys(runParams),
        });
        return await this.client.runImport(id, runParams);
      },
    };
  }

  /** Delete import tool */
  private createDeleteImportTool(): MCPTool {
    return {
      name: 'bookstack_imports_delete',
      description: `Permanently delete a pending ZIP import and its stored file without running it. Content already imported is unaffected. ${IMPORT_PERMISSION_NOTE}`,
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: {
            type: 'integer',
            minimum: 1,
            description: 'The ID of the import to delete',
          },
        },
      },
      examples: [
        {
          description: 'Discard an import',
          input: { id: 31 },
          expected_output: 'Success message',
          use_case: 'Removing a ZIP uploaded by mistake',
        },
      ],
      usage_patterns: ['Confirm ID before deleting as this is permanent'],
      related_tools: ['bookstack_imports_list'],
      error_codes: [
        {
          code: 'NOT_FOUND',
          description: 'Import not found, already run, or not yours',
          recovery_suggestion: 'Verify ID',
        },
      ],
      handler: async (params: unknown) => {
        const { id } = this.validator.validateParams<IdRequest>(params, 'id');
        this.logger.warn('Deleting import', { id });
        await this.client.deleteImport(id);
        return { success: true, message: `Import ${id} deleted successfully` };
      },
    };
  }
}

export default ImportTools;
