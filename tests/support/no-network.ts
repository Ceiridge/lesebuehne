/**
 * Test preload (bunfig.toml): `fetch` and `WebSocket` to any host that is not loopback
 * throw synchronously, so `bun test` can never reach the network. Requests to 127.0.0.1,
 * ::1 and localhost still work (local test servers).
 */

const LOOPBACK_NAMES = new Set(['localhost', '[::1]', '::1']);

function isLoopback(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname) || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** Throws when `url` is a network URL (http, https, ws, wss) to a non-loopback host. */
function assertLocal(kind: string, url: string | URL): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // Not an absolute URL: the real implementation reports the error.
  }
  if (!/^(https?|wss?):$/.test(parsed.protocol)) return;
  if (!isLoopback(parsed.hostname)) {
    throw new Error(`no-network: ${kind} to ${parsed.href} is blocked in tests (only loopback hosts are allowed)`);
  }
}

const realFetch = globalThis.fetch;

function guardedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  assertLocal('fetch', input instanceof Request ? input.url : input);
  return realFetch(input, init);
}

globalThis.fetch = Object.assign(guardedFetch, { preconnect: realFetch.preconnect }) as typeof fetch;

const RealWebSocket = globalThis.WebSocket;

class GuardedWebSocket extends RealWebSocket {
  constructor(...args: ConstructorParameters<typeof RealWebSocket>) {
    assertLocal('WebSocket', args[0]);
    super(...args);
  }
}

globalThis.WebSocket = GuardedWebSocket as typeof WebSocket;
