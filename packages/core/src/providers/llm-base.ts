import { ProviderError } from './errors.ts';
import { checkAnswer, repairPrompt } from './structured.ts';
import type { LLMRequest, LLMResult, Usage } from './types.ts';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** One raw model call: instructions + conversation → answer text. */
export type RawCall = (turns: ChatTurn[], signal: AbortSignal) => Promise<{ text: string; model: string; usage?: Usage }>;

/**
 * The structured-output loop shared by every LLM provider (B3): ask, validate (JSON → schema →
 * domain checks), and on failure send exactly one repair request with the problems. A second
 * failure is `invalid-output`, so the chain moves on.
 */
export async function completeWithRepair<T>(providerId: string, req: LLMRequest<T>, call: RawCall): Promise<LLMResult<T>> {
  const turns: ChatTurn[] = [{ role: 'user', content: req.user }];
  const usage: Usage = {};
  const add = (u?: Usage): void => {
    if (!u) return;
    usage.inputTokens = (usage.inputTokens ?? 0) + (u.inputTokens ?? 0);
    usage.outputTokens = (usage.outputTokens ?? 0) + (u.outputTokens ?? 0);
    if (u.cost !== undefined) usage.cost = (usage.cost ?? 0) + u.cost;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const answer = await call(turns, req.signal);
    add(answer.usage);
    const checked = checkAnswer(answer.text, req.schema, req.validate);
    if (checked.ok) return { value: checked.value, model: answer.model, usage, repairs: attempt };
    if (attempt === 1) {
      throw new ProviderError(providerId, 'invalid-output', `invalid answer after repair: ${checked.problems.slice(0, 3).join(' | ')}`);
    }
    turns.push({ role: 'assistant', content: answer.text }, { role: 'user', content: repairPrompt(checked.problems) });
  }
  throw new ProviderError(providerId, 'invalid-output', 'unreachable');
}
