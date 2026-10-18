import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as z from 'zod';

/** The reader's choice for one text provider, set in Settings → Connect AI. */
export const LlmChoiceSchema = z.object({
  /** A model id, or `auto` / absent for the configured model. */
  model: z.string().min(1).max(200).optional(),
  /** `auto` (by task, the default), `default` (the model's own default) or a level. */
  reasoning: z.string().min(1).max(40).optional(),
  /** `default` / absent (standard) or a catalog tier id (`priority` = fast, `flex`). */
  serviceTier: z.string().min(1).max(40).optional(),
});
export type LlmChoice = z.infer<typeof LlmChoiceSchema>;

/** Per-provider model choices, kept in the data directory (`llm-settings.json`). */
export class LlmSettings {
  private choices: Record<string, LlmChoice> = {};

  constructor(private readonly file: string) {
    try {
      if (existsSync(file)) {
        const parsed = z.record(z.string(), LlmChoiceSchema).safeParse(JSON.parse(readFileSync(file, 'utf8')));
        if (parsed.success) this.choices = parsed.data;
      }
    } catch {
      // A broken file means no choices; the next save rewrites it.
    }
  }

  get(providerId: string): LlmChoice {
    return this.choices[providerId] ?? {};
  }

  async set(providerId: string, choice: LlmChoice): Promise<LlmChoice> {
    const clean = Object.fromEntries(Object.entries(choice).filter(([, v]) => v !== undefined && v !== '')) as LlmChoice;
    this.choices = { ...this.choices, [providerId]: clean };
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(this.choices, null, 2)}\n`, { mode: 0o600 });
    return clean;
  }

  /** Request options for one task: the chosen model (else `configured`), reasoning and tier. */
  options(providerId: string, configured: string | undefined): { model?: string; reasoningEffort?: string; serviceTier?: string } {
    const c = this.get(providerId);
    const model = c.model && c.model !== 'auto' ? c.model : configured;
    const reasoning = c.reasoning ?? 'auto';
    return {
      ...(model ? { model } : {}),
      ...(reasoning !== 'default' ? { reasoningEffort: reasoning } : {}),
      ...(c.serviceTier && c.serviceTier !== 'default' ? { serviceTier: c.serviceTier } : {}),
    };
  }
}
