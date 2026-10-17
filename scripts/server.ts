/**
 * `bun run server [-- --port <n>] [--dir <path>]`
 * Local "full" mode: serves the static build (default `dist/`) and the API on 127.0.0.1 only.
 */
import { createLocalApi } from '@lesebuehne/server';
import { LOCAL_HOST, parseCliArgs, parsePort, requestPath, serveFileFrom } from './preview.ts';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));

if (import.meta.main) {
  let args: Map<string, string>;
  try {
    args = parseCliArgs(Bun.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const dir = args.get('dir') ?? `${ROOT}dist`;
  if (!(await Bun.file(`${dir}/index.html`).exists())) {
    console.error(`No build found in ${dir}. Run "bun run build" first.`);
    process.exit(1);
  }
  const { api, loaded } = await createLocalApi(ROOT);
  const server = Bun.serve({
    hostname: LOCAL_HOST,
    port: parsePort(args.get('port'), loaded.config.server.port),
    idleTimeout: 0,
    fetch(req) {
      const target = requestPath(req);
      if (target.startsWith('/api/')) return api.handle(req);
      return serveFileFrom(dir, target.slice(1), req.method);
    },
  });
  console.log(`Lesebühne: http://${LOCAL_HOST}:${server.port}/ (config: ${loaded.files.join(', ') || 'defaults'})`);
}
