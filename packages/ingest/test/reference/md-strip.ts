/**
 * Test-only reference for the Markdown text layer (B2): a regex/line stripper that removes
 * syntax markers. It deliberately shares no code with the ingest module and uses no Markdown
 * parser, so the fidelity check compares two independent derivations.
 */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', szlig: 'ß', auml: 'ä', ouml: 'ö', uuml: 'ü' };

function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[A-Za-z]+);/g, (m, e: string) => {
    if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

function stripInline(line: string): string {
  return decodeEntities(
    line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image → alt
      .replace(/\[\^[^\]]+\]/g, '') // footnote reference
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // link → text
      .replace(/<[^>]+>/g, '') // HTML tags
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\\([!-/:-@[-`{-~])/g, '\u0000$1') // protect escaped punctuation
      .replace(/(\*\*|__|\*|_)/g, '')
      .replace(/\u0000/g, ''),
  );
}

export function stripMarkdown(source: string): string {
  return source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      /^\s{0,3}#{1,6}\s+/.test(line)
        ? line.replace(/^\s{0,3}#{1,6}\s+/, '')
        : line
        .replace(/^(\s*>\s?)+/, '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .replace(/^\[\^[^\]]+\]:\s*/, ''),
    )
    .map(stripInline)
    .join('\n');
}

/** Word-like segments in order (`Intl.Segmenter`, granularity word). */
export function words(text: string, lang: string): string[] {
  const out: string[] = [];
  for (const s of new Intl.Segmenter(lang, { granularity: 'word' }).segment(text)) if (s.isWordLike) out.push(s.segment);
  return out;
}
