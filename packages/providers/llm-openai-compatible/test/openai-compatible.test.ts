import { describe, expect, test } from 'bun:test';
import * as z from 'zod';
import { AnthropicCompatibleLLM } from '../../llm-anthropic-compatible/src/index.ts';
import { OpenRouterLLM } from '../../llm-openrouter/src/index.ts';
import { ollama, OpenAICompatibleLLM } from '../src/index.ts';

const Schema = z.object({ answer: z.string() });
const req = { system: 'sys', user: 'hello', schema: Schema, schemaName: 'answer', signal: new AbortController().signal };

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
function fakeFetch(responses: Array<(c: Call) => Response>) {
  const calls: Call[] = [];
  let k = 0;
  const fn = async (url: string, init?: RequestInit) => {
    const c = { url, init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : {} };
    calls.push(c);
    const r = responses[Math.min(k++, responses.length - 1)]!;
    return r(c);
  };
  return { fn, calls };
}
const chat = (content: string, extra: Record<string, unknown> = {}) =>
  Response.json({ model: 'm-1', choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2 }, ...extra });

describe('openai-compatible', () => {
  test('json_schema request shape, key header, usage', async () => {
    const f = fakeFetch([() => chat('{"answer":"ok"}')]);
    const p = new OpenAICompatibleLLM({ id: 'oa', baseURL: 'https://api.example/v1/', model: 'gpt-x', apiKey: 'k-1', fetch: f.fn, requiresKey: true });
    const r = await p.completeJSON(req);
    expect(r).toMatchObject({ value: { answer: 'ok' }, model: 'm-1', usage: { inputTokens: 3, outputTokens: 2 } });
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.example/v1/chat/completions');
    expect((c.init.headers as Record<string, string>).authorization).toBe('Bearer k-1');
    expect(c.body).toMatchObject({ model: 'gpt-x', response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true } } });
    expect((c.body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['system', 'user']);
  });
  test('steps down json_schema → json_object → prompt when the endpoint rejects the format', async () => {
    const f = fakeFetch([
      () => new Response('response_format json_schema not supported', { status: 400 }),
      () => new Response('json_object is not supported by this model', { status: 400 }),
      () => chat('Sure: {"answer":"plain"}'),
    ]);
    const p = new OpenAICompatibleLLM({ id: 'local', baseURL: 'http://127.0.0.1:1234/v1', model: 'llama', fetch: f.fn });
    expect((await p.completeJSON(req)).value).toEqual({ answer: 'plain' });
    expect(f.calls.map((c) => (c.body.response_format as { type?: string } | undefined)?.type ?? 'none')).toEqual(['json_schema', 'json_object', 'none']);
    expect(String((f.calls[2]!.body.messages as Array<{ content: string }>)[0]!.content)).toContain('JSON Schema');
  });
  test('availability: model and key requirements; Ollama preset', async () => {
    expect(await new OpenAICompatibleLLM({ id: 'x', baseURL: 'http://h/v1' }).isAvailable()).toMatchObject({ ok: false });
    expect(await new OpenAICompatibleLLM({ id: 'x', baseURL: 'http://h/v1', model: 'm', requiresKey: true }).isAvailable()).toMatchObject({ ok: false, reason: 'no API key configured' });
    const o = ollama({ model: 'qwen' });
    expect(o.id).toBe('ollama');
    expect(await o.isAvailable()).toEqual({ ok: true });
    expect(o.costHint).toBe('free');
  });
  test('rate limit maps to rate-limit with retryAt', async () => {
    const f = fakeFetch([() => new Response('too many', { status: 429, headers: { 'retry-after': '5' } })]);
    const p = new OpenAICompatibleLLM({ id: 'oa', baseURL: 'http://h/v1', model: 'm', fetch: f.fn });
    await expect(p.completeJSON(req)).rejects.toMatchObject({ code: 'rate-limit' });
  });
});

describe('openrouter', () => {
  test('preset base URL, attribution headers without personal data, cost reporting, daily cap', async () => {
    const f = fakeFetch([() => chat('{"answer":"ok"}', { usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0002 } })]);
    const p = new OpenRouterLLM({ apiKey: 'or-key', model: 'some/model:free', fetch: f.fn, maxCallsPerDay: 1 });
    expect((await p.completeJSON(req)).usage?.cost).toBe(0.0002);
    expect(f.calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(f.calls[0]!.body.usage).toEqual({ include: true });
    expect(await p.isAvailable()).toMatchObject({ ok: false });
    await expect(p.completeJSON(req)).rejects.toMatchObject({ code: 'rate-limit' });
    expect(await new OpenRouterLLM({ model: 'x' }).isAvailable()).toMatchObject({ ok: false, reason: 'no API key configured' });
  });
});

describe('anthropic-compatible', () => {
  test('forced tool call carries the schema; browser header only in browser mode', async () => {
    const f = fakeFetch([() => Response.json({ model: 'claude-x', content: [{ type: 'tool_use', name: 'answer', input: { answer: 'ok' } }], usage: { input_tokens: 4, output_tokens: 3 } })]);
    const p = new AnthropicCompatibleLLM({ apiKey: 'a-key', model: 'claude-x', browser: true, fetch: f.fn });
    expect((await p.completeJSON(req)).value).toEqual({ answer: 'ok' });
    const c = f.calls[0]!;
    const h = c.init.headers as Record<string, string>;
    expect(h['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(h['x-api-key']).toBe('a-key');
    expect(c.body).toMatchObject({ system: 'sys', tool_choice: { type: 'tool', name: 'answer' } });
    expect((c.body.tools as Array<{ input_schema: unknown }>)[0]!.input_schema).toMatchObject({ type: 'object', required: ['answer'] });
  });
});
