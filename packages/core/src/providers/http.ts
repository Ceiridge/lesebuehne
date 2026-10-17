import { errorFromResponse, ProviderError } from './errors.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * `fetch` with a timeout and an outer abort signal. Network failures, timeouts and aborts become
 * `ProviderError`s; non-2xx responses become the matching error code.
 */
export async function request(
  providerId: string,
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs?: number; signal: AbortSignal },
): Promise<Response> {
  const { timeoutMs = 120_000, signal, ...rest } = init;
  if (signal.aborted) throw new ProviderError(providerId, 'aborted', 'aborted');
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...rest, signal: ctrl.signal });
  } catch (e) {
    if (signal.aborted) throw new ProviderError(providerId, 'aborted', 'aborted', { cause: e });
    if (ctrl.signal.aborted) throw new ProviderError(providerId, 'timeout', `no answer within ${timeoutMs} ms`, { cause: e });
    throw new ProviderError(providerId, 'network', `network error: ${(e as Error).message}`, { cause: e });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  if (!res.ok) throw errorFromResponse(providerId, res.status, await res.text().catch(() => ''), res.headers);
  return res;
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Parses a `text/event-stream` body into events. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  const flush = (): SseEvent | undefined => {
    if (data.length === 0) return undefined;
    const out = { event, data: data.join('\n') };
    event = 'message';
    data = [];
    return out;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/u, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        const e = flush();
        if (e) yield e;
      } else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
    }
  }
  const last = flush();
  if (last) yield last;
}
