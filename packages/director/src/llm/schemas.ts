import { DIAGRAM_TEMPLATES } from '@lesebuehne/core';
import * as z from 'zod';

/**
 * LLM-facing schemas: strict-friendly (every field required, "absent" = null) so the same schema
 * drives native structured output and validation. Sentences are referenced by alias (`s3`).
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/u);

export const LlmStyleBibleSchema = z.object({
  palette: z.object({ background: hex, ink: hex, accent: hex, accent2: hex, muted: hex }),
  illustrationStyle: z.string().min(10).max(400),
  diagramStyle: z.string().min(10).max(300),
  mood: z.string().min(3).max(200),
  glossary: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        description: z.string().max(200),
        glyph: z.string().min(1).max(4),
        color: hex,
        aliases: z.array(z.string().max(80)).max(4),
      }),
    )
    .max(24),
  chapterSummaries: z.array(z.object({ chapter: z.number().int().min(1), summary: z.string().max(400) })),
});
export type LlmStyleBible = z.infer<typeof LlmStyleBibleSchema>;

const Item = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/u),
  label: z.string().min(1).max(60),
  group: z.string().max(40).nullable(),
  detail: z.string().max(120).nullable(),
});

export const LlmPlanSchema = z.object({
  mode: z.enum(['diagram', 'animation', 'image', 'quote', 'kinetic', 'none']),
  rationale: z.string().min(3).max(300),
  keyTerms: z.array(z.string().min(1).max(60)).max(6),
  cues: z
    .array(
      z.object({
        sentence: z.string().regex(/^s\d+$/u),
        phrase: z.string().min(1).max(80),
        action: z.enum(['reveal', 'highlight', 'showTerm', 'focus']),
        /** Item id (reveal/highlight), term (showTerm) or region id (focus). */
        target: z.string().min(1).max(80),
      }),
    )
    .max(16),
  diagram: z
    .object({
      template: z.enum(DIAGRAM_TEMPLATES),
      title: z.string().max(80).nullable(),
      items: z.array(Item).min(2).max(10),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().max(40).nullable() })).max(12),
    })
    .nullable(),
  quote: z.object({ sentence: z.string().regex(/^s\d+$/u), phrase: z.string().min(8).max(240) }).nullable(),
  image: z
    .object({
      prompt: z.string().min(20).max(800),
      aspect: z.enum(['16:9', '3:2', '4:3', '1:1']),
      focusRegions: z
        .array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/u), label: z.string().max(60), x: z.number(), y: z.number(), w: z.number(), h: z.number() }))
        .max(6),
    })
    .nullable(),
  animation: z.object({ brief: z.string().min(20).max(600) }).nullable(),
  fallback: z.enum(['kinetic', 'none']),
});
export type LlmPlan = z.infer<typeof LlmPlanSchema>;
