import type { BookStackClient } from '../api/client';
import {
  type MCPTool,
  NONBLANK_PATTERN,
  type TagNamesListParams,
  type TagValuesListParams,
  withClosedSchemas,
} from '../types';
import type { Logger } from '../utils/logger';
import type { ValidationHandler } from '../validation/validator';

/** The BookStack release that added the tags API. */
const TAGS_VERSION_NOTE = 'Requires BookStack v26.05+.';

/** Read-only tag listings; tags are written through the `tags` of the item they belong to. */
export class TagTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /** Get all tag tools */
  getTools(): MCPTool[] {
    return withClosedSchemas([this.createListNamesTool(), this.createListValuesTool()]);
  }

  /** List tag names tool */
  private createListNamesTool(): MCPTool {
    return {
      name: 'bookstack_tags_list_names',
      description: `List the tag names in use, with how many distinct values each has and how many pages, chapters, books and shelves carry it. Only tags on content visible to the authenticated user are counted. ${TAGS_VERSION_NOTE}`,
      category: 'tags',
      inputSchema: {
        type: 'object',
        properties: {
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of tag names to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of tag names to skip',
          },
          sort: {
            type: 'string',
            enum: [
              'name',
              'values',
              'usages',
              'page_count',
              'chapter_count',
              'book_count',
              'shelf_count',
              '-name',
              '-values',
              '-usages',
              '-page_count',
              '-chapter_count',
              '-book_count',
              '-shelf_count',
            ],
            default: 'name',
            description: 'Sort field. Prefix with "-" to sort descending, e.g. "-usages".',
          },
          filter: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Filter by tag name, matched exactly',
              },
            },
            description: 'Optional filter. BookStack filters tag names on `name` only.',
          },
        },
      },
      examples: [
        {
          description: 'Most used tag names first',
          input: { sort: '-usages', count: 10 },
          expected_output: 'Array of { name, values, usages, page_count, ... }',
          use_case: 'Learning the tagging vocabulary before searching by tag',
        },
      ],
      usage_patterns: [
        'Use the names found here in bookstack_search as [name] or [name=value]',
        'Follow up with bookstack_tags_list_values to see the values one name takes',
      ],
      related_tools: ['bookstack_tags_list_values', 'bookstack_search'],
      error_codes: [
        {
          code: 'UNAUTHORIZED',
          description: 'Authentication failed or insufficient permissions',
          recovery_suggestion: 'Verify API token and permissions',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<TagNamesListParams>(
          params,
          'tagNamesList'
        );
        this.logger.debug('Listing tag names', {
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        return await this.client.listTagNames(validatedParams);
      },
    };
  }

  /** List tag values tool */
  private createListValuesTool(): MCPTool {
    return {
      name: 'bookstack_tags_list_values',
      description: `List the values used with one tag name, with how many pages, chapters, books and shelves carry each. Only tags on content visible to the authenticated user are counted. ${TAGS_VERSION_NOTE}`,
      category: 'tags',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            pattern: NONBLANK_PATTERN,
            description: 'The tag name whose values to list, matched exactly',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            default: 20,
            description: 'Number of values to return',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Number of values to skip',
          },
          sort: {
            type: 'string',
            enum: [
              'name',
              'value',
              'usages',
              'page_count',
              'chapter_count',
              'book_count',
              'shelf_count',
              '-name',
              '-value',
              '-usages',
              '-page_count',
              '-chapter_count',
              '-book_count',
              '-shelf_count',
            ],
            default: 'value',
            description: 'Sort field. Prefix with "-" to sort descending, e.g. "-usages".',
          },
          filter: {
            type: 'object',
            properties: {
              value: {
                type: 'string',
                description: 'Filter by tag value, matched exactly',
              },
            },
            description: 'Optional filter. BookStack filters tag values on `value` only.',
          },
        },
      },
      examples: [
        {
          description: 'Values of the Category tag',
          input: { name: 'Category' },
          expected_output: 'Array of { name, value, usages, page_count, ... }',
          use_case: 'Choosing a value for a [Category=...] search',
        },
      ],
      usage_patterns: ['Take name from bookstack_tags_list_names'],
      related_tools: ['bookstack_tags_list_names', 'bookstack_search'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description: 'name missing or blank',
          recovery_suggestion: 'Pass the tag name to list values for',
        },
      ],
      handler: async (params: unknown) => {
        const validatedParams = this.validator.validateParams<TagValuesListParams>(
          params,
          'tagValuesList'
        );
        // Log the tag name's length, never the name itself.
        this.logger.debug('Listing tag values', {
          name_length: validatedParams.name.length,
          count: validatedParams.count,
          offset: validatedParams.offset,
          sort: validatedParams.sort,
          filters: Object.keys(validatedParams.filter ?? {}),
        });
        return await this.client.listTagValues(validatedParams);
      },
    };
  }
}

export default TagTools;
