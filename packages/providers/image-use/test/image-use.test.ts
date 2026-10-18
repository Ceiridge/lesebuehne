import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRegistry } from '@lesebuehne/core';
import { OpenAICompatibleImages, OpenRouterImages } from '../../image-openai-compatible/src/index.ts';
import { cleanPrompt, imageUseArgs, ImageUseProvider, launcherEnv, type SpawnLike } from '../src/index.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array(200).fill(1)]);
const signal = new AbortController().signal;

describe('M5: image-use (no shell)', () => {
  test('registry admits four isolated CLI jobs and queues the fifth', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lb-iu-parallel-'));
    const calls: Array<{ cwd: string; finish(): void }> = [];
    const controller = new AbortController();
    const jobs: Array<Promise<unknown>> = [];
    const waitFor = async (n: number) => {
      for (let i = 0; i < 200 && calls.length < n; i++) await Bun.sleep(5);
      expect(calls).toHaveLength(n);
    };
    try {
      await Bun.write(join(dir, 'image-use'), '# fake runtime');
      const provider = new ImageUseProvider({ dir, spawn: async (cmd, opts) => {
        await new Promise<void>(finish => {
          calls.push({ cwd: opts.cwd, finish });
          if (opts.signal.aborted) finish();
          else opts.signal.addEventListener('abort', () => finish(), { once: true });
        });
        await Bun.write(cmd[cmd.indexOf('-o') + 1]!, PNG);
        return { exitCode: 0, stderr: '' };
      } });
      const registry = new ProviderRegistry().register(provider);
      for (let i = 0; i < 5; i++) jobs.push(registry.run('image', [provider.id], (p, signal) => p.generate({ prompt: `Scene ${i}`, size: '1024x1024', signal }), controller.signal));
      await waitFor(4);
      await Bun.sleep(20);
      expect(calls).toHaveLength(4);
      expect(new Set(calls.map(c => c.cwd)).size).toBe(4);
      calls[0]!.finish();
      await waitFor(5);
      calls.forEach(c => c.finish());
      await Promise.all(jobs);
      expect(new Set(calls.map(c => c.cwd)).size).toBe(5);
    } finally {
      controller.abort();
      calls.forEach(c => c.finish());
      await Promise.allSettled(jobs);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('argv: interpreter + script, options, prompt last after --, control characters removed', () => {
    const argv = imageUseArgs({ python: ['py', '-3.11'], script: 'S', prompt: '--evil "& del *"\n\u0007 a castle', size: '1536x1024', out: 'O.png', styleRef: 'R.png', timeoutSeconds: 600 });
    expect(argv.slice(0, 3)).toEqual(['py', '-3.11', 'S']);
    expect(argv).toContain('--no-style');
    expect(argv.slice(argv.indexOf('--style-ref'), argv.indexOf('--style-ref') + 2)).toEqual(['--style-ref', 'R.png']);
    expect(argv.at(-2)).toBe('--');
    expect(argv.at(-1)).toBe('--evil "& del *" a castle');
    expect(cleanPrompt('x'.repeat(5000))).toHaveLength(2000);
  });

  test('launcher env: only IMAGE_USE_/USE_/CHATGPT_ names, %VARS% expanded', () => {
    const script = '@echo off\nset "IMAGE_USE_MODEL=m1"\nset "IMAGE_USE_OPENCODE_AUTH=%USERPROFILE%\\.local\\x.json"\nset "PATH=evil"\nset "USE_NO_UPDATE_CHECK=1"\npy -3.11 "%~dp0image-use" %*';
    expect(launcherEnv(script, { USERPROFILE: 'H:\\me' })).toEqual({ IMAGE_USE_MODEL: 'm1', IMAGE_USE_OPENCODE_AUTH: 'H:\\me\\.local\\x.json', USE_NO_UPDATE_CHECK: '1' });
  });

  test('generate: writes the style reference, reads the output, maps failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lb-iu-'));
    try {
      await Bun.write(join(dir, 'image-use'), '# fake runtime');
      await Bun.write(join(dir, 'image-use.cmd'), 'set "IMAGE_USE_QUALITY=max"');
      const seen: Array<{ cmd: string[]; env: Record<string, string | undefined> }> = [];
      const ok: SpawnLike = async (cmd, o) => {
        seen.push({ cmd, env: o.env });
        expect(await Bun.file(cmd[cmd.indexOf('--style-ref') + 1]!).exists()).toBe(true);
        await Bun.write(cmd[cmd.indexOf('-o') + 1]!, PNG);
        return { exitCode: 0, stderr: '' };
      };
      const p = new ImageUseProvider({ dir, python: ['python'], spawn: ok });
      expect(await p.isAvailable()).toEqual({ ok: true });
      const r = await p.generate({ prompt: 'A study at night', size: '1024x688', quality: 'low', styleRef: PNG, signal });
      expect(r.mime).toBe('image/png');
      expect(r.image.byteLength).toBe(PNG.byteLength);
      expect(seen[0]!.env.IMAGE_USE_QUALITY).toBe('max');
      const args = seen[0]!.cmd;
      expect(args[args.indexOf('--size') + 1]).toBe('1024x688');
      expect(args.slice(args.indexOf('--quality'), args.indexOf('--quality') + 2)).toEqual(['--quality', 'low']);
      expect(args.indexOf('--quality')).toBeLessThan(args.indexOf('--'));
      const limited = new ImageUseProvider({ dir, python: ['python'], spawn: async () => ({ exitCode: 1, stderr: 'error: usage limit reached (429)' }) });
      await expect(limited.generate({ prompt: 'x', size: '1024x1024', signal })).rejects.toMatchObject({ code: 'rate-limit' });
      await expect(p.generate({ prompt: 'x', size: '1024x1024; rm', signal })).rejects.toMatchObject({ code: 'bad-request' });
      expect((await new ImageUseProvider({ dir: join(dir, 'missing') }).isAvailable()).ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('M5: image-openai-compatible', () => {
  test('OpenRouter translates compact dimensions to a 1K request and keeps the aspect', async () => {
    const requests: Array<{ image_config: unknown }> = [];
    const provider = new OpenRouterImages({ apiKey: 'test', model: 'test', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}` } }] } }] });
    } });
    await provider.generate({ prompt: 'scene', size: '1024x688', signal });
    expect(requests[0]!.image_config).toEqual({ aspect_ratio: '3:2', image_size: '1K' });
    await provider.generate({ prompt: 'scene', size: '1536x1024', signal });
    expect(requests[1]!.image_config).toEqual({ aspect_ratio: '3:2' });
  });
  test('b64_json answer, key header, errors', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
    const p = new OpenAICompatibleImages({
      id: 'img',
      baseURL: 'https://api.example/v1',
      apiKey: 'k',
      model: 'm',
      requiresKey: true,
      body: { quality: 'high', size: '1536x1024' },
      fetch: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>).authorization });
        return Response.json({ data: [{ b64_json: btoa(String.fromCharCode(...PNG)) }] });
      },
    });
    const r = await p.generate({ prompt: 'p', size: '1024x1024', signal });
    expect(r.mime).toBe('image/png');
    expect(calls[0]).toMatchObject({ url: 'https://api.example/v1/images/generations', auth: 'Bearer k', body: { model: 'm', prompt: 'p', size: '1024x1024', n: 1 } });
    expect(calls[0]!.body.quality).toBe('high');
    await p.generate({ prompt: 'p', size: '1024x688', quality: 'low', signal });
    expect(calls[1]!.body.quality).toBe('low');
    expect(calls[1]!.body.size).toBe('1024x688');
    const empty = new OpenAICompatibleImages({ id: 'e', baseURL: 'http://x/v1', fetch: async () => Response.json({ data: [] }) });
    await expect(empty.generate({ prompt: 'p', size: '1024x1024', signal })).rejects.toMatchObject({ code: 'invalid-output' });
  });
});
