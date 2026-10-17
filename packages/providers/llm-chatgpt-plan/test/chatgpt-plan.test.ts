import { afterAll, describe, expect, test } from 'bun:test';
import * as z from 'zod';
import { authorizeUrl, ChatGptPlanLLM, exchangeCode, readCallback, SIWC, startPlanLogin, verifyIdToken, writeSecret, type SiwcStoreFile } from '../src/index.ts';

const TMP = Bun.fileURLToPath(new URL(`../../../../out/tmp/siwc-${crypto.randomUUID()}/`, import.meta.url));
afterAll(async () => {
  await Bun.$`rm -rf ${TMP}`.quiet().nothrow();
});

const b64url = (s: string | Uint8Array) =>
  btoa(typeof s === 'string' ? s : String.fromCharCode(...s))
    .replace(/=+$/u, '')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_');

/** A local RSA key pair stands in for OpenAI's signing key (tests never contact OpenAI). */
const keys = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' };
async function signIdToken(claims: Record<string, unknown>): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
  const body = b64url(JSON.stringify(claims));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

describe('chatgpt-plan: official sign-in contract (fakes only)', () => {
  test('authorize URL: registration vs reauthorization, loopback 127.0.0.1 only', () => {
    const base = { hostId: 'urn:uuid:1', redirectUri: 'http://127.0.0.1:1455/auth/callback', state: 's', nonce: 'n', challenge: 'c' };
    const reg = new URL(authorizeUrl(base)).searchParams;
    expect(reg.get('client_id')).toBe('dynamic_agent_client');
    expect(reg.get('agent_name_hint')).toBe('Lesebuehne');
    expect(reg.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
    expect(reg.get('resource')).toBe('https://api.openai.com/v1');
    expect(reg.get('code_challenge_method')).toBe('S256');
    const again = new URL(authorizeUrl({ ...base, clientId: 'oaiapp_1', idTokenHint: 'idt', loginHint: 'a@b.c' })).searchParams;
    expect(again.get('client_id')).toBe('oaiapp_1');
    expect(again.has('agent_name_hint')).toBe(false);
    expect(again.get('id_token_hint')).toBe('idt');
    expect(() => authorizeUrl({ ...base, redirectUri: 'http://localhost:1455/auth/callback' })).toThrow();
  });

  test('callback: state first, declined consent, issued client id rules', () => {
    const u = (q: string) => new URL(`http://127.0.0.1:1/auth/callback?${q}`);
    expect(readCallback(u('state=x&code=c&client_id=oaiapp_1'), { state: 's' })).toEqual({ ok: false, error: 'state mismatch' });
    expect(readCallback(u('state=s&error=access_denied'), { state: 's' })).toEqual({ ok: false, error: 'sign-in was declined' });
    expect(readCallback(u('state=s&code=c'), { state: 's' })).toMatchObject({ ok: false });
    expect(readCallback(u('state=s&code=c&client_id=oaiapp_1'), { state: 's' })).toEqual({ ok: true, code: 'c', clientId: 'oaiapp_1' });
    expect(readCallback(u('state=s&code=c'), { state: 's', clientId: 'oaiapp_1' })).toEqual({ ok: true, code: 'c', clientId: 'oaiapp_1' });
    expect(readCallback(u('state=s&code=c&client_id=oaiapp_2'), { state: 's', clientId: 'oaiapp_1' })).toMatchObject({ ok: false });
  });

  test('token exchange form and ID token validation (signature, iss, aud, exp, nonce)', async () => {
    let form = '';
    await exchangeCode(
      async (_u, i) => {
        form = String(i?.body);
        return Response.json({ access_token: 'a' });
      },
      { clientId: 'oaiapp_1', code: 'c', verifier: 'v', redirectUri: 'http://127.0.0.1:9/auth/callback' },
    );
    expect(Object.fromEntries(new URLSearchParams(form))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'oaiapp_1',
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'http://127.0.0.1:9/auth/callback',
      resource: 'https://api.openai.com/v1',
    });
    const now = 1_800_000_000_000;
    const good = { iss: SIWC.issuer, aud: 'oaiapp_1', exp: now / 1000 + 600, nonce: 'n', sub: 'user-1', email: 'u@example.org' };
    const jwks = { keys: [jwk] };
    expect(await verifyIdToken(await signIdToken(good), { jwks, clientId: 'oaiapp_1', nonce: 'n', now })).toEqual({ sub: 'user-1', email: 'u@example.org' });
    for (const [bad, msg] of [
      [{ ...good, iss: 'https://evil' }, /issuer/],
      [{ ...good, aud: 'other' }, /audience/],
      [{ ...good, exp: now / 1000 - 1 }, /expired/],
      [{ ...good, nonce: 'x' }, /nonce/],
    ] as const) {
      await expect(verifyIdToken(await signIdToken(bad), { jwks, clientId: 'oaiapp_1', nonce: 'n', now })).rejects.toThrow(msg);
    }
    const tampered = (await signIdToken(good)).replace(/\.[^.]+\./u, `.${b64url(JSON.stringify({ ...good, sub: 'admin' }))}.`);
    await expect(verifyIdToken(tampered, { jwks, clientId: 'oaiapp_1', nonce: 'n', now })).rejects.toThrow(/signature/);
  });

  test('full sign-in with fake endpoints: credentials stored per client id, plan scope required', async () => {
    const storeFile = `${TMP}store.json`;
    let nonce = '';
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url === SIWC.discovery) return Response.json({ jwks_uri: 'https://auth.example/jwks' });
      if (url === 'https://auth.example/jwks') return Response.json({ keys: [jwk] });
      if (url === SIWC.token) {
        const idToken = await signIdToken({ iss: SIWC.issuer, aud: 'oaiapp_9', exp: Date.now() / 1000 + 600, nonce, sub: 'user-9' });
        expect(new URLSearchParams(String(init?.body)).get('client_id')).toBe('oaiapp_9');
        return Response.json({ access_token: 'acc', refresh_token: 'ref', id_token: idToken, expires_in: 3600, scope: SIWC.scopes });
      }
      return new Response('unexpected', { status: 500 });
    };
    const login = await startPlanLogin({ storeFile, fetch: fetchFn });
    const url = new URL(login.url);
    nonce = url.searchParams.get('nonce') ?? '';
    const cb = new URL(url.searchParams.get('redirect_uri') ?? '');
    expect(cb.hostname).toBe('127.0.0.1');
    const res = await fetch(`${cb.href}?state=${url.searchParams.get('state')}&code=abc&client_id=oaiapp_9`);
    expect(res.status).toBe(200);
    const cred = await login.done;
    expect(cred).toMatchObject({ clientId: 'oaiapp_9', sub: 'user-9', access: 'acc', refresh: 'ref' });
    const store = (await Bun.file(storeFile).json()) as SiwcStoreFile;
    expect(store.active).toBe('oaiapp_9');
    expect(store.hostId).toMatch(/^urn:uuid:/);
  });

  test('provider: scope check, serialized refresh with rotation, responses request shape', async () => {
    const storeFile = `${TMP}provider.json`;
    const now = 1_900_000_000_000;
    const base = { clientId: 'oaiapp_1', hostId: 'urn:uuid:h', sub: 's', idToken: 'i', access: 'old', refresh: 'r1', expires: now - 1, scopes: SIWC.scopes.split(' ') };
    await writeSecret(storeFile, { hostId: 'urn:uuid:h', active: 'oaiapp_1', credentials: { oaiapp_1: base } });
    let refreshes = 0;
    const calls: Array<{ url: string; body: string; auth: string }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
      calls.push({ url, body: String(init?.body ?? ''), auth });
      if (url === SIWC.token) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return Response.json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
      }
      if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'plan-model', visibility: 'list' }] });
      const events = [
        { type: 'response.output_text.delta', delta: '{"answer":"ok"}' },
        { type: 'response.completed', response: { model: 'plan-model', usage: { input_tokens: 1, output_tokens: 1 } } },
      ];
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
    };
    const p = new ChatGptPlanLLM({ storeFile, fetch: fetchFn, now: () => now });
    const [a, b] = await Promise.all([p.credential(), p.credential()]);
    expect(refreshes).toBe(1);
    expect('access' in a && a.access).toBe('new');
    expect('access' in b && b.access).toBe('new');
    expect(((await Bun.file(storeFile).json()) as SiwcStoreFile).credentials.oaiapp_1?.refresh).toBe('r2');
    const r = await p.completeJSON({ system: 's', user: 'u', schema: z.object({ answer: z.string() }), schemaName: 'a', signal: new AbortController().signal });
    expect(r.value).toEqual({ answer: 'ok' });
    const post = calls.find((c) => c.url === 'https://api.openai.com/v1/responses')!;
    expect(post.auth).toBe('Bearer new');
    const body = JSON.parse(post.body);
    expect(body).toMatchObject({ model: 'plan-model', store: false, stream: true });
    for (const forbidden of ['temperature', 'max_output_tokens', 'background', 'metadata', 'user']) expect(body).not.toHaveProperty(forbidden);
    await writeSecret(storeFile, { hostId: 'h', active: 'oaiapp_1', credentials: { oaiapp_1: { ...base, expires: now + 3_600_000, scopes: ['openid'] } } });
    expect(await new ChatGptPlanLLM({ storeFile, fetch: fetchFn, now: () => now }).isAvailable()).toMatchObject({ ok: false });
    expect(await new ChatGptPlanLLM({ storeFile: `${TMP}none.json`, now: () => now }).isAvailable()).toEqual({ ok: false, reason: 'not signed in (Sign in with ChatGPT)' });
  });
});
