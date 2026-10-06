/**
 * The `file_path` upload guard, on a real filesystem.
 *
 * `file_path` makes this process read a local file and upload it into BookStack, so whoever
 * steers the tool arguments - including text planted in a page an agent later reads - can
 * aim it at any file the process can open. The guard therefore holds under every transport,
 * stdio included, and its refusals say nothing about where anything on the server lives.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGuardedUploadFile } from '../../src/api/client';

const GUARD_ENV = ['MCP_TRANSPORT', 'BOOKSTACK_UPLOAD_ROOT'] as const;
const savedEnv = new Map<string, string | undefined>();

let base: string;
let uploadRoot: string;
let outside: string;
let inside: string;

function setGuardEnv(transport: string, root: string | undefined): void {
  process.env.MCP_TRANSPORT = transport;
  if (root === undefined) {
    delete process.env.BOOKSTACK_UPLOAD_ROOT;
  } else {
    process.env.BOOKSTACK_UPLOAD_ROOT = root;
  }
}

async function refusal(filePath: string): Promise<Error> {
  try {
    await readGuardedUploadFile(filePath);
  } catch (error) {
    return error as Error;
  }
  throw new Error('file_path was read when it should have been refused');
}

beforeAll(async () => {
  for (const key of GUARD_ENV) {
    savedEnv.set(key, process.env[key]);
  }

  base = await realpath(await mkdtemp(join(tmpdir(), 'upload-guard-')));
  uploadRoot = join(base, 'uploads');
  await mkdir(uploadRoot);
  inside = join(uploadRoot, 'inside.txt');
  await writeFile(inside, 'inside the root');
  outside = join(base, 'outside-secret.txt');
  await writeFile(outside, 'outside the root');
  await symlink(outside, join(uploadRoot, 'link-out.txt'));
});

afterEach(() => {
  for (const key of GUARD_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('file_path upload guard', () => {
  for (const transport of ['stdio', 'http']) {
    it(`refuses file_path under ${transport} when BOOKSTACK_UPLOAD_ROOT is unset`, async () => {
      setGuardEnv(transport, undefined);

      const error = await refusal(outside);

      expect(error.message).toContain('BOOKSTACK_UPLOAD_ROOT');
      expect(error.message).not.toContain(base);
    });

    it(`reads a file inside BOOKSTACK_UPLOAD_ROOT under ${transport}`, async () => {
      setGuardEnv(transport, uploadRoot);

      expect((await readGuardedUploadFile(inside)).toString()).toBe('inside the root');
    });

    it(`refuses escapes and unreadable paths under ${transport} with one generic message`, async () => {
      setGuardEnv(transport, uploadRoot);

      const messages = new Set<string>();
      for (const candidate of [
        join(uploadRoot, '..', 'outside-secret.txt'),
        join(uploadRoot, 'link-out.txt'),
        join(uploadRoot, 'missing.txt'),
        outside,
        uploadRoot,
      ]) {
        const { message } = await refusal(candidate);
        // Neither the resolved path nor the root: a refusal is not a map of the server.
        expect(message).not.toContain(base);
        messages.add(message);
      }

      // Identical wording, so a refusal cannot reveal whether a path outside the root exists.
      expect(messages.size).toBe(1);
    });
  }

  it('does not name a BOOKSTACK_UPLOAD_ROOT that cannot be resolved', async () => {
    const missingRoot = join(base, 'no-such-root');
    setGuardEnv('http', missingRoot);

    const { message } = await refusal(inside);

    expect(message).toContain('BOOKSTACK_UPLOAD_ROOT');
    expect(message).not.toContain(base);
  });
});
