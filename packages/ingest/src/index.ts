/** @lesebuehne/ingest: TXT, Markdown and EPUB import. */
import {
  assembleBook,
  BookBundleSchema,
  BUNDLE_SCHEMA_VERSION,
  primaryLanguage,
  type Book,
  type BookBundle,
  type Lexicon,
} from '@lesebuehne/core';
import { decodeUtf8, IngestError } from './errors.ts';
import { parseEpub } from './epub/index.ts';
import { parseMarkdown } from './markdown.ts';
import { parseTxt } from './txt.ts';
import type { ParsedSource, SourceFormat } from './types.ts';

export { IngestError, decodeUtf8, type IngestErrorCode } from './errors.ts';
export { isTxtHeading, parseTxt } from './txt.ts';
export { alignValue, parseMarkdown } from './markdown.ts';
export { checkDrm, parseEpub } from './epub/index.ts';
export { parseSamples, SampleSchema, SamplesSchema, type Sample, type Samples } from './samples.ts';
export type { ParsedSource, SourceFormat } from './types.ts';

export function formatOf(fileName: string): SourceFormat | undefined {
  const ext = /\.([^.]+)$/u.exec(fileName.toLowerCase())?.[1];
  if (ext === 'txt' || ext === 'text') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'epub') return 'epub';
  return undefined;
}

export interface IngestInput {
  fileName: string;
  bytes: Uint8Array;
  /** Language for TXT/MD and EPUB without `dc:language` (default `de`). */
  language?: string;
  /** Title to use instead of the one read from the file (samples carry theirs in samples.json). */
  title?: string;
  lexicon?: Lexicon;
}

export interface IngestResult {
  format: SourceFormat;
  book: Book;
  languageSupport: 'full' | 'basic';
  /** The file names no language: the import asks for one (`language`, default German). */
  needsLanguage: boolean;
  parsed: ParsedSource;
}

export const SUPPORTED_LANGUAGES = ['de', 'en'] as const;

/** Parses a file (B3). Throws `IngestError` with a code the player maps to a message. */
export function parseFile(fileName: string, bytes: Uint8Array): ParsedSource {
  const format = formatOf(fileName);
  if (format === undefined) throw new IngestError('unsupported', `Unsupported file type: ${fileName}`);
  if (bytes.length === 0) throw new IngestError('empty', 'The file is empty.');
  if (format === 'epub') return parseEpub(bytes, fileName);
  const text = decodeUtf8(bytes);
  return format === 'txt' ? parseTxt(text, fileName) : parseMarkdown(text, fileName);
}

export function ingestFile(input: IngestInput): IngestResult {
  const parsed = parseFile(input.fileName, input.bytes);
  const language = parsed.language ?? input.language ?? 'de';
  const book = assembleBook({
    language,
    title: input.title ?? parsed.title,
    ...(parsed.author !== undefined ? { author: parsed.author } : {}),
    chapters: parsed.chapters,
    ...(input.lexicon ? { lexicon: input.lexicon } : {}),
  });
  if (book.chapters.every((c) => c.sections.length === 0)) throw new IngestError('empty', 'The file contains no text.');
  const supported = (SUPPORTED_LANGUAGES as readonly string[]).includes(primaryLanguage(language));
  return {
    format: parsed.format,
    book,
    languageSupport: supported ? 'full' : 'basic',
    needsLanguage: parsed.language === undefined,
    parsed,
  };
}

/** The validated bundle of an ingested file (B6); throws if the bundle does not validate. */
export function toBundle(result: IngestResult, source: { fileName: string; size: number; importedAt: Date }): BookBundle {
  return BookBundleSchema.parse({
    manifest: {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      bookId: result.book.id,
      title: result.book.title,
      ...(result.book.author !== undefined ? { author: result.book.author } : {}),
      language: result.book.language,
      languageSupport: result.languageSupport,
      format: result.format,
      source: { fileName: source.fileName, size: source.size },
      importedAt: source.importedAt.toISOString(),
      assets: result.parsed.assets.map((a) => ({ path: a.path, mediaType: a.mediaType })),
    },
    book: result.book,
    assets: result.parsed.assets,
  });
}
