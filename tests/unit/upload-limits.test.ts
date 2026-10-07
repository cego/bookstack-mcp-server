/**
 * The 50000 KB upload ceiling on every inline base64 field, held against the runtime.
 *
 * The tools promised "at most 50000 KB" in prose while neither the published schema nor
 * the validator enforced it, so an oversized payload was decoded and sent to BookStack.
 * Both halves are probed at the boundary: the published JSON Schema through ajv, as a
 * client reads it, and the real strict handler over a recording client.
 */

import { describe, expect, it } from 'bun:test';
import Ajv from 'ajv';
import { UPLOAD_MAX_BASE64_LENGTH, UPLOAD_MAX_BYTES } from '../../src/types';
import { buildTools, createRecordingClient, requireTool } from '../helpers/strict-tools';

/** Every base64 upload field, with a request that is valid apart from that field. */
const UPLOAD_FIELDS: Record<string, { field: string; base: Record<string, unknown> }> = {
  bookstack_attachments_create: { field: 'file', base: { uploaded_to: 1, name: 'Probe' } },
  bookstack_attachments_update: { field: 'file', base: { id: 1 } },
  bookstack_images_create: { field: 'image', base: { uploaded_to: 1 } },
  bookstack_images_update: { field: 'image', base: { id: 1 } },
  bookstack_imports_create: { field: 'file', base: {} },
};

const ajv = new Ajv({ allErrors: true, strictSchema: false, validateFormats: false });

const atLimit = 'A'.repeat(UPLOAD_MAX_BASE64_LENGTH);
const overLimit = `${atLimit}A`;

/** Did the strict handler let this input through to the client? */
async function runtimeAccepts(toolName: string, input: Record<string, unknown>): Promise<boolean> {
  const { calls, client } = createRecordingClient();
  try {
    await requireTool(buildTools(client), toolName).handler(input);
  } catch {
    // Whether the client was reached is the signal, not the throw.
  }
  return calls.length > 0;
}

function schemaAccepts(toolName: string, input: Record<string, unknown>): boolean {
  const { client } = createRecordingClient();
  return ajv.validate(requireTool(buildTools(client), toolName).inputSchema, input) === true;
}

describe('the base64 upload ceiling', () => {
  it('is the base64 length of 50000 KB', () => {
    expect(UPLOAD_MAX_BYTES).toBe(50_000 * 1024);
    expect(UPLOAD_MAX_BASE64_LENGTH).toBe(68_266_668);
    // The padded base64 of exactly 50000 KB fits; one more 3-byte group does not.
    expect(Buffer.alloc(UPLOAD_MAX_BYTES).toString('base64')).toHaveLength(
      UPLOAD_MAX_BASE64_LENGTH
    );
    expect(Buffer.alloc(UPLOAD_MAX_BYTES + 2).toString('base64').length).toBeGreaterThan(
      UPLOAD_MAX_BASE64_LENGTH
    );
  });

  it('is published as maxLength on every base64 upload field', () => {
    const { client } = createRecordingClient();
    const published: Record<string, number | undefined> = {};
    for (const tool of buildTools(client).values()) {
      for (const name of ['file', 'image']) {
        const property = tool.inputSchema.properties[name];
        if (property?.type === 'string') {
          published[`${tool.name}.${name}`] = property.maxLength;
        }
      }
    }

    const expected = Object.fromEntries(
      Object.entries(UPLOAD_FIELDS).map(([tool, { field }]) => [
        `${tool}.${field}`,
        UPLOAD_MAX_BASE64_LENGTH,
      ])
    );
    expect(published).toEqual(expected);
  });

  it('is enforced by the schema and the runtime alike, before BookStack', async () => {
    const outcomes: Record<string, { schema: boolean; runtime: boolean }> = {};
    const intended: Record<string, { schema: boolean; runtime: boolean }> = {};

    for (const [tool, { field, base }] of Object.entries(UPLOAD_FIELDS)) {
      for (const [label, value, accepted] of [
        ['at the limit', atLimit, true],
        ['one character over', overLimit, false],
      ] as const) {
        const input = { ...base, [field]: value };
        outcomes[`${tool}: ${label}`] = {
          schema: schemaAccepts(tool, input),
          runtime: await runtimeAccepts(tool, input),
        };
        intended[`${tool}: ${label}`] = { schema: accepted, runtime: accepted };
      }
    }

    expect(outcomes).toEqual(intended);
  }, 30_000);
});
