import type { Element } from 'domhandler';
import { unzipSync } from 'fflate';
import { parseDocument } from 'htmlparser2';
import { IngestError } from '../errors.ts';

export type Files = Record<string, Uint8Array>;

export function unzip(bytes: Uint8Array): Files {
  try {
    return unzipSync(bytes);
  } catch {
    throw new IngestError('unreadable', 'The EPUB file is not a readable ZIP archive.');
  }
}

export function text(files: Files, path: string): string | undefined {
  const bytes = files[path];
  return bytes ? new TextDecoder().decode(bytes).replace(/^﻿/u, '') : undefined;
}

/** Parse XML (container, OPF, NCX, encryption) keeping prefixed names such as `dc:title`. */
export function parseXml(xml: string) {
  return parseDocument(xml, { xmlMode: true });
}

/** Element children named `name` (local name match, prefix ignored), depth-first. */
export function findAll(root: { children?: unknown[] }, name: string): Element[] {
  const out: Element[] = [];
  const walk = (node: { children?: unknown[] }): void => {
    for (const child of (node.children ?? []) as Array<Element & { type: string }>) {
      if (child.type !== 'tag' && child.type !== 'script' && child.type !== 'style') continue;
      const local = child.name.includes(':') ? child.name.slice(child.name.indexOf(':') + 1) : child.name;
      if (local === name || child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

export function textOf(node: { children?: unknown[] }): string {
  let s = '';
  for (const child of (node.children ?? []) as Array<{ type: string; data?: string; children?: unknown[] }>) {
    if (child.type === 'text') s += child.data ?? '';
    else if (child.children) s += textOf(child);
  }
  return s;
}

function dirOf(path: string): string {
  const k = path.lastIndexOf('/');
  return k < 0 ? '' : path.slice(0, k + 1);
}

/** Resolves `href` (URL-encoded, maybe with `#fragment`) against the folder of `base`. */
export function resolvePath(base: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0] ?? '');
  const parts = (dirOf(base) + clean).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

export interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: string;
}

export interface EpubPackage {
  title: string;
  author?: string;
  language?: string;
  manifest: Map<string, ManifestItem>;
  byPath: Map<string, ManifestItem>;
  /** Spine documents in reading order (zip paths). */
  spine: string[];
  /** TOC labels by document path (first label wins). */
  toc: Map<string, string>;
}

const ALLOWED_ENCRYPTION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

/**
 * DRM check (B3): a `META-INF/rights.xml`, or an `encryption.xml` that uses any algorithm other
 * than the IDPF or Adobe font obfuscation, rejects the book.
 */
export function checkDrm(files: Files): void {
  if (files['META-INF/rights.xml']) throw new IngestError('drm', 'DRM-protected books are not supported.');
  const enc = text(files, 'META-INF/encryption.xml');
  if (enc === undefined) return;
  for (const method of findAll(parseXml(enc), 'EncryptionMethod')) {
    if (!ALLOWED_ENCRYPTION.has(method.attribs.Algorithm ?? '')) {
      throw new IngestError('drm', 'DRM-protected books are not supported.');
    }
  }
}

function tocFromNav(files: Files, path: string, toc: Map<string, string>): void {
  const xhtml = text(files, path);
  if (xhtml === undefined) return;
  const doc = parseDocument(xhtml, { recognizeSelfClosing: true, lowerCaseTags: false, lowerCaseAttributeNames: false });
  const navs = findAll(doc, 'nav');
  const nav = navs.find((n) => (n.attribs['epub:type'] ?? '').split(/\s+/u).includes('toc')) ?? navs[0];
  for (const a of nav ? findAll(nav, 'a') : []) {
    const href = a.attribs.href;
    if (!href) continue;
    const target = resolvePath(path, href);
    if (!toc.has(target)) toc.set(target, textOf(a).replace(/\s+/gu, ' ').trim());
  }
}

function tocFromNcx(files: Files, path: string, toc: Map<string, string>): void {
  const xml = text(files, path);
  if (xml === undefined) return;
  for (const point of findAll(parseXml(xml), 'navPoint')) {
    const label = findAll(point, 'text')[0];
    const content = findAll(point, 'content')[0];
    const src = content?.attribs.src;
    if (!label || !src) continue;
    const target = resolvePath(path, src);
    if (!toc.has(target)) toc.set(target, textOf(label).replace(/\s+/gu, ' ').trim());
  }
}

export function readPackage(files: Files): EpubPackage {
  const container = text(files, 'META-INF/container.xml');
  if (container === undefined) throw new IngestError('unreadable', 'The EPUB has no META-INF/container.xml.');
  const opfPath = findAll(parseXml(container), 'rootfile')[0]?.attribs['full-path'];
  const opfText = opfPath ? text(files, opfPath) : undefined;
  if (!opfPath || opfText === undefined) throw new IngestError('unreadable', 'The EPUB package document is missing.');
  const opf = parseXml(opfText);
  const first = (name: string): string | undefined => {
    const el = findAll(opf, name)[0];
    const value = el ? textOf(el).trim() : '';
    return value === '' ? undefined : value;
  };

  const manifest = new Map<string, ManifestItem>();
  const byPath = new Map<string, ManifestItem>();
  for (const item of findAll(opf, 'item')) {
    const { id, href } = item.attribs;
    if (!id || !href) continue;
    const entry: ManifestItem = {
      id,
      path: resolvePath(opfPath, href),
      mediaType: item.attribs['media-type'] ?? 'application/octet-stream',
      properties: item.attribs.properties ?? '',
    };
    manifest.set(id, entry);
    byPath.set(entry.path, entry);
  }
  const spineEl = findAll(opf, 'spine')[0];
  const spine = (spineEl ? findAll(spineEl, 'itemref') : [])
    .map((ref) => manifest.get(ref.attribs.idref ?? '')?.path)
    .filter((p): p is string => p !== undefined);

  const toc = new Map<string, string>();
  const nav = [...manifest.values()].find((i) => i.properties.split(/\s+/u).includes('nav'));
  if (nav) tocFromNav(files, nav.path, toc);
  const ncx = manifest.get(spineEl?.attribs.toc ?? '') ?? [...manifest.values()].find((i) => i.mediaType === 'application/x-dtbncx+xml');
  if (ncx) tocFromNcx(files, ncx.path, toc);

  const title = first('title');
  const author = first('creator');
  const language = first('language');
  return {
    title: title ?? '',
    ...(author !== undefined ? { author } : {}),
    ...(language !== undefined ? { language } : {}),
    manifest,
    byPath,
    spine,
    toc,
  };
}
