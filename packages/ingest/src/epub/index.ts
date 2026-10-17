import type { Asset, ChapterInput } from '@lesebuehne/core';
import { IngestError } from '../errors.ts';
import type { ParsedSource } from '../types.ts';
import { checkDrm, readPackage, text, unzip } from './package.ts';
import { documentBlocks, noteTargets } from './xhtml.ts';

export { checkDrm } from './package.ts';

/**
 * EPUB 2 and 3 (B3): spine order, chapter titles from the nav document or NCX (else the first
 * heading), XHTML structure, footnotes (noteref + target → `FootnoteRef`, D7) and figures (image
 * bytes become assets). DRM-protected books are rejected before anything is read (B3).
 */
export function parseEpub(bytes: Uint8Array, fileName: string): ParsedSource {
  const files = unzip(bytes);
  checkDrm(files);
  const pkg = readPackage(files);
  const targets = noteTargets(files, pkg);
  const assets = new Map<string, Asset>();
  const chapters: ChapterInput[] = [];
  for (const path of pkg.spine) {
    const xhtml = text(files, path);
    if (xhtml === undefined) continue;
    const blocks = documentBlocks(xhtml, path, pkg, files, targets, assets);
    if (blocks.length === 0) continue;
    const title = pkg.toc.get(path) ?? blocks.find((b) => b.kind === 'heading')?.text ?? '';
    chapters.push({ title, blocks });
  }
  if (chapters.length === 0) throw new IngestError('empty', 'The EPUB contains no readable text.');
  return {
    format: 'epub',
    title: pkg.title || fileName.replace(/\.[^.]+$/u, ''),
    ...(pkg.author !== undefined ? { author: pkg.author } : {}),
    ...(pkg.language !== undefined ? { language: pkg.language } : {}),
    chapters,
    assets: [...assets.values()],
  };
}
