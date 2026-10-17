/**
 * `bun run dev [-- --port <n>]`
 * Development server on 127.0.0.1 only: bundles packages/player/index.html on request
 * (HTML import), serves the sample files under /samples/* and the local API under /api/* (same
 * origin, so the player finds it). Prints the URL.
 */
import type { Server } from 'bun';
import index from '../packages/player/index.html';
import { createLocalApi } from '@lesebuehne/server';
import { LOCAL_HOST, parseCliArgs, parsePort, requestPath, serveFileFrom } from './preview.ts';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));

export const DEFAULT_DEV_PORT = 3000;

export interface DevOptions {
  /** TCP port; 0 picks a free port. */
  port?: number;
  /** Directory served under /samples/ (default `<repo>/samples`). */
  samplesDir?: string;
  /** Local API mounted under /api/ (omitted: no API, the player falls back to the browser). */
  api?: { handle(req: Request): Promise<Response> };
}

/** Starts the dev server on 127.0.0.1. */
export function startDev({ port = DEFAULT_DEV_PORT, samplesDir = `${ROOT}samples`, api }: DevOptions = {}): Server<undefined> {
  return Bun.serve({
    hostname: LOCAL_HOST,
    port,
    development: true,
    // LLM calls and SSE streams outlive Bun's default idle timeout.
    idleTimeout: 0,
    routes: {
      '/': index,
      '/samples/*': (req) => {
        const target = requestPath(req);
        return serveFileFrom(samplesDir, target.slice('/samples/'.length), req.method);
      },
    },
    fetch(req) {
      if (api && requestPath(req).startsWith('/api/')) return api.handle(req);
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
  const { api, loaded } = await createLocalApi(ROOT);
  const server = startDev({ port, api });
  console.log(`API: providers from ${loaded.files.join(', ') || 'defaults'} (bun run doctor for status)`);
  console.log(`Dev server: http://${LOCAL_HOST}:${server.port}/`);
}
