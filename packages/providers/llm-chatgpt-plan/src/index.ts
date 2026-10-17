/**
 * @lesebuehne/llm-chatgpt-plan — the user's ChatGPT plan through the official "Sign in with
 * ChatGPT" flow for open-source/local apps: our own registration, public Responses API,
 * `store:false`, `stream:true`. Server-only; tokens never reach the browser.
 */
import {
  completeWithRepair,
  jsonSchemaOf,
  ProviderError,
  readSse,
  request,
  type Availability,
  type LLMProvider,
  type LLMRequest,
  type LLMResult,
  type Usage,
} from '@lesebuehne/core';
import {
  authorizeUrl,
  exchangeCode,
  fetchJwks,
  newHostId,
  pkcePair,
  randomToken,
  readCallback,
  readStore,
  refreshTokens,
  SIWC,
  verifyIdToken,
  writeSecret,
  type FetchFn,
  type SiwcCredential,
  type SiwcStoreFile,
} from './siwc.ts';

export * from './siwc.ts';

const EXPIRY_MARGIN_MS = 120_000;

export interface ChatGptPlanConfig {
  id?: string;
  /** Credential store file in the app data directory. */
  storeFile: string;
  /** `auto` = first listed model; or a model slug. */
  model?: string;
  apiBase?: string;
  timeoutMs?: number;
  fetch?: FetchFn;
  now?: () => number;
}

export class ChatGptPlanLLM implements LLMProvider {
  readonly kind = 'llm' as const;
  readonly id: string;
  readonly label = 'ChatGPT plan (official sign-in)';
  readonly runsIn = ['server'] as const;
  readonly capabilities = { jsonSchema: true, streaming: true };
  readonly limits = { concurrency: 2 };
  readonly costHint = 'subscription' as const;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private refreshing?: Promise<SiwcCredential | undefined>;
  private models?: { at: number; list: string[] };
  private formatSupported = true;

  constructor(private readonly config: ChatGptPlanConfig) {
    this.id = config.id ?? 'chatgpt-plan';
    this.fetchFn = config.fetch ?? ((u, i) => fetch(u, i));
    this.now = config.now ?? Date.now;
  }

  private api(path: string): string {
    return `${(this.config.apiBase ?? SIWC.resource).replace(/\/+$/u, '')}${path}`;
  }

  async active(): Promise<SiwcCredential | undefined> {
    const store = await readStore(this.config.storeFile).catch(() => undefined);
    return store?.active ? store.credentials[store.active] : undefined;
  }

  /** A usable credential: valid, with the plan scope; refreshed (serialized) near expiry. */
  async credential(): Promise<SiwcCredential | { reason: string }> {
    const cred = await this.active();
    if (!cred) return { reason: 'not signed in (Sign in with ChatGPT)' };
    if (!cred.scopes.includes(SIWC.planScope)) return { reason: 'plan usage was not granted — sign in again and allow it' };
    if (cred.expires - EXPIRY_MARGIN_MS > this.now()) return cred;
    this.refreshing ??= (async () => {
      try {
        const t = await refreshTokens(this.fetchFn, { clientId: cred.clientId, refresh: cred.refresh });
        const next: SiwcCredential = {
          ...cred,
          access: t.access_token,
          refresh: t.refresh_token ?? cred.refresh,
          expires: this.now() + (t.expires_in ?? 3600) * 1000,
          ...(t.scope ? { scopes: t.scope.split(' ') } : {}),
        };
        const store = (await readStore(this.config.storeFile)) as SiwcStoreFile;
        store.credentials[cred.clientId] = next;
        await writeSecret(this.config.storeFile, store);
        return next;
      } catch {
        return undefined;
      } finally {
        this.refreshing = undefined;
      }
    })();
    const fresh = await this.refreshing;
    return fresh ?? { reason: 'session expired — sign in with ChatGPT again' };
  }

  async isAvailable(): Promise<Availability> {
    const c = await this.credential();
    return 'reason' in c ? { ok: false, reason: c.reason } : { ok: true };
  }

  private async model(req: LLMRequest<unknown>, access: string, signal: AbortSignal): Promise<string> {
    const wanted = req.model ?? this.config.model ?? 'auto';
    if (wanted !== 'auto') return wanted;
    if (!this.models || this.now() - this.models.at > 600_000) {
      const res = await request(this.id, this.fetchFn, this.api('/models'), { signal, headers: { authorization: `Bearer ${access}` }, timeoutMs: 20_000 });
      const json = (await res.json()) as { models?: Array<{ slug?: string; visibility?: string }> };
      this.models = { at: this.now(), list: (json.models ?? []).filter((m) => m.slug && m.visibility === 'list').map((m) => m.slug as string) };
    }
    const first = this.models.list[0];
    if (!first) throw new ProviderError(this.id, 'unavailable', 'no models listed for this account');
    return first;
  }

  async completeJSON<T>(req: LLMRequest<T>): Promise<LLMResult<T>> {
    const cred = await this.credential();
    if ('reason' in cred) throw new ProviderError(this.id, 'unavailable', cred.reason);
    const model = await this.model(req as LLMRequest<unknown>, cred.access, req.signal);
    const format = { type: 'json_schema', name: req.schemaName, strict: true, schema: jsonSchemaOf(req.schema) };
    return completeWithRepair(this.id, req, async (turns, signal) => {
      const c = await this.credential();
      if ('reason' in c) throw new ProviderError(this.id, 'unavailable', c.reason);
      let res: Response;
      try {
        res = await request(this.id, this.fetchFn, this.api('/responses'), {
          method: 'POST',
          signal,
          timeoutMs: this.config.timeoutMs ?? 180_000,
          headers: { authorization: `Bearer ${c.access}`, 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            model,
            input: [{ role: 'system', content: req.system }, ...turns.map((x) => ({ role: x.role, content: x.content }))],
            store: false,
            stream: true,
            ...(this.formatSupported ? { text: { format } } : {}),
          }),
        });
      } catch (e) {
        if (this.formatSupported && e instanceof ProviderError && e.code === 'bad-request' && /text|format|schema/iu.test(e.message)) {
          this.formatSupported = false; // validated anyway; the next attempt asks without native format
        }
        throw e;
      }
      if (!res.body) throw new ProviderError(this.id, 'server', 'empty response');
      let text = '';
      let usage: Usage | undefined;
      let answered = model;
      for await (const ev of readSse(res.body)) {
        let data: { type?: string; delta?: string; response?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: { code?: string; message?: string } } };
        try {
          data = JSON.parse(ev.data);
        } catch {
          continue;
        }
        const type = data.type ?? ev.event;
        if (type === 'response.output_text.delta' && typeof data.delta === 'string') text += data.delta;
        else if (type === 'response.completed') {
          answered = data.response?.model ?? model;
          usage = { inputTokens: data.response?.usage?.input_tokens ?? 0, outputTokens: data.response?.usage?.output_tokens ?? 0 };
        } else if (type === 'response.failed' || type === 'response.incomplete') {
          const err = data.response?.error;
          const limited = /usage_limit|limit_exceeded|quota/iu.test(err?.code ?? '');
          throw new ProviderError(this.id, limited ? 'rate-limit' : 'server', `ChatGPT plan: ${err?.message ?? err?.code ?? type}`, limited ? { retryAt: this.now() + 30 * 60_000 } : {});
        }
      }
      return { text, model: answered, ...(usage ? { usage } : {}) };
    });
  }
}

export interface PlanLoginSession {
  url: string;
  done: Promise<SiwcCredential>;
  cancel(): void;
}

/**
 * Starts the sign-in: loopback listener on 127.0.0.1 (started before the browser opens), fresh
 * state/nonce/PKCE, registration or reauthorization, ID-token validation, plan-scope check,
 * credentials stored per issued client id.
 */
export async function startPlanLogin(o: { storeFile: string; port?: number; fetch?: FetchFn; timeoutMs?: number; now?: () => number }): Promise<PlanLoginSession> {
  const fetchFn = o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const store: SiwcStoreFile = (await readStore(o.storeFile).catch(() => undefined)) ?? { hostId: newHostId(), credentials: {} };
  const previous = store.active ? store.credentials[store.active] : undefined;
  const { verifier, challenge } = await pkcePair();
  const state = randomToken();
  const nonce = randomToken();
  let resolveDone!: (c: SiwcCredential) => void;
  let rejectDone!: (e: Error) => void;
  const done = new Promise<SiwcCredential>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  done.catch(() => undefined);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: o.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/auth/callback') return new Response('Not Found', { status: 404 });
      try {
        const cb = readCallback(url, { state, ...(previous ? { clientId: previous.clientId } : {}) });
        if (!cb.ok) throw new Error(cb.error);
        const tokens = await exchangeCode(fetchFn, { clientId: cb.clientId, code: cb.code, verifier, redirectUri });
        if (!tokens.id_token || !tokens.refresh_token) throw new Error('token response incomplete');
        const scopes = (tokens.scope ?? '').split(' ').filter(Boolean);
        if (!scopes.includes(SIWC.planScope)) throw new Error('plan usage was not granted');
        const identity = await verifyIdToken(tokens.id_token, { jwks: await fetchJwks(fetchFn), clientId: cb.clientId, nonce, ...(o.now ? { now: o.now() } : {}) });
        if (previous && previous.clientId === cb.clientId && previous.sub !== identity.sub) throw new Error('signed in with a different account');
        const cred: SiwcCredential = {
          clientId: cb.clientId,
          hostId: store.hostId,
          sub: identity.sub,
          ...(identity.email ? { email: identity.email } : {}),
          idToken: tokens.id_token,
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          expires: (o.now?.() ?? Date.now()) + (tokens.expires_in ?? 3600) * 1000,
          scopes,
        };
        store.credentials[cred.clientId] = cred;
        store.active = cred.clientId;
        await writeSecret(o.storeFile, store);
        resolveDone(cred);
        return new Response('Signed in with ChatGPT. You can close this tab.', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      } catch (e) {
        rejectDone(e as Error);
        return new Response(`Sign-in failed: ${(e as Error).message}`, { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      } finally {
        setTimeout(() => server.stop(), 100);
      }
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}/auth/callback`;
  const timer = setTimeout(() => {
    rejectDone(new Error('sign-in timed out'));
    server.stop();
  }, o.timeoutMs ?? 5 * 60_000);
  done.finally(() => clearTimeout(timer)).catch(() => undefined);
  await writeSecret(o.storeFile, store); // persist the host id before the first sign-in
  return {
    url: authorizeUrl({
      hostId: store.hostId,
      redirectUri,
      state,
      nonce,
      challenge,
      ...(previous ? { clientId: previous.clientId, idTokenHint: previous.idToken, ...(previous.email ? { loginHint: previous.email } : {}) } : {}),
    }),
    done,
    cancel() {
      rejectDone(new Error('sign-in cancelled'));
      server.stop();
    },
  };
}

export default function create(config: ChatGptPlanConfig): ChatGptPlanLLM {
  return new ChatGptPlanLLM(config);
}
