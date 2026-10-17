import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import type { Server } from 'bun';
import { startDev } from '../scripts/dev.ts';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));
const TMP = `${ROOT}out/tmp/dev-test-${crypto.randomUUID()}`;

/** Runs `bun run <script> -- <args>` and resolves with the first printed http://127.0.0.1 URL. */
async function printedUrl(script: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([process.execPath, 'run', script, '--', ...args], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), 15_000);
  let out = '';
  try {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      out += decoder.decode(chunk);
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+\/\S*/);
      if (match) return match[0];
    }
    throw new Error(`no URL printed by bun run ${script}: ${out}${await new Response(proc.stderr).text()}`);
  } finally {
    clearTimeout(timer);
    proc.kill();
    await proc.exited;
  }
}

let server: Server<undefined>;

beforeAll(async () => {
  await Bun.write(`${TMP}/samples/samples.json`, '{"samples":[]}');
  await Bun.write(`${TMP}/dist/index.html`, '<!doctype html><title>t</title>');
  server = startDev({ port: 0, samplesDir: `${TMP}/samples` });
});

afterAll(async () => {
  server.stop(true);
  await $`rm -rf ${TMP}`.quiet();
});

describe('01-5: dev server and script entry points', () => {
  test('startDev binds 127.0.0.1 and serves / and /samples/samples.json', async () => {
    expect(server.hostname).toBe('127.0.0.1');
    expect(server.url.hostname).toBe('127.0.0.1');
    const index = await fetch(new URL('/', server.url));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('id="app"');
    const samples = await fetch(new URL('/samples/samples.json', server.url));
    expect(samples.status).toBe(200);
    expect(await samples.json()).toEqual({ samples: [] });
    expect((await fetch(new URL('/samples/missing.json', server.url))).status).toBe(404);
  });

  test('bun run dev prints the 127.0.0.1 URL', async () => {
    expect(await printedUrl('dev', ['--port', '0'])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  }, 20_000);

  test('bun run preview prints the 127.0.0.1 URL with the base path', async () => {
    const url = await printedUrl('preview', ['--dir', `${TMP}/dist`, '--port', '0', '--base', 'sub']);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sub\/$/);
  }, 20_000);

  test('no node: import in scripts, tests or package sources', async () => {
    const hits: string[] = [];
    const glob = new Bun.Glob('{scripts,tests,packages/*/src,packages/*/test}/**/*.{ts,tsx}');
    for await (const file of glob.scan({ cwd: ROOT })) {
      const text = await Bun.file(`${ROOT}${file}`).text();
      if (/from\s+["']node:|require\(\s*["']node:|import\(\s*["']node:/.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});
