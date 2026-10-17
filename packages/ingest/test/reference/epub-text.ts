/**
 * Test-only reference for the EPUB text layer (B2): for each spine document, the text content of
 * `<body>` with entities decoded, `script`/`style` skipped, and a separator at every block
 * element boundary and at `<br>`. It uses only htmlparser2, domutils and fflate, never the ingest
 * code, so the fidelity check compares two independent derivations.
 */
import { unzipSync } from 'fflate';
import { parseDocument } from 'htmlparser2';
import { getAttributeValue, getElementsByTagName } from 'domutils';
import { isTag, isText } from 'domhandler';
import type { AnyNode } from 'domhandler';

const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hgroup', 'hr', 'img', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

function walk(node: AnyNode, out: string[]): void {
  if (isText(node)) {
    out.push(node.data);
    return;
  }
  if (!isTag(node)) return;
  const name = node.name.toLowerCase();
  if (name === 'script' || name === 'style') return;
  if (name === 'br') {
    out.push(' ');
    return;
  }
  const block = BLOCKS.has(name);
  if (block) out.push(' ');
  for (const child of node.children) walk(child, out);
  if (block) out.push(' ');
}

const dir = (p: string): string => p.slice(0, p.lastIndexOf('/') + 1);

export function epubSourceText(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const read = (p: string): string => new TextDecoder().decode(files[p]);
  const container = parseDocument(read('META-INF/container.xml'), { xmlMode: true });
  const opfPath = getAttributeValue(getElementsByTagName('rootfile', container)[0]!, 'full-path')!;
  const opf = parseDocument(read(opfPath), { xmlMode: true });
  const hrefs = new Map(getElementsByTagName('item', opf).map((i) => [getAttributeValue(i, 'id'), getAttributeValue(i, 'href')]));
  const parts: string[] = [];
  for (const ref of getElementsByTagName('itemref', opf)) {
    const href = hrefs.get(getAttributeValue(ref, 'idref'));
    if (!href) continue;
    const doc = parseDocument(read(dir(opfPath) + href), { recognizeSelfClosing: true });
    const body = getElementsByTagName('body', doc)[0];
    if (body) walk(body, parts);
  }
  return parts.join('');
}
