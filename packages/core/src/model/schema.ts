import * as z from 'zod';

/** Offsets are UTF-16 code units inside the block's `displayText` unless noted otherwise. */
const offset = z.number().int().nonnegative();
const range = z.tuple([offset, offset]);

export const TokenSchema = z.strictObject({
  id: z.string().min(1),
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
  start: offset,
  end: offset,
  wordLike: z.boolean(),
  /** Footnote reference marker (EPUB noteref text): shown, never spoken (D7). */
  noteRef: z.literal(true).optional(),
  /** Markdown only: ordered source ranges whose decoded text concatenates to `text` (D6). */
  src: z.array(range).min(1).optional(),
});

export const FootnoteRefSchema = z.strictObject({
  /** EPUB: the noteref token itself; Markdown: the display token before the reference (D7). */
  tokenId: z.string().min(1),
  footnoteId: z.string().min(1),
  label: z.string(),
});

export const SpeechMapEntrySchema = z.strictObject({ speech: range, display: range });

export const SentenceSchema = z.strictObject({
  id: z.string().min(1),
  /** Display range in the block, without the whitespace that follows the sentence. */
  start: offset,
  end: offset,
  text: z.string(),
  speechText: z.string(),
  speechMap: z.array(SpeechMapEntrySchema),
  /** Estimated seconds at 1.0×. */
  duration: z.number().nonnegative(),
  tokens: z.array(TokenSchema),
  footnoteRefs: z.array(FootnoteRefSchema).optional(),
});

export const MarkSchema = z.strictObject({
  start: offset,
  end: offset,
  kind: z.enum(['em', 'strong', 'code', 'link']),
  href: z.string().optional(),
});

export const BlockKindSchema = z.enum(['heading', 'text', 'list', 'quote', 'figure', 'footnote']);
export type BlockKind = z.infer<typeof BlockKindSchema>;

export const FigureSchema = z.strictObject({
  /** Path of the image in the bundle assets, if the image is available. */
  asset: z.string().optional(),
  /** Image URL for `data:` images in Markdown. */
  dataUrl: z.string().optional(),
  alt: z.string(),
});

export const ParagraphSchema = z.strictObject({
  id: z.string().min(1),
  kind: BlockKindSchema,
  /** Heading level 1–6. */
  level: z.number().int().min(1).max(6).optional(),
  displayText: z.string(),
  sentences: z.array(SentenceSchema),
  marks: z.array(MarkSchema).optional(),
  /** List items as display ranges. */
  items: z.array(range).optional(),
  ordered: z.boolean().optional(),
  /** Footnote blocks: the footnote's ID. */
  footnoteId: z.string().optional(),
  figure: FigureSchema.optional(),
});

export const SectionSchema = z.strictObject({
  id: z.string().min(1),
  paragraphs: z.array(ParagraphSchema),
  /** Estimated seconds at 1.0× of the speech-flow paragraphs. */
  duration: z.number().nonnegative(),
  /** Footnotes whose first reference lies in this section ("at section end" mode). */
  footnoteIds: z.array(z.string()).optional(),
});

export const ChapterSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string(),
  sections: z.array(SectionSchema),
});

export const BookSchema = z.strictObject({
  id: z.string().min(1),
  language: z.string().min(1),
  title: z.string(),
  author: z.string().optional(),
  chapters: z.array(ChapterSchema),
});

export type Token = z.infer<typeof TokenSchema>;
export type FootnoteRef = z.infer<typeof FootnoteRefSchema>;
export type Sentence = z.infer<typeof SentenceSchema>;
export type Mark = z.infer<typeof MarkSchema>;
export type Figure = z.infer<typeof FigureSchema>;
export type Paragraph = z.infer<typeof ParagraphSchema>;
export type Section = z.infer<typeof SectionSchema>;
export type Chapter = z.infer<typeof ChapterSchema>;
export type Book = z.infer<typeof BookSchema>;

/** Kinds that are read aloud and lie on the time axis (figures and footnotes do not, D5). */
export function isFlowKind(kind: BlockKind): boolean {
  return kind !== 'figure' && kind !== 'footnote';
}
