/**
 * `bun run dev [-- --port <n>]`
 * Development server on 127.0.0.1 only: bundles packages/player/index.html on request
 * (HTML import) and serves the sample files under /samples/*. Prints the URL.
 */
import type { Server } from 'bun';
import index from '../packages/player/index.html';
import { LOCAL_HOST, parseCliArgs, parsePort, requestPath, serveFileFrom } from './preview.ts';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));

export const DEFAULT_DEV_PORT = 3000;

export interface DevOptions {
  /** TCP port; 0 picks a free port. */
  port?: number;
  /** Directory served under /samples/ (default `<repo>/samples`). */
  samplesDir?: string;
}

/** Starts the dev server on 127.0.0.1. */
export function startDev({ port = DEFAULT_DEV_PORT, samplesDir = `${ROOT}samples` }: DevOptions = {}): Server<undefined> {
  return Bun.serve({
    hostname: LOCAL_HOST,
    port,
    development: true,
    routes: {
      '/': index,
      '/samples/*': (req) => {
        const target = requestPath(req);
        return serveFileFrom(samplesDir, target.slice('/samples/'.length), req.method);
      },
    },
    fetch() {
      return new Response('Not Found', { status: 404 });
    },
  });
}

if (import.meta.main) {
  let port: number;
  try {
    port = parsePort(parseCliArgs(Bun.argv.slice(2)).get('port'), DEFAULT_DEV_PORT);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const server = startDev({ port });
  console.log(`Dev server: http://${LOCAL_HOST}:${server.port}/`);
}
