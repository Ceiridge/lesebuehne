import type { BookBundle } from '@lesebuehne/core';
import { formatOf, IngestError, ingestFile, parseFile, toBundle, type IngestErrorCode } from '@lesebuehne/ingest';
import type { ImportOutcome, LibraryService } from '../storage/library.ts';

export type ImportErrorCode = IngestErrorCode | 'generic';

export interface ImportRequest {
  fileName: string;
  bytes: Uint8Array;
  /** Book language for files that name none (TXT, MD, EPUB without `dc:language`). */
  language?: string;
  /** Title (and author) override, e.g. from samples.json. */
  title?: string;
}

export type ImportResult =
  | { ok: true; bundle: BookBundle; outcome: ImportOutcome; basicLanguage: boolean }
  | { ok: false; code: ImportErrorCode };

/** Error code of a thrown value: ingest errors keep theirs; schema failures read as `unreadable`. */
export function errorCode(e: unknown): ImportErrorCode {
  if (e instanceof IngestError) return e.code;
  if (e && typeof e === 'object' && 'issues' in e) return 'unreadable';
  return 'generic';
}

/**
 * Whether the import must ask for the book language (B3): TXT and Markdown always, EPUB only
 * without `dc:language`. A file that cannot be parsed asks nothing (the import then reports the error).
 */
export function needsLanguage(fileName: string, bytes: Uint8Array): boolean {
  const format = formatOf(fileName);
  if (format === undefined) return false;
  if (format !== 'epub') return true;
  try {
    return parseFile(fileName, bytes).language === undefined;
  } catch {
    return false;
  }
}

/**
 * Imports a file into the library (B3, B6): parse, assemble, validate the bundle with its schema
 * before saving (a schema failure stores nothing), then save — or reopen the existing entry for
 * the same book. DRM-protected and unreadable files store nothing.
 */
export async function importBook(library: LibraryService, req: ImportRequest, now = new Date()): Promise<ImportResult> {
  let bundle: BookBundle;
  let basicLanguage = false;
  try {
    const result = ingestFile({
      fileName: req.fileName,
      bytes: req.bytes,
      ...(req.language ? { language: req.language } : {}),
      ...(req.title ? { title: req.title } : {}),
    });
    basicLanguage = result.languageSupport === 'basic';
    bundle = toBundle(result, { fileName: req.fileName, size: req.bytes.length, importedAt: now });
  } catch (e) {
    return { ok: false, code: errorCode(e) };
  }
  try {
    const outcome = await library.import(bundle);
    const stored = outcome.existing ? await library.get(outcome.bookId) : undefined;
    return { ok: true, bundle: stored ?? bundle, outcome, basicLanguage };
  } catch (e) {
    return { ok: false, code: errorCode(e) };
  }
}

export async function fileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}
