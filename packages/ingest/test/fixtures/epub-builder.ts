import { strToU8, zipSync, type Zippable } from 'fflate';

/** Builds small EPUB files from inline strings for tests and `bun run fixtures` (D8). */

interface Doc {
  id: string;
  href: string;
  body: string;
}

interface EpubOptions {
  version?: 2 | 3;
  title?: string;
  language?: string | null;
  docs: Doc[];
  /** EPUB 3 nav labels / EPUB 2 NCX labels by doc href. */
  toc?: Record<string, string>;
  extraFiles?: Record<string, Uint8Array | string>;
  extraManifest?: string;
}

const XHTML = (body: string, title = 'x'): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title><style>p { color: red; }</style></head>
<body>${body}</body>
</html>`;

export function buildEpub(o: EpubOptions): Uint8Array {
  const version = o.version ?? 3;
  const toc = o.toc ?? {};
  const lang = o.language === null ? '' : `<dc:language>${o.language ?? 'de'}</dc:language>`;
  const navItem = version === 3 ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : '';
  const ncxItem = version === 2 ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : '';
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:test</dc:identifier>
    <dc:title>${o.title ?? 'Testbuch'}</dc:title>
    <dc:creator>Test Autor</dc:creator>
    ${lang}
  </metadata>
  <manifest>
    ${navItem}${ncxItem}
    ${o.docs.map((d) => `<item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`).join('\n    ')}
    ${o.extraManifest ?? ''}
  </manifest>
  <spine${version === 2 ? ' toc="ncx"' : ''}>
    ${o.docs.map((d) => `<itemref idref="${d.id}"/>`).join('\n    ')}
  </spine>
</package>`;
  const files: Zippable = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    'OEBPS/content.opf': strToU8(opf),
  };
  for (const d of o.docs) files[`OEBPS/${d.href}`] = strToU8(XHTML(d.body));
  if (version === 3) {
    const lis = Object.entries(toc).map(([href, label]) => `<li><a href="${href}">${label}</a></li>`).join('');
    files['OEBPS/nav.xhtml'] = strToU8(XHTML(`<nav epub:type="toc"><h1>Inhalt</h1><ol>${lis}</ol></nav>`));
  } else {
    const points = Object.entries(toc)
      .map(([href, label], k) => `<navPoint id="p${k}" playOrder="${k + 1}"><navLabel><text>${label}</text></navLabel><content src="${href}"/></navPoint>`)
      .join('');
    files['OEBPS/toc.ncx'] = strToU8(`<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${points}</navMap></ncx>`);
  }
  for (const [path, data] of Object.entries(o.extraFiles ?? {})) files[path] = typeof data === 'string' ? strToU8(data) : data;
  return zipSync(files);
}

/** 1×1 transparent PNG. */
export const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0),
);

const encryption = (algorithm: string): string => `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/>
  <enc:CipherData><enc:CipherReference URI="OEBPS/kapitel1.xhtml"/></enc:CipherData></enc:EncryptedData>
</encryption>`;

const simple = [{ id: 'k1', href: 'kapitel1.xhtml', body: '<h1>Kapitel</h1><p>Ein kurzer Text.</p>' }];

/** Every fixture case by name (06·7). */
export const EPUB_CASES: Record<string, () => Uint8Array> = {
  'epub3-nav': () =>
    buildEpub({
      title: 'Drei Kapitel',
      docs: [
        { id: 'k1', href: 'kapitel1.xhtml', body: '<h1>Erstes</h1><p>Habe <em>Mut</em>, dich deines <strong>eigenen</strong> Verstandes zu bedienen!</p><ul><li>Faulheit</li><li>Feigheit</li></ul>' },
        { id: 'k2', href: 'kapitel2.xhtml', body: '<h2>Zweites</h2><blockquote><p>Sapere aude!</p></blockquote><p>Es ist so bequem, unmündig zu sein.</p>' },
        { id: 'k3', href: 'text/kapitel3.xhtml', body: '<p>Ohne Überschrift.</p><ol><li>Eins.</li><li>Zwei.</li></ol>' },
      ],
      toc: { 'kapitel1.xhtml': 'Kapitel Eins', 'text/kapitel3.xhtml': 'Kapitel Drei' },
    }),
  'epub2-ncx-entities': () =>
    buildEpub({
      version: 2,
      title: 'Entit&auml;ten',
      docs: [
        { id: 'a', href: 'a.xhtml', body: '<h1>Caf&eacute; &amp; Kuchen</h1><p>Mut&nbsp;haben &#228; &#x00FC; &ldquo;so&rdquo; &mdash; gut.</p>' },
        { id: 'b', href: 'b.xhtml', body: '<p>Zweites Dokument.</p>' },
      ],
      toc: { 'a.xhtml': 'Café', 'b.xhtml': 'Zweites' },
    }),
  footnotes: () =>
    buildEpub({
      docs: [
        {
          id: 'k1',
          href: 'kapitel1.xhtml',
          body: '<h1>Fußnoten</h1><p>Ein Wort<a epub:type="noteref" href="#fn1">1</a> mit Fußnote. Noch eine<sup><a epub:type="noteref" href="notes.xhtml#n2">2</a></sup> hier.</p><aside epub:type="footnote" id="fn1"><p>Die erste Fußnote.</p></aside>',
        },
        { id: 'n', href: 'notes.xhtml', body: '<section epub:type="endnotes"><aside id="n2"><p>Die zweite Fußnote.</p></aside></section>' },
      ],
    }),
  figure: () =>
    buildEpub({
      docs: [
        {
          id: 'k1',
          href: 'kapitel1.xhtml',
          body: '<h1>Bild</h1><p>Vor dem Bild.</p><figure><img src="img/punkt.png" alt="Ein Punkt"/><figcaption>Ein kleiner Punkt.</figcaption></figure><p>Nach dem Bild.</p><p><img src="img/punkt.png" alt="Inline"/></p>',
        },
      ],
      extraFiles: { 'OEBPS/img/punkt.png': PNG },
      extraManifest: '<item id="png" href="img/punkt.png" media-type="image/png"/>',
    }),
  'lang-fr': () =>
    buildEpub({ language: 'fr', docs: [{ id: 'k1', href: 'k1.xhtml', body: '<h1>Chapitre IV</h1><p>M. Dupont a vu 3 chats.</p>' }] }),
  'no-language': () => buildEpub({ language: null, docs: simple }),
  encrypted: () => buildEpub({ docs: simple, extraFiles: { 'META-INF/encryption.xml': encryption('http://www.w3.org/2001/04/xmlenc#aes256-cbc') } }),
  rights: () => buildEpub({ docs: simple, extraFiles: { 'META-INF/rights.xml': '<rights/>' } }),
  'font-obfuscation': () => buildEpub({ docs: simple, extraFiles: { 'META-INF/encryption.xml': encryption('http://www.idpf.org/2008/embedding') } }),
  'no-whitespace-blocks': () =>
    buildEpub({ docs: [{ id: 'k1', href: 'k1.xhtml', body: '<h1>Titel</h1><p>Text.</p><p>Ende.</p><p>Anfang</p><div>Zeile<br/>Umbruch</div>' }] }),
};
