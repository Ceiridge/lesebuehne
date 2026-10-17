import * as z from 'zod';
import { contentHash } from '../text/hash.ts';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/u);

export const GlossaryConceptSchema = z.strictObject({
  id: z.string().min(1),
  /** Exactly as it appears in the book. */
  label: z.string().min(1),
  description: z.string(),
  /** One symbol (emoji, letter, CJK character or short sign). */
  glyph: z.string().max(4),
  color: hex,
  /** Other verbatim spellings that refer to the same concept. */
  aliases: z.array(z.string()).optional(),
});

/** Per-book Style Bible and glossary (brief §6.1). */
export const StyleBibleSchema = z.strictObject({
  version: z.string(),
  bookId: z.string(),
  palette: z.strictObject({ background: hex, ink: hex, accent: hex, accent2: hex, muted: hex }),
  illustrationStyle: z.string(),
  diagramStyle: z.string(),
  mood: z.string(),
  glossary: z.array(GlossaryConceptSchema),
  /** Director context only; never shown. */
  chapterSummaries: z.array(z.strictObject({ chapterId: z.string(), summary: z.string() })),
  meta: z.strictObject({ providerId: z.string(), model: z.string().optional(), promptVersion: z.string(), createdAt: z.string() }).optional(),
});

export type GlossaryConcept = z.infer<typeof GlossaryConceptSchema>;
export type StyleBible = z.infer<typeof StyleBibleSchema>;

/** Version stamp of a Style Bible's content (part of plan cache keys). */
export function styleBibleVersion(sb: Pick<StyleBible, 'palette' | 'glossary' | 'illustrationStyle' | 'diagramStyle'> | undefined): string {
  if (!sb) return 'none';
  return contentHash(JSON.stringify([sb.palette, sb.glossary, sb.illustrationStyle, sb.diagramStyle])).slice(0, 12);
}

/** Glossary lookup by label/alias (case-insensitive), for stage colours and glyphs. */
export function glossaryIndex(sb: StyleBible | undefined): Map<string, GlossaryConcept> {
  const index = new Map<string, GlossaryConcept>();
  for (const c of sb?.glossary ?? []) {
    for (const name of [c.label, ...(c.aliases ?? [])]) index.set(name.toLowerCase(), c);
  }
  return index;
}

/** The concept a visible label refers to: exact label/alias, else a label contained as a word. */
export function conceptFor(label: string, index: ReadonlyMap<string, GlossaryConcept>): GlossaryConcept | undefined {
  const l = label.toLowerCase();
  const exact = index.get(l);
  if (exact) return exact;
  for (const [name, c] of index) {
    if (name.length >= 4 && new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}([^\\p{L}]|$)`, 'u').test(l)) return c;
  }
  return undefined;
}
