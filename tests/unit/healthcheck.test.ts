/**
 * The container health probes in Dockerfile and docker-compose.yml, run for real.
 *
 * Each probe is a `bun -e` one-liner. It is extracted from the file it ships in and run
 * against a local server on an arbitrary port, so a probe that ignores SERVER_PORT fails.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

function dockerfileProbe(): string {
  const text = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const match = /HEALTHCHECK[^\n]*\\\n\s*CMD bun -e "(.+)"\s*$/m.exec(text);
  if (!match?.[1]) throw new Error('Dockerfile HEALTHCHECK bun probe not found');
  return match[1];
}

function composeProbe(): string {
  const text = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const line = text.split('\n').find((l) => /^\s*test: \["CMD", "bun", "-e"/.test(l));
  if (!line) throw new Error('docker-compose.yml bun healthcheck not found');
  const command = JSON.parse(line.replace(/^\s*test:\s*/, '')) as string[];
  const script = command[3];
  if (!script) throw new Error('docker-compose.yml healthcheck has no script');
  return script;
}

async function runProbe(script: string, env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', script],
    env: { ...process.env, ...env },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return proc.exited;
}

describe('container health probes', () => {
  let server: ReturnType<typeof Bun.serve>;
  let status = 200;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request: Request): Response {
        const path = new URL(request.url).pathname;
        return path === '/health'
          ? new Response('{}', { status })
          : new Response('', { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  for (const [label, probe] of [
    ['Dockerfile', dockerfileProbe],
    ['docker-compose.yml', composeProbe],
  ] as const) {
    it(`${label} probes the port in SERVER_PORT`, async () => {
      status = 200;
      expect(await runProbe(probe(), { SERVER_PORT: String(server.port) })).toBe(0);

      status = 503;
      expect(await runProbe(probe(), { SERVER_PORT: String(server.port) })).toBe(1);
    });
  }

  it('ships the same probe in both files', () => {
    expect(composeProbe()).toBe(dockerfileProbe());
  });
});
