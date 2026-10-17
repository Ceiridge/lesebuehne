import type { Asset, BlockInput, BlockKind } from '@lesebuehne/core';
import type { ChildNode, Element } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { normalized, TextBuilder } from '../text-builder.ts';
import { findAll, resolvePath, textOf, type EpubPackage, type Files } from './package.ts';

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const TEXT_BLOCKS = new Set(['p', 'pre', 'dt', 'dd', 'caption', 'figcaption', 'address']);
const CONTAINERS = new Set([
  'body', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'table', 'thead', 'tbody',
  'tfoot', 'tr', 'td', 'th', 'dl', 'hgroup', 'center',
]);
const SKIP = new Set(['script', 'style', 'head', 'title', 'template', 'svg', 'math']);
const NOTE_TYPES = ['footnote', 'endnote', 'rearnote', 'note'];

/** Every element that starts a block (the fidelity walk separates text at these). */
export const BLOCK_ELEMENTS = new Set([
  ...HEADINGS, ...TEXT_BLOCKS, ...CONTAINERS, 'ul', 'ol', 'li', 'blockquote', 'figure', 'hr', 'img',
]);

const local = (el: Element): string => el.name.toLowerCase();
const types = (el: Element): string[] => (el.attribs['epub:type'] ?? el.attribs.role ?? '').toLowerCase().split(/\s+/u);
const isTag = (n: ChildNode): n is Element => n.type === 'tag' || n.type === 'script' || n.type === 'style';

function isNoteRef(el: Element): boolean {
  return local(el) === 'a' && types(el).some((t) => t === 'noteref' || t === 'doc-noteref');
}

export function xhtmlDocument(xhtml: string) {
  return parseDocument(xhtml, { recognizeSelfClosing: true, lowerCaseTags: false, lowerCaseAttributeNames: false });
}

/** IDs targeted by noteref links (`path#id`), so plain `aside`s become footnotes too. */
export function noteTargets(files: Files, pkg: EpubPackage): Set<string> {
  const targets = new Set<string>();
  for (const path of pkg.spine) {
    const bytes = files[path];
    if (!bytes) continue;
    for (const a of findAll(xhtmlDocument(new TextDecoder().decode(bytes)), 'a')) {
      if (!isNoteRef(a)) continue;
      const href = a.attribs.href ?? '';
      const fragment = href.split('#')[1];
      if (fragment) targets.add(`${href.startsWith('#') ? path : resolvePath(path, href)}#${fragment}`);
    }
  }
  return targets;
}

interface Context {
  path: string;
  pkg: EpubPackage;
  files: Files;
  targets: Set<string>;
  assets: Map<string, Asset>;
}

function hasBlockChild(el: Element): boolean {
  return el.children.some((c) => isTag(c) && BLOCK_ELEMENTS.has(local(c)));
}

function isFootnote(el: Element, ctx: Context): boolean {
  if (types(el).some((t) => NOTE_TYPES.includes(t) || t === 'doc-footnote' || t === 'doc-endnote')) return true;
  const id = el.attribs.id;
  return id !== undefined && ctx.targets.has(`${ctx.path}#${id}`);
}

function addAsset(img: Element, ctx: Context): string | undefined {
  const src = img.attribs.src ?? img.attribs['xlink:href'];
  if (!src || src.startsWith('data:') || /^[a-z]+:/iu.test(src)) return undefined;
  const path = resolvePath(ctx.path, src);
  const bytes = ctx.files[path];
  if (!bytes) return undefined;
  const mediaType = ctx.pkg.byPath.get(path)?.mediaType ?? 'application/octet-stream';
  if (!ctx.assets.has(path)) ctx.assets.set(path, { path, mediaType, bytes: new Uint8Array(bytes) });
  return path;
}

function inline(nodes: readonly ChildNode[], b: TextBuilder, ctx: Context, images: Element[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      b.add(node.data);
      continue;
    }
    if (!isTag(node)) continue;
    const name = local(node);
    if (SKIP.has(name)) continue;
    if (name === 'br') {
      b.space();
      continue;
    }
    if (name === 'img') {
      images.push(node);
      continue;
    }
    if (isNoteRef(node)) {
      const label = textOf(node);
      const href = node.attribs.href ?? '';
      const fragment = href.split('#')[1] ?? '';
      const target = `${href.startsWith('#') ? ctx.path : resolvePath(ctx.path, href)}#${fragment}`;
      b.noteRefs.push({ at: b.text.length, length: label.length, footnoteId: `fn:${target}`, label: label.trim() });
      b.add(label);
      continue;
    }
    const block = BLOCK_ELEMENTS.has(name);
    if (block) b.space();
    const from = b.text.length;
    inline(node.children, b, ctx, images);
    const kind =
      name === 'em' || name === 'i' || name === 'cite' ? 'em' : name === 'strong' || name === 'b' ? 'strong' : name === 'code' ? 'code' : name === 'a' ? 'link' : undefined;
    if (kind) b.marks.push({ start: from, end: b.text.length, kind, ...(kind === 'link' && node.attribs.href ? { href: node.attribs.href } : {}) });
    if (block) b.space();
  }
}

function block(kind: BlockKind, b: TextBuilder, extra: Partial<BlockInput> = {}): BlockInput {
  const n = normalized(b);
  return {
    kind,
    text: n.text,
    ...(n.marks.length > 0 ? { marks: n.marks } : {}),
    ...(n.noteRefs.length > 0 ? { noteRefs: n.noteRefs } : {}),
    ...extra,
  };
}

function figureBlocks(images: Element[], ctx: Context): BlockInput[] {
  return images.map((img) => {
    const asset = addAsset(img, ctx);
    return { kind: 'figure', text: '', figure: { alt: img.attribs.alt ?? '', ...(asset ? { asset } : {}) } };
  });
}

/** Block structure of one spine document (B3): headings, text, lists, quotes, figures, footnotes. */
function blocksOf(nodes: readonly ChildNode[], ctx: Context, out: BlockInput[]): void {
  let pending = new TextBuilder();
  let pendingImages: Element[] = [];
  const flush = (): void => {
    const b = block('text', pending);
    if (b.text !== '') out.push(b);
    out.push(...figureBlocks(pendingImages, ctx));
    pending = new TextBuilder();
    pendingImages = [];
  };
  const textBlock = (kind: BlockKind, el: Element, extra: Partial<BlockInput> = {}): void => {
    const b = new TextBuilder();
    const images: Element[] = [];
    inline(el.children, b, ctx, images);
    const result = block(kind, b, extra);
    if (kind === 'text' && result.text === '' && images.length > 0) {
      out.push(...figureBlocks(images, ctx));
      return;
    }
    if (result.text !== '' || kind === 'footnote') out.push(result);
    out.push(...figureBlocks(images, ctx));
  };

  for (const node of nodes) {
    if (node.type === 'text') {
      pending.add(node.data);
      continue;
    }
    if (!isTag(node)) continue;
    const name = local(node);
    if (SKIP.has(name)) continue;
    if (!BLOCK_ELEMENTS.has(name) && name !== 'br') {
      inline([node], pending, ctx, pendingImages);
      continue;
    }
    flush();
    if (isFootnote(node, ctx)) {
      textBlock('footnote', node, { footnoteId: `fn:${ctx.path}#${node.attribs.id ?? ''}` });
    } else if (HEADINGS.has(name)) {
      textBlock('heading', node, { level: Number(name.slice(1)) });
    } else if (name === 'ul' || name === 'ol') {
      const lis = node.children.filter((c): c is Element => isTag(c) && local(c) === 'li');
      if (lis.some((li) => isFootnote(li, ctx))) {
        blocksOf(node.children, ctx, out);
        continue;
      }
      let text = '';
      const items: Array<[number, number]> = [];
      const marks: NonNullable<BlockInput['marks']> = [];
      const noteRefs: NonNullable<BlockInput['noteRefs']> = [];
      const images: Element[] = [];
      for (const li of lis) {
        const b = new TextBuilder();
        inline(li.children, b, ctx, images);
        const n = normalized(b);
        if (n.text === '') continue;
        if (text !== '') text += ' ';
        const from = text.length;
        text += n.text;
        marks.push(...n.marks.map((m) => ({ ...m, start: m.start + from, end: m.end + from })));
        noteRefs.push(...n.noteRefs.map((r) => ({ ...r, at: r.at + from })));
        items.push([from, text.length]);
      }
      if (text !== '') {
        out.push({ kind: 'list', text, items, ordered: name === 'ol', ...(marks.length ? { marks } : {}), ...(noteRefs.length ? { noteRefs } : {}) });
      }
      out.push(...figureBlocks(images, ctx));
    } else if (name === 'blockquote') {
      textBlock('quote', node);
    } else if (name === 'figure') {
      const b = new TextBuilder();
      const images: Element[] = [];
      inline(node.children, b, ctx, images);
      const caption = block('figure', b).text;
      const [first, ...rest] = images;
      const asset = first ? addAsset(first, ctx) : undefined;
      out.push({ kind: 'figure', text: caption, figure: { alt: first?.attribs.alt ?? '', ...(asset ? { asset } : {}) } });
      out.push(...figureBlocks(rest, ctx));
    } else if (name === 'img') {
      out.push(...figureBlocks([node], ctx));
    } else if (name === 'hr' || name === 'br') {
      // separator only
    } else if (CONTAINERS.has(name) || name === 'li') {
      if (hasBlockChild(node)) blocksOf(node.children, ctx, out);
      else textBlock('text', node);
    } else {
      textBlock('text', node);
    }
  }
  flush();
}

export function documentBlocks(xhtml: string, path: string, pkg: EpubPackage, files: Files, targets: Set<string>, assets: Map<string, Asset>): BlockInput[] {
  const doc = xhtmlDocument(xhtml);
  const body = findAll(doc, 'body')[0];
  const out: BlockInput[] = [];
  blocksOf(body ? body.children : doc.children, { path, pkg, files, targets, assets }, out);
  return out;
}
