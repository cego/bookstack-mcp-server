/**
 * A deterministic, in-process stand-in for the BookStack REST API.
 *
 * Why this exists. CI deliberately does not run the live integration suite
 * (RUN_INTEGRATION=0), which left the published tool surface untested: `initialize` is
 * answered by the MCP SDK out of the server's own capabilities and never touches a tool
 * handler, so tool registration or dispatch could break entirely and CI would stay green.
 * This stub closes that gap without Docker - a `tools/call` can run end to end, through
 * validation, the axios client, retry and the response path, against a server that
 * answers like BookStack does.
 *
 * It is not a BookStack emulator. It serves the handful of endpoints the transport tests
 * exercise, with canned answers and no state, and answers anything else with a
 * BookStack-shaped 404, so a test that silently starts calling an unimplemented endpoint
 * fails rather than passes.
 *
 * Every request is recorded, body included. That is what makes assertions about
 * *transmission* possible: a `count=2` that never reached the wire is a real bug this
 * records the absence of.
 */

/** One request the stub received, reduced to what a test might reasonably assert on. */
export interface RecordedRequest {
  method: string;
  /** Path with the /api prefix stripped, e.g. "/books". */
  path: string;
  /** Query string parsed into a plain object; repeated keys keep the last value. */
  query: Record<string, string>;
  authorization: string | undefined;
  /**
   * The `User-Agent` as it arrived ON THE WIRE.
   *
   * Recorded rather than inferred from the client's construction-time defaults: an
   * interceptor or a per-request header can replace that default after the fact, so
   * reading `axios.defaults` proves what was configured, not what was sent. This is
   * the server's view — the only one that settles it.
   */
  userAgent: string | undefined;
  /** The media type the request declared, without parameters such as the boundary. */
  contentType: string | undefined;
  /** The parsed body of a JSON request; undefined for any other body. */
  body: unknown;
  /** The fields of a multipart/form-data request; undefined for any other body. */
  form: Record<string, RecordedFormField> | undefined;
}

/** One multipart field: plain text, or a file part reduced to its name and bytes. */
export type RecordedFormField = string | { filename: string; bytes: Buffer };

export interface BookStackStub {
  /** Value for BOOKSTACK_BASE_URL: includes the /api suffix, as the real one does. */
  baseUrl: string;
  /** Value for BOOKSTACK_API_TOKEN. The stub rejects anything else with a 401. */
  apiToken: string;
  /** Requests seen so far, oldest first. */
  readonly requests: RecordedRequest[];
  /** Bearer tokens the stub also accepts, as BookStack does with OIDC access tokens. */
  readonly acceptedBearerTokens: Set<string>;
  stop(): Promise<void>;
}

/** The token the stub accepts, in BookStack's `<id>:<secret>` form. */
const STUB_API_TOKEN = 'stub-token-id:stub-token-secret';

/**
 * Fixture books. Two of them, so a `count=1` that is honoured is distinguishable from a
 * `count` that was dropped on the way out - the latter would return both.
 */
const BOOKS = [
  {
    id: 1,
    name: 'Stub Handbook',
    slug: 'stub-handbook',
    description: 'First fixture book served by the local BookStack stub.',
    created_at: '2026-01-01T00:00:00.000000Z',
    updated_at: '2026-01-02T00:00:00.000000Z',
    created_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
    updated_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
    owned_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
  },
  {
    id: 2,
    name: 'Stub Runbook',
    slug: 'stub-runbook',
    description: 'Second fixture book served by the local BookStack stub.',
    created_at: '2026-01-03T00:00:00.000000Z',
    updated_at: '2026-01-04T00:00:00.000000Z',
    created_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
    updated_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
    owned_by: { id: 1, name: 'Stub Admin', slug: 'stub-admin' },
  },
] as const;

/** What GET /api/system answers - the endpoint the health check probes. */
const SYSTEM_INFO = {
  version: 'v26.05.2',
  instance_id: 'stub-instance',
  app_name: 'BookStack Stub',
  app_logo: '',
  base_url: 'http://127.0.0.1/stub',
};

const STUB_USER = { id: 1, name: 'Stub Admin', slug: 'stub-admin' };

/** Comment list entries, shaped like GET /api/comments: no html, no archived flag. */
const COMMENTS = [
  {
    id: 1,
    commentable_id: 3,
    commentable_type: 'page',
    parent_id: null,
    local_id: 1,
    content_ref: '',
    created_by: 1,
    updated_by: 1,
    created_at: '2026-01-05T00:00:00.000000Z',
    updated_at: '2026-01-05T00:00:00.000000Z',
  },
  {
    id: 2,
    commentable_id: 3,
    commentable_type: 'page',
    parent_id: 1,
    local_id: 2,
    content_ref: '',
    created_by: 1,
    updated_by: 1,
    created_at: '2026-01-06T00:00:00.000000Z',
    updated_at: '2026-01-06T00:00:00.000000Z',
  },
] as const;

/** Pending imports, shaped like GET /api/imports. */
const IMPORTS = [
  {
    id: 7,
    name: 'Stub Import',
    size: 2757,
    type: 'chapter',
    created_by: 1,
    created_at: '2026-01-07T00:00:00.000000Z',
    updated_at: '2026-01-07T00:00:00.000000Z',
  },
] as const;

/** Tag names, shaped like GET /api/tags/names. */
const TAG_NAMES = [
  {
    name: 'Category',
    values: 2,
    usages: 3,
    page_count: 1,
    chapter_count: 0,
    book_count: 2,
    shelf_count: 0,
  },
] as const;

/** Tag values for `Category`, shaped like GET /api/tags/values-for-name. */
const TAG_VALUES = [
  {
    name: 'Category',
    value: 'Guide',
    usages: 2,
    page_count: 0,
    chapter_count: 0,
    book_count: 2,
    shelf_count: 0,
  },
  {
    name: 'Category',
    value: 'Runbook',
    usages: 1,
    page_count: 1,
    chapter_count: 0,
    book_count: 0,
    shelf_count: 0,
  },
] as const;

/**
 * What every ZIP export answers: a ZIP signature followed by bytes that are not valid UTF-8,
 * so text-decoding them anywhere on the way back would be detectable.
 */
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** BookStack's error envelope, which the client's error handler expects to find. */
function apiError(code: number, message: string): Response {
  return json({ error: { code, message } }, code);
}

/** Read a request body as JSON, multipart fields, or neither, by its declared type. */
async function parseBody(
  bytes: ArrayBuffer,
  contentType: string | undefined,
  rawContentType: string | null
): Promise<Pick<RecordedRequest, 'body' | 'form'>> {
  if (contentType === 'application/json' && bytes.byteLength > 0) {
    return { body: JSON.parse(new TextDecoder().decode(bytes)), form: undefined };
  }
  if (contentType === 'multipart/form-data' && rawContentType) {
    const parsed = await new Response(bytes, {
      headers: { 'content-type': rawContentType },
    }).formData();
    const form: Record<string, RecordedFormField> = {};
    for (const [key, value] of parsed.entries()) {
      form[key] =
        typeof value === 'string'
          ? value
          : { filename: value.name, bytes: Buffer.from(await value.arrayBuffer()) };
    }
    return { body: undefined, form };
  }
  return { body: undefined, form: undefined };
}

/**
 * Start the stub on an ephemeral loopback port.
 *
 * Bun.serve rather than Express: no dependency, and it is a genuinely separate HTTP
 * server from the app under test, so the tool call really does cross a socket.
 */
export function startBookStackStub(): BookStackStub {
  const requests: RecordedRequest[] = [];
  const acceptedBearerTokens = new Set<string>();

  // Untyped binding on purpose: `Bun.serve`'s return type is generic in its WebSocket
  // data, and annotating it as a bare `Server` fails to compile.
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request: Request): Promise<Response> {
      // Read every body, as a real server does, so a reused keep-alive connection stays in sync.
      const bytes = await request.arrayBuffer();
      const url = new URL(request.url);
      const authorization = request.headers.get('authorization') ?? undefined;
      const path = url.pathname.replace(/^\/api/, '');
      const rawContentType = request.headers.get('content-type');
      const contentType = rawContentType?.split(';')[0]?.trim().toLowerCase() || undefined;
      const recorded: RecordedRequest = {
        method: request.method,
        path,
        query: Object.fromEntries(url.searchParams),
        authorization,
        userAgent: request.headers.get('user-agent') ?? undefined,
        contentType,
        ...(await parseBody(bytes, contentType, rawContentType)),
      };
      requests.push(recorded);

      // The client sends `Authorization: Token <id>:<secret>`. Checking it here is what
      // makes a tool call prove the outbound credential was actually attached: without
      // this the stub would answer a request that forgot to authenticate.
      const bearer = authorization?.match(/^Bearer (\S+)$/)?.[1];
      const bearerAccepted = bearer !== undefined && acceptedBearerTokens.has(bearer);
      if (authorization !== `Token ${STUB_API_TOKEN}` && !bearerAccepted) {
        return apiError(401, 'Unauthorized');
      }

      if (request.method === 'GET' && path === '/system') {
        return json(SYSTEM_INFO);
      }

      if (request.method === 'GET' && path === '/books') {
        const count = Number(url.searchParams.get('count') ?? BOOKS.length);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const page = BOOKS.slice(offset, offset + count);
        // `total` is the unpaginated total, as BookStack reports it.
        return json({ data: page, total: BOOKS.length });
      }

      const bookMatch = path.match(/^\/books\/(\d+)$/);
      if (request.method === 'GET' && bookMatch) {
        const book = BOOKS.find((candidate) => candidate.id === Number(bookMatch[1]));
        return book ? json(book) : apiError(404, 'Book not found');
      }

      // BookStack labels every export application/octet-stream; the client derives the type.
      const exportMatch = path.match(/^\/(books|chapters|pages)\/(\d+)\/export\/zip$/);
      if (request.method === 'GET' && exportMatch) {
        return new Response(ZIP_BYTES, {
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="stub-${exportMatch[2]}.zip"`,
          },
        });
      }

      if (path === '/comments') {
        if (request.method === 'GET') {
          return json({ data: COMMENTS, total: COMMENTS.length });
        }
        if (request.method === 'POST') {
          const input = recorded.body as {
            page_id: number;
            reply_to?: number;
            content_ref?: string;
          };
          return json({
            ...COMMENTS[0],
            id: 167,
            commentable_id: input.page_id,
            parent_id: input.reply_to ?? null,
            local_id: 3,
            content_ref: input.content_ref ?? '',
            archived: false,
          });
        }
      }

      const commentMatch = path.match(/^\/comments\/(\d+)$/);
      if (commentMatch) {
        const comment = COMMENTS.find((candidate) => candidate.id === Number(commentMatch[1]));
        if (!comment) {
          return apiError(404, 'Comment not found');
        }
        if (request.method === 'GET') {
          return json({
            ...comment,
            html: '<p>Stub comment</p>',
            archived: false,
            created_by: STUB_USER,
            updated_by: STUB_USER,
            replies: [],
          });
        }
        if (request.method === 'PUT') {
          const input = recorded.body as { archived?: boolean };
          return json({ ...comment, archived: input.archived ?? false });
        }
        if (request.method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
      }

      if (path === '/imports') {
        if (request.method === 'GET') {
          return json({ data: IMPORTS, total: IMPORTS.length });
        }
        // BookStack reads the ZIP only from a multipart `file` part.
        if (request.method === 'POST') {
          const file = recorded.form?.file;
          if (typeof file !== 'object') {
            return json({ error: { code: 422, message: 'The file field is required.' } }, 422);
          }
          return json({
            ...IMPORTS[0],
            size: file.bytes.length,
            path: 'uploads/files/imports/stub.zip',
          });
        }
      }

      const importMatch = path.match(/^\/imports\/(\d+)$/);
      if (importMatch) {
        const pending = IMPORTS.find((candidate) => candidate.id === Number(importMatch[1]));
        if (!pending) {
          return apiError(404, 'Import not found');
        }
        if (request.method === 'GET') {
          return json({
            ...pending,
            path: 'uploads/files/imports/stub.zip',
            details: { name: pending.name },
          });
        }
        if (request.method === 'POST') {
          return json({ id: 9, book_id: 1, name: pending.name, slug: 'stub-import', priority: 1 });
        }
        if (request.method === 'DELETE') {
          return new Response(null, { status: 204 });
        }
      }

      if (request.method === 'GET' && path === '/tags/names') {
        return json({ data: TAG_NAMES, total: TAG_NAMES.length });
      }

      if (request.method === 'GET' && path === '/tags/values-for-name') {
        if (!url.searchParams.get('name')) {
          return json({ error: { code: 422, message: 'The name field is required.' } }, 422);
        }
        return json({ data: TAG_VALUES, total: TAG_VALUES.length });
      }

      // Anything else is out of scope on purpose - see the file header.
      return apiError(404, `The stub does not implement ${request.method} ${url.pathname}`);
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}/api`,
    apiToken: STUB_API_TOKEN,
    requests,
    acceptedBearerTokens,
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}

/** The fixture data the stub serves, for tests that assert on what came back. */
export const STUB_BOOKS = BOOKS;
export const STUB_SYSTEM_INFO = SYSTEM_INFO;
export const STUB_ZIP_BYTES = ZIP_BYTES;
