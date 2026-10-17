/** Why a provider call failed; decides whether the chain moves on and whether to cool down. */
export type ProviderErrorCode =
  | 'unavailable' // not configured, no credentials, expired token
  | 'auth' // credentials rejected (401/403)
  | 'rate-limit' // 429, quota or usage limit
  | 'timeout'
  | 'network'
  | 'aborted' // the caller aborted; never retried
  | 'bad-request' // 400: our request does not fit this provider/model
  | 'server' // 5xx
  | 'invalid-output'; // no valid answer after the repair attempt

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerId: string;
  /** For rate limits: when the provider may be tried again (ms since epoch). */
  readonly retryAt?: number;
  readonly status?: number;

  constructor(providerId: string, code: ProviderErrorCode, message: string, o: { retryAt?: number; status?: number; cause?: unknown } = {}) {
    super(message, o.cause !== undefined ? { cause: o.cause } : undefined);
    this.name = 'ProviderError';
    this.providerId = providerId;
    this.code = code;
    if (o.retryAt !== undefined) this.retryAt = o.retryAt;
    if (o.status !== undefined) this.status = o.status;
  }
}

/** Parses `Retry-After` (seconds or HTTP date) into an absolute time. */
export function retryAfter(header: string | null, now = Date.now(), fallbackMs = 60_000): number {
  if (!header) return now + fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return now + Math.max(0, seconds) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? date : now + fallbackMs;
}

/** Maps an HTTP error response to a provider error (body text is shortened and redacted). */
export function errorFromResponse(providerId: string, status: number, body: string, headers?: Headers, now = Date.now()): ProviderError {
  const text = redact(body).slice(0, 300);
  if (status === 429 || /usage[_ ]limit|quota|rate[_ ]limit/iu.test(body)) {
    return new ProviderError(providerId, 'rate-limit', `rate limited (${status}): ${text}`, {
      status,
      retryAt: retryAfter(headers?.get('retry-after') ?? null, now),
    });
  }
  if (status === 401 || status === 403) return new ProviderError(providerId, 'auth', `not authorised (${status}): ${text}`, { status });
  if (status >= 500) return new ProviderError(providerId, 'server', `server error (${status}): ${text}`, { status });
  return new ProviderError(providerId, 'bad-request', `request rejected (${status}): ${text}`, { status });
}

/** Removes bearer tokens, API keys and JWT-like strings from text before logging or showing it. */
export function redact(text: string): string {
  return text
    .replace(/(bearer\s+)[\w.~+/=-]{8,}/giu, '$1[redacted]')
    .replace(/\b(sk|rk|pk|or)-[\w-]{12,}/gu, '[redacted-key]')
    .replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/gu, '[redacted-jwt]');
}

export function isAbort(e: unknown): boolean {
  return (e instanceof ProviderError && e.code === 'aborted') || (e instanceof Error && e.name === 'AbortError');
}
