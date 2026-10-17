import * as z from 'zod';

/** Version of the heuristic director's plans; part of the cache key. */
export const VISUAL_PLAN_VERSION = 'heuristic-1';

export const CueActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('reveal'), itemId: z.string().min(1) }),
  z.strictObject({ type: z.literal('highlight'), itemId: z.string().min(1) }),
  z.strictObject({ type: z.literal('showTerm'), term: z.string().min(1) }),
  z.strictObject({ type: z.literal('focus'), regionId: z.string().min(1) }),
  /** Draw the edge between two diagram items. */
  z.strictObject({ type: z.literal('connect'), from: z.string().min(1), to: z.string().min(1) }),
  /** Let an item recede (after the text moved on from it). */
  z.strictObject({ type: z.literal('dim'), itemId: z.string().min(1) }),
]);

export const CueSchema = z.strictObject({
  anchor: z.strictObject({ sentenceId: z.string().min(1), phrase: z.string().min(1) }),
  action: CueActionSchema,
});

/** Diagram templates (brief §6.4). M2 renders every template as a list; M3 adds the others. */
export const DIAGRAM_TEMPLATES = [
  'list',
  'cycle',
  'spectrum',
  'causal-chain',
  'process',
  'hierarchy',
  'comparison',
  'matrix',
  'timeline',
  'venn',
  'network',
  'equation',
] as const;
export type DiagramTemplate = (typeof DIAGRAM_TEMPLATES)[number];

export const DiagramItemSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Column, pole, level or group the item belongs to (template-specific). */
  group: z.string().optional(),
  detail: z.string().optional(),
  /** Glossary concept id, for consistent colour and glyph. */
  conceptId: z.string().optional(),
});

export const DiagramSchema = z.strictObject({
  template: z.enum(DIAGRAM_TEMPLATES),
  title: z.string().optional(),
  items: z.array(DiagramItemSchema).min(1),
  edges: z.array(z.strictObject({ from: z.string().min(1), to: z.string().min(1), label: z.string().optional() })).optional(),
});

/** @deprecated M1 name of the list diagram; kept for compatibility. */
export const ListDiagramSchema = DiagramSchema;

export const QuoteSchema = z.strictObject({ sentenceId: z.string().min(1), phrase: z.string().min(1) });

export const FocusRegionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Normalised rectangle (0…1). */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});

export const ImageSpecSchema = z.strictObject({
  prompt: z.string().min(1),
  aspect: z.enum(['16:9', '3:2', '4:3', '1:1']),
  focusRegions: z.array(FocusRegionSchema),
});

/** Intent for the animation generator (M3); rendered through the fallback until then. */
export const AnimationSpecSchema = z.strictObject({
  brief: z.string().min(1),
});

export const PlanMetaSchema = z.strictObject({
  providerId: z.string(),
  model: z.string().optional(),
  promptVersion: z.string(),
  createdAt: z.string(),
  /** Cues dropped because their anchor was not verbatim in the text. */
  dropped: z.array(z.string()).optional(),
  /** Mode downgraded by the budget or by missing renderers (e.g. `image→kinetic`). */
  downgraded: z.string().optional(),
});

export const VISUAL_MODES = ['diagram', 'animation', 'image', 'kinetic', 'quote', 'figure', 'none'] as const;
export type VisualMode = (typeof VISUAL_MODES)[number];

/**
 * The brief's VisualPlan (§6.2), version 2. The heuristic produces `diagram` (list), `kinetic` and
 * `none`; the LLM director also `quote`, `image` and `animation`.
 */
export const VisualPlanSchema = z
  .strictObject({
    version: z.string().min(1),
    mode: z.enum(VISUAL_MODES),
    rationale: z.string(),
    keyTerms: z.array(z.string().min(1)),
    cues: z.array(CueSchema),
    diagram: DiagramSchema.optional(),
    quote: QuoteSchema.optional(),
    image: ImageSpecSchema.optional(),
    animation: AnimationSpecSchema.optional(),
    fallback: z.enum(['kinetic', 'none']),
    meta: PlanMetaSchema.optional(),
  })
  .superRefine((plan, ctx) => {
    const need = (field: 'diagram' | 'quote' | 'image' | 'animation', mode: VisualMode): void => {
      if (plan.mode === mode && !plan[field]) ctx.addIssue({ code: 'custom', path: [field], message: `mode ${mode} needs ${field}` });
    };
    need('diagram', 'diagram');
    need('quote', 'quote');
    need('image', 'image');
    need('animation', 'animation');
    if (plan.diagram && plan.mode !== 'diagram' && plan.mode !== 'animation') {
      ctx.addIssue({ code: 'custom', path: ['diagram'], message: 'diagram only with mode diagram or animation' });
    }
    const items = new Set(plan.diagram?.items.map((i) => i.id) ?? []);
    const regions = new Set(plan.image?.focusRegions.map((r) => r.id) ?? []);
    for (const [k, cue] of plan.cues.entries()) {
      const a = cue.action;
      if (a.type === 'connect' && (!items.has(a.from) || !items.has(a.to))) {
        ctx.addIssue({ code: 'custom', path: ['cues', k, 'action'], message: 'unknown edge endpoint' });
      }
      if ((a.type === 'reveal' || a.type === 'highlight' || a.type === 'dim') && !items.has(a.itemId)) {
        ctx.addIssue({ code: 'custom', path: ['cues', k, 'action', 'itemId'], message: 'unknown item' });
      }
      if (a.type === 'focus' && !regions.has(a.regionId)) {
        ctx.addIssue({ code: 'custom', path: ['cues', k, 'action', 'regionId'], message: 'unknown region' });
      }
    }
  });

export type CueAction = z.infer<typeof CueActionSchema>;
export type Cue = z.infer<typeof CueSchema>;
export type Diagram = z.infer<typeof DiagramSchema>;
/** @deprecated use `Diagram`. */
export type ListDiagram = Diagram;
export type ImageSpec = z.infer<typeof ImageSpecSchema>;
export type VisualPlan = z.infer<typeof VisualPlanSchema>;

export interface PlanTextLookup {
  /** Display text of a sentence, or undefined for an unknown ID. */
  sentenceText(sentenceId: string): string | undefined;
  /** Display text of the whole section. */
  sectionText: string;
}

/**
 * Verbatim checks the schema cannot do alone (B9, brief §1): cue phrases occur in their sentence,
 * key terms in the section, a quote verbatim in its sentence.
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
  if (plan.quote) {
    const text = lookup.sentenceText(plan.quote.sentenceId);
    if (text === undefined || !text.includes(plan.quote.phrase)) problems.push(`quote "${plan.quote.phrase}" not verbatim in its sentence`);
  }
  return problems;
}
