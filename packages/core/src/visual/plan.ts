import * as z from 'zod';

/** Plan schema version; part of a future cache key. */
export const VISUAL_PLAN_VERSION = 'heuristic-1';

export const CueActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('reveal'), itemId: z.string().min(1) }),
  z.strictObject({ type: z.literal('showTerm'), term: z.string().min(1) }),
]);

export const CueSchema = z.strictObject({
  anchor: z.strictObject({ sentenceId: z.string().min(1), phrase: z.string().min(1) }),
  action: CueActionSchema,
});

export const ListDiagramSchema = z.strictObject({
  template: z.literal('list'),
  title: z.string().optional(),
  items: z.array(z.strictObject({ id: z.string().min(1), label: z.string().min(1) })).min(1),
});

/**
 * The brief's VisualPlan (§6.2). M1 produces `diagram` (list template), `kinetic` and `none`;
 * `image`, `quote` and `figure` are reserved for later milestones (B9, C7).
 */
export const VisualPlanSchema = z
  .strictObject({
    version: z.string().min(1),
    mode: z.enum(['diagram', 'image', 'kinetic', 'quote', 'figure', 'none']),
    rationale: z.string(),
    keyTerms: z.array(z.string().min(1)),
    cues: z.array(CueSchema),
    diagram: ListDiagramSchema.optional(),
    fallback: z.enum(['kinetic', 'none']),
  })
  .superRefine((plan, ctx) => {
    if (plan.mode === 'diagram' && !plan.diagram) {
      ctx.addIssue({ code: 'custom', path: ['diagram'], message: 'mode diagram needs a diagram' });
    }
    if (plan.mode !== 'diagram' && plan.diagram) {
      ctx.addIssue({ code: 'custom', path: ['diagram'], message: 'diagram only with mode diagram' });
    }
    const items = new Set(plan.diagram?.items.map((i) => i.id) ?? []);
    for (const [k, cue] of plan.cues.entries()) {
      if (cue.action.type === 'reveal' && !items.has(cue.action.itemId)) {
        ctx.addIssue({ code: 'custom', path: ['cues', k, 'action', 'itemId'], message: 'unknown item' });
      }
    }
  });

export type CueAction = z.infer<typeof CueActionSchema>;
export type Cue = z.infer<typeof CueSchema>;
export type ListDiagram = z.infer<typeof ListDiagramSchema>;
export type VisualPlan = z.infer<typeof VisualPlanSchema>;

export interface PlanTextLookup {
  /** Display text of a sentence, or undefined for an unknown ID. */
  sentenceText(sentenceId: string): string | undefined;
  /** Display text of the whole section. */
  sectionText: string;
}

/**
 * Verbatim checks the schema cannot do alone (B9): every cue phrase occurs in its sentence and
 * every key term occurs in the section. Returns the problems (empty when the plan is faithful).
 */
export function planTextProblems(plan: VisualPlan, lookup: PlanTextLookup): string[] {
  const problems: string[] = [];
  for (const [k, cue] of plan.cues.entries()) {
    const text = lookup.sentenceText(cue.anchor.sentenceId);
    if (text === undefined) problems.push(`cue ${k}: unknown sentence ${cue.anchor.sentenceId}`);
    else if (!text.includes(cue.anchor.phrase)) problems.push(`cue ${k}: phrase "${cue.anchor.phrase}" not in sentence`);
  }
  for (const term of plan.keyTerms) {
    if (!lookup.sectionText.includes(term)) problems.push(`key term "${term}" not in section`);
  }
  return problems;
}
