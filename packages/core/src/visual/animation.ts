import * as z from 'zod';

/** Maximum size of an animation program's source. */
export const MAX_ANIMATION_CODE = 8000;
/** Largest literal bound a `for` loop may have. */
export const MAX_LOOP_BOUND = 1000;

/**
 * An LLM-written animation (spec 003 B2): the body of `function (lb) { …; return (t) => { … } }`,
 * run only inside the sandboxed iframe with the `lb` library.
 */
export const AnimationProgramSchema = z.strictObject({
  version: z.string(),
  code: z.string().min(1).max(MAX_ANIMATION_CODE),
  notes: z.string().optional(),
  meta: z
    .strictObject({ providerId: z.string(), model: z.string().optional(), promptVersion: z.string(), createdAt: z.string() })
    .optional(),
});
export type AnimationProgram = z.infer<typeof AnimationProgramSchema>;

/** Identifiers a program must not use (defence in depth; the sandbox is the real boundary). */
const FORBIDDEN_WORDS = [
  'eval',
  'Function',
  'import',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'cookie',
  'parent',
  'top',
  'opener',
  'frames',
  'postMessage',
  'setInterval',
  'setTimeout',
  'requestAnimationFrame',
  'queueMicrotask',
  'navigator',
  'location',
  'window',
  'globalThis',
  'self',
  'document',
  'constructor',
  '__proto__',
  'prototype',
  'while',
  'async',
  'await',
] as const;

/** Removes string literals and comments so the checks look at code only. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\/\/[^\n]*/gu, ' ')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/gu, '""')
    .replace(/`(?:\\.|[^`\\])*`/gu, (m) => (m.includes('${') ? m : '""'));
}

/**
 * Static checks of an animation program (spec 003 B2): size, forbidden identifiers, no `do`,
 * `while`, generators or template-literal expressions, `for` loops only with a literal bound.
 * Returns the problems (empty = accepted).
 */
export function animationCodeProblems(code: string): string[] {
  const problems: string[] = [];
  if (code.length > MAX_ANIMATION_CODE) problems.push(`code is longer than ${MAX_ANIMATION_CODE} characters`);
  if (/<\/?script/iu.test(code)) problems.push('code must not contain script tags');
  const src = codeOnly(code);
  if (/`[^`]*\$\{/u.test(src)) problems.push('template literals with ${…} are not allowed; concatenate strings');
  for (const word of FORBIDDEN_WORDS) {
    if (new RegExp(`(?<![\\w$.])${word}(?![\\w$])|\\.${word}(?![\\w$])`, 'u').test(src)) problems.push(`"${word}" is not allowed`);
  }
  if (/(?<![\w$.])do\s*\{/u.test(src)) problems.push('do…while loops are not allowed');
  if (/function\s*\*/u.test(src)) problems.push('generators are not allowed');
  // obj["…"] / obj["a" + "b"]: string-computed member access could reach forbidden names.
  if (/[\w$)\]]\s*\[\s*""/u.test(src)) problems.push('member access with string keys (obj["…"]) is not allowed; use dot access');
  // for loops: only `for (let i = a; i < N; i++)` with a literal N ≤ MAX_LOOP_BOUND, or for…of over arrays.
  const fors = src.matchAll(/(?<![\w$.])for\s*\(([^)]*)\)/gu);
  for (const m of fors) {
    const head = m[1]!;
    if (/\bof\b/u.test(head)) continue;
    const bound = /;\s*[\w$]+\s*<=?\s*(\d+)\s*;/u.exec(head);
    if (!bound || Number(bound[1]) > MAX_LOOP_BOUND) problems.push(`for loops need a literal bound ≤ ${MAX_LOOP_BOUND} (found "for (${head.trim()})")`);
  }
  if (!/\breturn\b/u.test(src)) problems.push('the program must return an update function (t) => { … }');
  return problems;
}
