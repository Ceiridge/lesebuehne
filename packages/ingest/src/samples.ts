import * as z from 'zod';

export const SampleSchema = z.strictObject({
  id: z.string().min(1),
  file: z.string().regex(/^[\w.-]+\.(?:txt|md|epub)$/u),
  title: z.string().min(1),
  author: z.string().min(1),
  /** Fixed language: opening a sample asks nothing (B3, B11). */
  language: z.enum(['de', 'en']),
  format: z.enum(['txt', 'md', 'epub']),
  /** SHA-256 of the derived file (`bun run samples` verifies it). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  provenance: z.strictObject({
    sourceUrl: z.url(),
    edition: z.string().min(1),
    retrieved: z.iso.date(),
    licence: z.string().min(1),
    edits: z.array(z.string().min(1)).min(1),
  }),
});

export const SamplesSchema = z.strictObject({ samples: z.array(SampleSchema).min(1) });

export type Sample = z.infer<typeof SampleSchema>;
export type Samples = z.infer<typeof SamplesSchema>;

export function parseSamples(input: unknown): Samples {
  return SamplesSchema.parse(input);
}
