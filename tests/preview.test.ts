import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { $ } from 'bun';
import type { Server } from 'bun';
import { startPreview } from '../scripts/preview.ts';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));
const TMP = `${ROOT}out/tmp/preview-test-${crypto.randomUUID()}`;
const DIR = `${TMP}/dist`;
const SECRET = 'SECRET-OUTSIDE-DIR';

/** Sends a raw HTTP/1.1 request so the client does not normalise `..` in the path. */
async function rawGet(port: number, target: string): Promise<{ status: number; text: string }> {
  const chunks: Uint8Array[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data(_s, data) {
        chunks.push(data);
      },
      close() {
        resolve();
      },
      error(_s, err) {
        reject(err);
      },
    },
  });
  socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  await promise;
  const text = new TextDecoder().decode(Bun.concatArrayBuffers(chunks));
  return { status: Number(text.split(' ')[1]), text };
}

let root: Server<undefined>;
let sub: Server<undefined>;

beforeAll(async () => {
  await Bun.write(`${DIR}/index.html`, '<!doctype html><title>t</title><script src="./app.js"></script>');
  await Bun.write(`${DIR}/app.js`, 'console.log(1);');
  await Bun.write(`${DIR}/samples/samples.json`, '{}');
  await Bun.write(`${TMP}/secret.txt`, SECRET);
  root = startPreview({ dir: DIR, port: 0 });
  sub = startPreview({ dir: DIR, port: 0, base: '/sub/' });
});

afterAll(async () => {
  root.stop(true);
  sub.stop(true);
  await $`rm -rf ${TMP}`.quiet();
});

describe('01-4: preview server', () => {
  test('binds 127.0.0.1 and answers 200 for / and an asset', async () => {
    expect(root.hostname).toBe('127.0.0.1');
    expect(root.url.hostname).toBe('127.0.0.1');
    const index = await fetch(new URL('/', root.url));
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('./app.js');
    const asset = await fetch(new URL('/app.js', root.url));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('console.log(1);');
    expect((await fetch(new URL('/samples/samples.json', root.url))).status).toBe(200);
    expect((await fetch(new URL('/missing.js', root.url))).status).toBe(404);
  });

  test("with base '/sub/' answers 200 under /sub/ and 404 outside", async () => {
    expect(sub.hostname).toBe('127.0.0.1');
    expect((await fetch(new URL('/sub/', sub.url))).status).toBe(200);
    expect((await fetch(new URL('/sub/app.js', sub.url))).status).toBe(200);
    expect((await fetch(new URL('/', sub.url))).status).toBe(404);
    expect((await fetch(new URL('/app.js', sub.url))).status).toBe(404);
    expect((await fetch(new URL('/subway/app.js', sub.url))).status).toBe(404);
  });

  const attempts = [
    '/../secret.txt',
    '/samples/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E/secret.txt',
    '/samples/%2e%2e/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/%5c..%5csecret.txt',
    '/samples%5c..%5c..%5csecret.txt',
    '/%00secret.txt',
  ];
  for (const target of attempts) {
    test(`traversal ${target} gets 404/400 and never a file outside dir`, async () => {
      for (const [server, prefix] of [[root, ''], [sub, '/sub']] as const) {
        const res = await rawGet(server.port!, `${prefix}${target}`);
        expect([400, 404]).toContain(res.status);
        expect(res.text).not.toContain(SECRET);
      }
    });
  }
});
