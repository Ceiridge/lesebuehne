import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { stat } from 'node:fs/promises';
import * as z from 'zod';
import { codexAuthorizeUrl, codexCliSource, CodexAuthLLM, defaultPaths, openCodeSource, ownSource, type TokenSource } from '../src/index.ts';

const TMP = Bun.fileURLToPath(new URL(`../../../../out/tmp/codex-${crypto.randomUUID()}/`, import.meta.url));
afterAll(async () => {
  await Bun.$`rm -rf ${TMP}`.quiet().nothrow();
});

const NOW = 1_800_000_000_000;
const jwt = (claims: Record<string, unknown>) => `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify(claims)).replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_')}.sig`;
const fixed = (token: { access: string; accountId: string; expires: number } | undefined, id: TokenSource['id'] = 'opencode', readOnly = true): TokenSource => ({
  id,
  label: id,
  readOnly,
  load: async () => token,
});

function sse(events: unknown[]): Response {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('codex-auth: token sources', () => {
  test('OpenCode: credential DB first (read-only), legacy auth.json as fallback; files untouched', async () => {
    const dir = `${TMP}opencode`;
    await Bun.write(`${dir}/auth.json`, JSON.stringify({ openai: { type: 'oauth', access: 'legacy-access', expires: NOW + 10_000_000, accountId: 'acc-legacy' } }));
    const legacyOnly = await openCodeSource(dir).load();
    expect(legacyOnly).toMatchObject({ access: 'legacy-access', accountId: 'acc-legacy' });

    const db = new Database(`${dir}/opencode.db`, { create: true });
    db.run('create table credential (id text, integration_id text, label text, value text, connector_id text, method_id text, active integer, time_created integer, time_updated integer)');
    db.run("insert into credential values ('1','opencode-go',null,'{\"type\":\"api\",\"key\":\"x\"}',null,null,null,0,0)");
    db.run(
      "insert into credential values ('2','openai',null,?,null,null,1,0,5)",
      [JSON.stringify({ type: 'oauth', methodID: 'chatgpt-headless', access: 'db-access', refresh: 'r', expires: NOW + 10_000_000, metadata: { accountID: 'acc-db' } })],
    );
    db.close();
    const before = await stat(`${dir}/opencode.db`);
    expect(await openCodeSource(dir).load()).toEqual({ access: 'db-access', accountId: 'acc-db', expires: NOW + 10_000_000 });
    const after = await stat(`${dir}/opencode.db`);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(openCodeSource(dir).readOnly).toBe(true);
    expect(openCodeSource(dir).refresh).toBeUndefined();
  });

  test('Codex CLI auth.json: account id from the file or the id token, expiry from the JWT', async () => {
    const home = `${TMP}codex`;
    await Bun.write(`${home}/auth.json`, JSON.stringify({ tokens: { access_token: jwt({ exp: NOW / 1000 + 3600 }), id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-cli' } }) } }));
    expect(await codexCliSource(home).load()).toMatchObject({ accountId: 'acc-cli', expires: NOW + 3_600_000 });
    expect(await codexCliSource(`${TMP}missing`).load()).toBeUndefined();
  });

  test('default paths come from the environment, never hard-coded', () => {
    expect(defaultPaths({ HOME: '/h' })).toEqual({ opencodeData: '/h/.local/share/opencode', codexHome: '/h/.codex' });
    expect(defaultPaths({ USERPROFILE: 'C:/U', XDG_DATA_HOME: 'D:/data', CODEX_HOME: 'E:/cx' })).toEqual({ opencodeData: 'D:/data/opencode', codexHome: 'E:/cx' });
  });

  test('order: first valid token wins; expired read-only tokens are reported, never refreshed', async () => {
    const expired = { access: 'a', accountId: 'x', expires: NOW - 1 };
    const valid = { access: 'b', accountId: 'y', expires: NOW + 600_000 };
    const p = new CodexAuthLLM({ sources: [fixed(expired, 'opencode'), fixed(undefined, 'codex-cli'), fixed(valid, 'own', false)], now: () => NOW });
    const t = await p.token();
    expect('token' in t && t.token.access).toBe('b');
    expect(p.lastSource).toBe('own');
    const none = new CodexAuthLLM({ sources: [fixed(expired, 'opencode')], now: () => NOW });
    expect(await none.isAvailable()).toEqual({ ok: false, reason: 'opencode: token expired — open OpenCode once to renew it' });
    expect(await new CodexAuthLLM({ sources: [], now: () => NOW }).isAvailable()).toMatchObject({ ok: false });
  });

  test('own sign-in: expired token refreshed once (serialized), rotated token written atomically to our file only', async () => {
    const file = `${TMP}own/codex-auth.json`;
    await Bun.write(file, JSON.stringify({ access: 'old', refresh: 'r1', expires: Date.now() - 1000, accountId: 'acc-own' }));
    let refreshes = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      refreshes++;
      expect(String(init?.body)).toContain('grant_type=refresh_token');
      expect(String(init?.body)).toContain('refresh_token=r1');
      await new Promise((r) => setTimeout(r, 10));
      return Response.json({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 });
    }) as typeof fetch;
    const src = ownSource(file, { fetch: fetchFn });
    const [a, b] = await Promise.all([src.refresh!(), src.refresh!()]);
    expect(refreshes).toBe(1);
    expect(a?.access).toBe('new');
    expect(b?.access).toBe('new');
    expect(await Bun.file(file).json()).toMatchObject({ access: 'new', refresh: 'r2', accountId: 'acc-own' });
  });

  test('Codex-style authorize URL', () => {
    const u = new URL(codexAuthorizeUrl({ challenge: 'c', state: 's' }));
    expect(u.origin + u.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', code_challenge: 'c', code_challenge_method: 'S256', state: 's', scope: 'openid profile email offline_access' });
  });
});

describe('codex-auth: requests like OpenCode', () => {
  const token = { access: 'tok', accountId: 'acc-1', expires: NOW + 3_600_000 };
  const Schema = z.object({ answer: z.string() });
  const req = { system: 'be brief', user: 'say ok', schema: Schema, schemaName: 'probe', signal: new AbortController().signal };

  test('model list (auto), responses request shape, SSE deltas, usage', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes('/models')) return Response.json({ models: [{ slug: 'hidden', visibility: 'hide' }, { slug: 'model-a', visibility: 'list' }] });
      return sse([
        { type: 'response.created' },
        { type: 'response.output_text.delta', delta: '{"answer":' },
        { type: 'response.output_text.delta', delta: '"OK"}' },
        { type: 'response.completed', response: { model: 'model-a', usage: { input_tokens: 44, output_tokens: 12 } } },
      ]);
    };
    const p = new CodexAuthLLM({ sources: [fixed(token)], fetch: fetchFn, now: () => NOW });
    const r = await p.completeJSON(req);
    expect(r).toMatchObject({ value: { answer: 'OK' }, model: 'model-a', usage: { inputTokens: 44, outputTokens: 12 } });
    expect(calls[0]!.url).toMatch(/\/backend-api\/codex\/models\?client_version=/);
    const post = calls[1]!;
    expect(post.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const h = post.init!.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer tok');
    expect(h['chatgpt-account-id']).toBe('acc-1');
    expect(h['session-id']).toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.parse(String(post.init!.body));
    expect(body).toMatchObject({ model: 'model-a', instructions: 'be brief', store: false, stream: true, text: { format: { type: 'json_schema', strict: true, name: 'probe' } } });
    expect(body.input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'say ok' }] });
  });

  test('backend errors: unsupported model → bad-request, usage limit → rate-limit', async () => {
    const reject = new CodexAuthLLM({
      sources: [fixed(token)],
      model: 'gpt-old',
      now: () => NOW,
      fetch: async () => Response.json({ detail: "The 'gpt-old' model is not supported when using Codex with a ChatGPT account." }, { status: 400 }),
    });
    await expect(reject.completeJSON(req)).rejects.toMatchObject({ code: 'bad-request' });
    const limited = new CodexAuthLLM({
      sources: [fixed(token)],
      model: 'm',
      now: () => NOW,
      fetch: async () => sse([{ type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'You have hit your usage limit' } } }]),
    });
    await expect(limited.completeJSON(req)).rejects.toMatchObject({ code: 'rate-limit' });
  });
});

describe('M5: codex-image', () => {
  test('image_generation tool request; picture from output_item.done; style reference attached', async () => {
    const { CodexImageProvider } = await import('../src/index.ts');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const bodies: Array<Record<string, any>> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes('/models')) return Response.json({ models: [{ slug: 'm-fast', visibility: 'list' }] });
      bodies.push(JSON.parse(String(init?.body)));
      const events = [
        { type: 'response.image_generation_call.generating' },
        { type: 'response.output_item.done', item: { type: 'image_generation_call', result: btoa(String.fromCharCode(...png)) } },
        { type: 'response.completed', response: {} },
      ];
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
    const auth = new CodexAuthLLM({ sources: [fixed({ access: 'a', accountId: 'acc', expires: NOW + 10_000_000 })], fetch: fetchFn, now: () => NOW });
    const img = new CodexImageProvider(auth, { fetch: fetchFn });
    const r = await img.generate({ prompt: 'a castle', size: '1536x1024', styleRef: png, signal: new AbortController().signal });
    expect([...r.image]).toEqual([...png]);
    expect(bodies[0]!.model).toBe('m-fast');
    expect(bodies[0]!.tools).toEqual([{ type: 'image_generation', output_format: 'png', size: '1536x1024' }]);
    expect(bodies[0]!.tool_choice).toBe('required');
    expect(bodies[0]!.input[0].content[0].type).toBe('input_image');
    expect(bodies[0]!.store).toBe(false);
    const failing = new CodexImageProvider(auth, {
      model: 'x',
      fetch: async () => new Response(`data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'usage limit reached' } } })}\n\n`),
    });
    await expect(failing.generate({ prompt: 'p', size: '1024x1024', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'rate-limit' });
  });
});
