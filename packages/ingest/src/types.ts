import type { Asset, ChapterInput } from '@lesebuehne/core';

export type SourceFormat = 'txt' | 'md' | 'epub';

/** What a format reader produces before `assembleBook`. */
export interface ParsedSource {
  format: SourceFormat;
  title: string;
  author?: string;
  /** Book language from the file (EPUB `dc:language`), if any. */
  language?: string;
  chapters: ChapterInput[];
  assets: Asset[];
}
