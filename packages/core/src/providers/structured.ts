import * as z from 'zod';

/**
 * JSON Schema for native structured output (OpenAI strict mode, Anthropic tool input). The LLM
 * schemas are designed "strict-friendly": every property required, optional values nullable.
 */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'output', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  assertStrict(json, '#');
  return json;
}

function assertStrict(node: unknown, path: string): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.type === 'object' && n.properties && typeof n.properties === 'object') {
    const keys = Object.keys(n.properties as object);
    const required = new Set((n.required as string[] | undefined) ?? []);
    const missing = keys.filter((k) => !required.has(k));
    if (missing.length > 0) throw new Error(`schema not strict-friendly at ${path}: optional ${missing.join(', ')} (use nullable)`);
    n.additionalProperties = false;
    for (const [k, v] of Object.entries(n.properties as object)) assertStrict(v, `${path}/${k}`);
  }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) {
    const v = n[key];
    if (Array.isArray(v)) v.forEach((x, i) => assertStrict(x, `${path}/${key}/${i}`));
    else if (v) assertStrict(v, `${path}/${key}`);
  }
}

/** Extracts the first JSON object from model text (code fences, leading prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new SyntaxError('no JSON object in the answer');
  }
}

export type Checked<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/** Parses and validates one answer: JSON, then the zod schema, then the domain checks. */
export function checkAnswer<T>(text: string, schema: z.ZodType<T>, validate?: (value: T) => string[]): Checked<T> {
  let data: unknown;
  try {
    data = extractJson(text);
  } catch (e) {
    return { ok: false, problems: [`Not valid JSON: ${(e as Error).message}`] };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 12).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  const problems = validate?.(parsed.data) ?? [];
  return problems.length > 0 ? { ok: false, problems: problems.slice(0, 12) } : { ok: true, value: parsed.data };
}

/** The repair instruction sent with the previous answer (brief §6.2: one repair attempt). */
export function repairPrompt(problems: readonly string[]): string {
  return [
    'Your previous answer was not accepted. Problems:',
    ...problems.map((p) => `- ${p}`),
    'Answer again with the complete JSON object only, fixing every problem. Quote phrases from the text exactly, character for character.',
  ].join('\n');
}

/** Schema description for providers without native structured output (prompt-only mode). */
export function schemaInstruction(schema: z.ZodType, name: string): string {
  return `Answer with one JSON object named "${name}" that matches this JSON Schema exactly, and nothing else:\n${JSON.stringify(jsonSchemaOf(schema))}`;
}
