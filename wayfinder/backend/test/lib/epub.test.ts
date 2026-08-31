import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { extractEpubText } from '../../src/lib/epub';

function buildEpub(files: Record<string, string>): ArrayBuffer {
  const zipped = zipSync(
    Object.fromEntries(Object.entries(files).map(([path, content]) => [path, strToU8(content)]))
  );
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

describe('extractEpubText', () => {
  it('reads chapters in spine order and strips markup to plain text', async () => {
    const bytes = buildEpub({
      'META-INF/container.xml': CONTAINER_XML,
      'OEBPS/content.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`,
      'OEBPS/c1.xhtml': `<html><body><h1>Chapter One</h1><p>First chapter text.</p></body></html>`,
      'OEBPS/c2.xhtml': `<html><body><h1>Chapter Two</h1><p>Second chapter text.</p></body></html>`,
    });

    const result = await extractEpubText(bytes);

    expect(result.totalSections).toBe(2);
    // Manifest lists c2 before c1, but spine order (c1, c2) must win.
    expect(result.sectionTexts[0]).toContain('Chapter One');
    expect(result.sectionTexts[0]).toContain('First chapter text');
    expect(result.sectionTexts[0]).not.toContain('<h1>');
    expect(result.sectionTexts[1]).toContain('Chapter Two');
  });

  it('resolves hrefs relative to the package document, not the archive root', async () => {
    const bytes = buildEpub({
      'META-INF/container.xml': `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content/book.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
      'content/book.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="c1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="c1"/></spine>
</package>`,
      'content/text/chapter1.xhtml': `<html><body><p>Nested chapter content.</p></body></html>`,
    });

    const result = await extractEpubText(bytes);

    expect(result.sectionTexts).toEqual(['Nested chapter content.']);
  });

  it('skips spine entries whose manifest item or content file is missing', async () => {
    const bytes = buildEpub({
      'META-INF/container.xml': CONTAINER_XML,
      'OEBPS/content.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine>
    <itemref idref="missing-id"/>
    <itemref idref="c1"/>
  </spine>
</package>`,
      'OEBPS/c1.xhtml': `<html><body><p>Only real chapter.</p></body></html>`,
    });

    const result = await extractEpubText(bytes);

    expect(result.totalSections).toBe(1);
    expect(result.sectionTexts).toEqual(['Only real chapter.']);
  });

  it('drops empty sections rather than counting them', async () => {
    const bytes = buildEpub({
      'META-INF/container.xml': CONTAINER_XML,
      'OEBPS/content.opf': `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="empty" href="empty.xhtml" media-type="application/xhtml+xml"/>
    <item id="real" href="real.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="empty"/><itemref idref="real"/></spine>
</package>`,
      'OEBPS/empty.xhtml': `<html><body>   </body></html>`,
      'OEBPS/real.xhtml': `<html><body><p>Real content.</p></body></html>`,
    });

    const result = await extractEpubText(bytes);

    expect(result.totalSections).toBe(1);
    expect(result.sectionTexts).toEqual(['Real content.']);
  });

  it('throws when container.xml is missing (not a valid EPUB)', async () => {
    const bytes = buildEpub({ 'some-file.txt': 'not an epub' });

    await expect(extractEpubText(bytes)).rejects.toThrow(/container\.xml/);
  });

  it('throws when the package document referenced by container.xml is missing', async () => {
    const bytes = buildEpub({ 'META-INF/container.xml': CONTAINER_XML });

    await expect(extractEpubText(bytes)).rejects.toThrow(/package document/i);
  });
});
