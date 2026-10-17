import {
  type BlockInput,
  type BlockKind,
  type ChapterInput,
  type Figure,
  type Mark,
  type NoteRefInput,
} from '@lesebuehne/core';
import type { Nodes, Parent, PhrasingContent, Root, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { decodeString } from 'micromark-util-decode-string';
import { IngestError } from './errors.ts';
import { normalized, TextBuilder, type Range } from './text-builder.ts';
import type { ParsedSource } from './types.ts';

const ENTITY = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/u;

/**
 * Source range of every character of a decoded node value. The value of a text node is shorter
 * than its source when it contains escapes (`\*`), entities (`&amp;`) or container prefixes
 * (`> ` of a block quote line), so the source slice is re-scanned in step with the value.
 */
export function alignValue(source: string, from: number, to: number, value: string): Range[] {
  const out: Range[] = [];
  let si = from;
  for (let vi = 0; vi < value.length; ) {
    const c = value.charAt(vi);
    if (si >= to) {
      out.push([to, to]);
      vi++;
      continue;
    }
    const s = source.charAt(si);
    if (s === c) {
      out.push([si, si + 1]);
      si++;
      vi++;
    } else if (s === '\\' && source.charAt(si + 1) === c) {
      out.push([si, si + 2]);
      si += 2;
      vi++;
    } else if (s === '&') {
      const m = ENTITY.exec(source.slice(si, Math.min(to, si + 40)));
      const decoded = m ? decodeString(m[0]) : '';
      if (m && decoded !== '' && value.startsWith(decoded, vi)) {
        out.push([si, si + m[0].length]);
        for (let k = 1; k < decoded.length; k++) out.push([si + m[0].length, si + m[0].length]);
        si += m[0].length;
        vi += decoded.length;
      } else si++;
    } else si++;
  }
  return out;
}

interface Footnote {
  id: string;
  label: string;
}

function phrasing(nodes: readonly PhrasingContent[], b: TextBuilder, source: string, footnoteLabel: Map<string, Footnote>): void {
  for (const node of nodes) {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    switch (node.type) {
      case 'text':
        b.push(node.value, alignValue(source, start, end, node.value));
        break;
      case 'inlineCode': {
        const from = b.text.length;
        const inner = source.indexOf(node.value, start);
        const base = inner >= 0 && inner < end ? inner : start;
        b.push(node.value, alignValue(source, base, end, node.value));
        b.marks.push({ start: from, end: b.text.length, kind: 'code' });
        break;
      }
      case 'emphasis':
      case 'strong':
      case 'delete': {
        const from = b.text.length;
        phrasing(node.children, b, source, footnoteLabel);
        if (node.type !== 'delete') b.marks.push({ start: from, end: b.text.length, kind: node.type === 'emphasis' ? 'em' : 'strong' });
        break;
      }
      case 'link':
      case 'linkReference': {
        const from = b.text.length;
        phrasing(node.children, b, source, footnoteLabel);
        if (node.type === 'link') b.marks.push({ start: from, end: b.text.length, kind: 'link', href: node.url });
        break;
      }
      case 'image':
      case 'imageReference': {
        const alt = node.alt ?? '';
        b.push(alt, alignValue(source, start + 2, end, alt));
        break;
      }
      case 'break':
        b.space(start);
        break;
      case 'footnoteReference': {
        const fn = footnoteLabel.get(node.identifier);
        b.noteRefs.push({
          at: b.text.length,
          length: 0,
          footnoteId: fn?.id ?? `fn:${node.identifier}`,
          label: fn?.label ?? node.label ?? node.identifier,
        });
        break;
      }
      case 'html':
        break; // text layer: HTML tags removed
      default:
        break;
    }
  }
}

function toBlock(kind: BlockKind, b: TextBuilder, extra: Partial<BlockInput> = {}): BlockInput {
  const n = normalized(b);
  return {
    kind,
    text: n.text,
    charSources: n.sources,
    ...(n.marks.length > 0 ? { marks: n.marks } : {}),
    ...(n.noteRefs.length > 0 ? { noteRefs: n.noteRefs } : {}),
    ...extra,
  };
}

/** All inline content below a node, paragraphs separated by a space. */
function collect(node: Nodes, b: TextBuilder, source: string, footnotes: Map<string, Footnote>): void {
  if (node.type === 'paragraph' || node.type === 'heading') {
    if (b.text !== '') b.space(node.position?.start.offset ?? 0);
    phrasing(node.children, b, source, footnotes);
    return;
  }
  if (node.type === 'code' || node.type === 'inlineCode') {
    if (b.text !== '') b.space(node.position?.start.offset ?? 0);
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    const inner = source.indexOf(node.value, start);
    b.push(node.value, alignValue(source, inner >= 0 ? inner : start, end, node.value));
    return;
  }
  if ('children' in node) for (const child of (node as Parent).children) collect(child as Nodes, b, source, footnotes);
}

function figureOf(node: PhrasingContent): Figure | undefined {
  if (node.type !== 'image') return undefined;
  const alt = node.alt ?? '';
  return node.url.startsWith('data:') ? { alt, dataUrl: node.url } : { alt };
}

function blocksOf(node: RootContent, source: string, footnotes: Map<string, Footnote>): BlockInput[] {
  switch (node.type) {
    case 'heading': {
      const b = new TextBuilder();
      phrasing(node.children, b, source, footnotes);
      return [toBlock('heading', b, { level: node.depth })];
    }
    case 'paragraph': {
      const visible = node.children.filter((c) => !(c.type === 'text' && c.value.trim() === ''));
      const only = visible.length === 1 ? visible[0] : undefined;
      const figure = only ? figureOf(only) : undefined;
      const b = new TextBuilder();
      phrasing(node.children, b, source, footnotes);
      return [toBlock(figure ? 'figure' : 'text', b, figure ? { figure } : {})];
    }
    case 'list': {
      // Items are normalised one by one and joined by a space; sentences never cross an item.
      let text = '';
      const sources: Range[] = [];
      const marks: Mark[] = [];
      const noteRefs: NoteRefInput[] = [];
      const items: Array<[number, number]> = [];
      for (const item of node.children) {
        const inner = new TextBuilder();
        collect(item, inner, source, footnotes);
        const n = normalized(inner);
        if (n.text === '') continue;
        if (text !== '') {
          const at = item.position?.start.offset ?? 0;
          text += ' ';
          sources.push([at, at]);
        }
        const from = text.length;
        text += n.text;
        sources.push(...n.sources);
        marks.push(...n.marks.map((m) => ({ ...m, start: m.start + from, end: m.end + from })));
        noteRefs.push(...n.noteRefs.map((r) => ({ ...r, at: r.at + from })));
        items.push([from, text.length]);
      }
      return [
        {
          kind: 'list',
          text,
          charSources: sources,
          items,
          ordered: node.ordered === true,
          ...(marks.length > 0 ? { marks } : {}),
          ...(noteRefs.length > 0 ? { noteRefs } : {}),
        },
      ];
    }
    case 'blockquote': {
      const b = new TextBuilder();
      collect(node, b, source, footnotes);
      return [toBlock('quote', b)];
    }
    case 'footnoteDefinition': {
      const fn = footnotes.get(node.identifier);
      const b = new TextBuilder();
      collect(node, b, source, footnotes);
      return [toBlock('footnote', b, { footnoteId: fn?.id ?? `fn:${node.identifier}` })];
    }
    case 'code': {
      const b = new TextBuilder();
      collect(node, b, source, footnotes);
      return [toBlock('text', b)];
    }
    default:
      return []; // html, thematicBreak, definition: not in the text layer
  }
}

/**
 * Markdown (CommonMark + footnotes): headings, emphasis, lists, block quotes, footnotes and images
 * (B3). Chapters split at the smallest heading depth present. Every display character keeps its
 * source range (D6); footnote references attach to the token before them (D7).
 */
export function parseMarkdown(source: string, fileName: string): ParsedSource {
  if (source.trim() === '') throw new IngestError('empty', 'The file contains no text.');
  const tree: Root = fromMarkdown(source, {
    extensions: [gfmFootnote()],
    mdastExtensions: [gfmFootnoteFromMarkdown()],
  });

  const footnotes = new Map<string, Footnote>();
  for (const node of tree.children) {
    if (node.type === 'footnoteDefinition') {
      footnotes.set(node.identifier, { id: `fn:${node.identifier}`, label: node.label ?? node.identifier });
    }
  }

  const blocks = tree.children.flatMap((n) => blocksOf(n, source, footnotes)).filter((b) => b.text !== '' || b.kind === 'figure');
  if (blocks.length === 0) throw new IngestError('empty', 'The file contains no text.');

  const depths = blocks.filter((b) => b.kind === 'heading').map((b) => b.level ?? 1);
  const chapterDepth = depths.length > 0 ? Math.min(...depths) : 0;
  const chapters: ChapterInput[] = [];
  let current: ChapterInput | undefined;
  for (const block of blocks) {
    if ((block.kind === 'heading' && block.level === chapterDepth) || !current) {
      current = { blocks: [] };
      chapters.push(current);
    }
    current.blocks.push(block);
  }
  const firstHeading = blocks.find((b) => b.kind === 'heading');
  return {
    format: 'md',
    title: firstHeading?.text ?? fileName.replace(/\.[^.]+$/u, ''),
    chapters,
    assets: [],
  };
}
