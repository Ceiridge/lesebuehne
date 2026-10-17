/**
 * @lesebuehne/image-use — images through the `image-use` CLI (ChatGPT/Codex subscription, no API
 * key). Spawned WITHOUT any shell: the Python runtime is started directly with an argument array
 * and the prompt goes last after `--`, so an LLM-written prompt can neither become a command nor
 * an option. The install directory is resolved at runtime; nothing about it is committed.
 */
import { ProviderError, type Availability, type ImageProvider } from '@lesebuehne/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ImageUseConfig {
  id?: string;
  /** Install directory (default `$IMAGE_USE_DIR` or `~/.local/share/image-use`). */
  dir?: string;
  /** Interpreter + flags (default `py -3.11 -X utf8` on Windows, `python3 -X utf8` elsewhere). */
  python?: string[];
  /** Extra environment (overrides what the launcher sets). */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Test hook: replaces `Bun.spawn`. */
  spawn?: SpawnLike;
}

export type SpawnLike = (cmd: string[], o: { env: Record<string, string | undefined>; cwd: string; signal: AbortSignal }) => Promise<{ exitCode: number; stderr: string }>;

const MAX_PROMPT = 2000;

/** Default install directory, from the environment at runtime. */
export function defaultImageUseDir(env: Record<string, string | undefined> = Bun.env): string {
  if (env.IMAGE_USE_DIR) return env.IMAGE_USE_DIR;
  const home = env.HOME ?? env.USERPROFILE ?? '.';
  return join(home, '.local', 'share', 'image-use');
}

/**
 * Environment a launcher script sets (`set "NAME=value"` lines of `image-use.cmd`), with
 * `%VAR%` expanded from `env`. Only `IMAGE_USE_*`, `USE_*` and `CHATGPT_*` names are taken.
 */
export function launcherEnv(script: string, env: Record<string, string | undefined> = Bun.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of script.matchAll(/^\s*set\s+"([A-Z0-9_]+)=([^"\r\n]*)"\s*$/gimu)) {
    const name = m[1]!;
    if (!/^(IMAGE_USE_|USE_|CHATGPT_)/u.test(name)) continue;
    out[name] = m[2]!.replace(/%([A-Z0-9_]+)%/giu, (all, v: string) => env[v] ?? env[v.toUpperCase()] ?? all);
  }
  return out;
}

/** Prompt as one safe argument: control characters removed, length capped. */
export function cleanPrompt(prompt: string): string {
  // eslint-disable-next-line no-control-regex
  return prompt.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, MAX_PROMPT);
}

/** The full argument vector (exported for tests). */
export function imageUseArgs(o: { python: string[]; script: string; prompt: string; size: string; out: string; styleRef?: string; timeoutSeconds: number }): string[] {
  return [
    ...o.python,
    o.script,
    '--no-style',
    '--quiet',
    '--no-progress',
    '--format',
    'png',
    '--size',
    o.size,
    '--timeout',
    String(o.timeoutSeconds),
    '-o',
    o.out,
    ...(o.styleRef ? ['--style-ref', o.styleRef] : []),
    '--',
    cleanPrompt(o.prompt),
  ];
}

const realSpawn: SpawnLike = async (cmd, o) => {
  const p = Bun.spawn(cmd, { env: o.env, cwd: o.cwd, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', signal: o.signal });
  const stderr = await new Response(p.stderr).text();
  return { exitCode: await p.exited, stderr };
};

export class ImageUseProvider implements ImageProvider {
  readonly kind = 'image' as const;
  readonly id: string;
  readonly label = 'image-use (ChatGPT subscription)';
  readonly runsIn = ['server'] as const;
  readonly capabilities = { styleReference: true };
  readonly limits = { concurrency: 1 };
  readonly costHint = 'subscription' as const;
  private readonly dir: string;
  private readonly python: string[];

  constructor(private readonly config: ImageUseConfig = {}) {
    this.id = config.id ?? 'image-use';
    this.dir = config.dir ?? defaultImageUseDir();
    this.python = config.python ?? (process.platform === 'win32' ? ['py', '-3.11', '-X', 'utf8'] : ['python3', '-X', 'utf8']);
  }

  private get script(): string {
    return join(this.dir, 'image-use');
  }

  async isAvailable(): Promise<Availability> {
    if (!(await Bun.file(this.script).exists())) return { ok: false, reason: `image-use not found in ${this.dir} (set IMAGE_USE_DIR)` };
    return { ok: true };
  }

  private async env(): Promise<Record<string, string | undefined>> {
    const launcher = Bun.file(join(this.dir, 'image-use.cmd'));
    const fromLauncher = (await launcher.exists()) ? launcherEnv(await launcher.text()) : {};
    return { ...Bun.env, IMAGE_USE_NO_UPDATE_CHECK: '1', IMAGE_USE_DISABLE_UPGRADE: '1', ...fromLauncher, ...this.config.env };
  }

  async generate(req: { prompt: string; size: string; styleRef?: Uint8Array; signal: AbortSignal }): Promise<{ image: Uint8Array; mime: string }> {
    if (!/^\d{3,4}x\d{3,4}$/u.test(req.size)) throw new ProviderError(this.id, 'bad-request', `invalid size ${req.size}`);
    const work = await mkdtemp(join(tmpdir(), 'lb-image-'));
    try {
      const out = join(work, 'image.png');
      let styleRef: string | undefined;
      if (req.styleRef) {
        styleRef = join(work, 'style.png');
        await Bun.write(styleRef, req.styleRef);
      }
      const timeoutMs = this.config.timeoutMs ?? 600_000;
      const ctrl = new AbortController();
      const onAbort = (): void => ctrl.abort();
      req.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let r: { exitCode: number; stderr: string };
      try {
        r = await (this.config.spawn ?? realSpawn)(
          imageUseArgs({ python: this.python, script: this.script, prompt: req.prompt, size: req.size, out, ...(styleRef ? { styleRef } : {}), timeoutSeconds: Math.round(timeoutMs / 1000) }),
          { env: await this.env(), cwd: work, signal: ctrl.signal },
        );
      } catch (e) {
        if (req.signal.aborted) throw new ProviderError(this.id, 'aborted', 'aborted');
        throw new ProviderError(this.id, 'unavailable', `could not start image-use: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
      }
      if (req.signal.aborted) throw new ProviderError(this.id, 'aborted', 'aborted');
      if (ctrl.signal.aborted) throw new ProviderError(this.id, 'timeout', `no image within ${timeoutMs} ms`);
      if (r.exitCode !== 0) {
        const tail = r.stderr.trim().split(/\r?\n/u).slice(-3).join(' | ').slice(0, 400);
        const code = /rate|limit|quota|429/iu.test(tail) ? 'rate-limit' : /auth|login|token|401|403/iu.test(tail) ? 'auth' : 'server';
        throw new ProviderError(this.id, code, `image-use exited with ${r.exitCode}: ${tail}`);
      }
      const file = Bun.file(out);
      if (!(await file.exists())) throw new ProviderError(this.id, 'invalid-output', 'image-use wrote no image');
      return { image: new Uint8Array(await file.arrayBuffer()), mime: 'image/png' };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export default function create(config: ImageUseConfig = {}): ImageUseProvider {
  return new ImageUseProvider(config);
}
