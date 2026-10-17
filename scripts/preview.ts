/**
 * `bun run preview [-- --dir <path>] [--port <n>] [--base <path>]`
 * Serves the static build (default `dist/`) on 127.0.0.1 only and prints the URL.
 */
import type { Server } from 'bun';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));

export const LOCAL_HOST = '127.0.0.1';
export const DEFAULT_PREVIEW_PORT = 4173;

export interface PreviewOptions {
  /** Directory to serve (default `<repo>/dist`). */
  dir?: string;
  /** TCP port; 0 picks a free port. */
  port?: number;
  /** URL path prefix the build is served under, for example `/sub/` (default `/`). */
  base?: string;
}

/** `--name value` / `--name=value` options; a literal `--` is ignored. */
export function parseCliArgs(argv: readonly string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--' || !arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      options.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`missing value for ${arg}`);
      options.set(arg.slice(2), next);
      i++;
    }
  }
  return options;
}

/** Parses a port option: an integer 0..65535. */
export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${value}`);
  return port;
}

/** Normalises a base path to `/…/` form ('sub' → '/sub/'); rejects `.`/`..` segments. */
export function normalizeBase(base = '/'): string {
  const segments = base.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '.' || s === '..' || /[\\:]/.test(s))) {
    // A drive letter here usually means Git Bash rewrote "/sub/" (MSYS path conversion).
    throw new Error(`invalid base path: ${base} (in Git Bash use --base sub or set MSYS_NO_PATHCONV=1)`);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}/`;
}

/**
 * Maps an encoded URL path below a served root (for example `samples/a%20b.json`) to a
 * file path inside `dir`. Returns `400` for any segment that could leave `dir` after
 * decoding (`..`, `.`, `/`, `\`, `:`, NUL, malformed escapes) and `''` + `index.html`
 * handling for directory paths. Never returns a path outside `dir`.
 */
export function resolveInside(dir: string, encodedPath: string): string | 400 {
  const raw = encodedPath.split('/');
  if (raw[raw.length - 1] === '') raw[raw.length - 1] = 'index.html';
  const segments: string[] = [];
  for (const part of raw) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return 400;
    }
    if (segment === '' || segment === '.' || segment === '..' || /[\\/:\0]/.test(segment)) return 400;
    segments.push(segment);
  }
  const root = dir.replace(/[\\/]+$/, '');
  return `${root}/${segments.join('/')}`;
}

/** Serves one file below `dir` for the encoded path, or a 400/404 response. */
export async function serveFileFrom(dir: string, encodedPath: string, method: string): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
  const path = resolveInside(dir, encodedPath);
  if (path === 400) return new Response('Bad Request', { status: 400 });
  let file = Bun.file(path);
  try {
    if ((await file.stat()).isDirectory()) file = Bun.file(`${path}/index.html`);
    if (!(await file.stat()).isFile()) return new Response('Not Found', { status: 404 });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  return new Response(method === 'HEAD' ? null : file, {
    headers: { 'content-type': file.type, 'content-length': String(file.size) },
  });
}

/** Path of the raw request target, taken before any URL normalisation (traversal checks need it). */
export function requestPath(req: Request): string {
  return req.url.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
}

/** Starts the static preview server on 127.0.0.1. */
export function startPreview({ dir = `${ROOT}dist`, port = DEFAULT_PREVIEW_PORT, base = '/' }: PreviewOptions = {}): Server<undefined> {
  const prefix = normalizeBase(base);
  return Bun.serve({
    hostname: LOCAL_HOST,
    port,
    async fetch(req) {
      const target = requestPath(req);
      if (prefix !== '/' && target === prefix.slice(0, -1)) {
        return Response.redirect(prefix, 308);
      }
      if (!target.startsWith(prefix)) return new Response('Not Found', { status: 404 });
      return serveFileFrom(dir, target.slice(prefix.length), req.method);
    },
  });
}

if (import.meta.main) {
  let args: Map<string, string>;
  try {
    args = parseCliArgs(Bun.argv.slice(2));
    normalizeBase(args.get('base'));
    parsePort(args.get('port'), DEFAULT_PREVIEW_PORT);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const dir = args.get('dir') ?? `${ROOT}dist`;
  if (!(await Bun.file(`${dir}/index.html`).exists())) {
    console.error(`No build found in ${dir}. Run "bun run build" first.`);
    process.exit(1);
  }
  const base = normalizeBase(args.get('base'));
  const server = startPreview({ dir, base, port: parsePort(args.get('port'), DEFAULT_PREVIEW_PORT) });
  console.log(`Preview of ${dir}: http://${LOCAL_HOST}:${server.port}${base}`);
}
