// lib/epub.ts — plain-text extraction from an EPUB file, mirroring the
// { totalX, text[] } shape unpdf's extractText() returns so routes/guide-upload.ts
// can treat PDF and EPUB identically once extraction is done.
//
// An EPUB is a zip archive. To get chapter text in reading order:
//   1. Unzip it (fflate — pure JS, no Node fs, Workers-safe).
//   2. Read META-INF/container.xml to find the package document (.opf) path.
//   3. Parse the .opf: <manifest> maps ids -> file hrefs, <spine> lists
//      those ids in reading order.
//   4. Read each spine item's XHTML and strip tags down to plain text.
//
// No DOMParser in Workers, so both the container.xml/.opf (well-defined,
// predictable XML) and the chapter bodies (arbitrary XHTML) are handled
// without one: fast-xml-parser (no DOM dependency) for the former, a plain
// regex tag-strip for the latter — same "good enough for this scope" bar
// chunkPageText() already uses for PDF text.

import { strFromU8, unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

export interface EpubExtraction {
  totalSections: number;
  sectionTexts: string[];
}

export async function extractEpubText(bytes: ArrayBuffer): Promise<EpubExtraction> {
  const files = unzipSync(new Uint8Array(bytes));
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

  const containerXml = readTextFile(files, 'META-INF/container.xml');
  if (containerXml === null) {
    throw new Error('Missing META-INF/container.xml — not a valid EPUB.');
  }

  const container = parser.parse(containerXml);
  const rootfile = toArray(container?.container?.rootfiles?.rootfile)[0];
  const opfPath = rootfile?.['@_full-path'];
  if (typeof opfPath !== 'string') {
    throw new Error('Could not locate the EPUB package document (container.xml has no rootfile).');
  }

  const opfXml = readTextFile(files, opfPath);
  if (opfXml === null) {
    throw new Error(`Package document referenced at "${opfPath}" is missing from the archive.`);
  }

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = parser.parse(opfXml);

  const manifestItems = toArray(opf?.package?.manifest?.item);
  const hrefById = new Map<string, string>(
    manifestItems
      .filter((item) => typeof item['@_id'] === 'string' && typeof item['@_href'] === 'string')
      .map((item) => [item['@_id'], item['@_href']])
  );

  const spineItems = toArray(opf?.package?.spine?.itemref);
  const sectionTexts: string[] = [];

  for (const itemref of spineItems) {
    const idref = itemref['@_idref'];
    const href = typeof idref === 'string' ? hrefById.get(idref) : undefined;
    if (!href) continue;

    const contentPath = resolvePath(opfDir, href);
    const xhtml = readTextFile(files, contentPath);
    if (xhtml === null) continue;

    const text = stripHtml(xhtml);
    if (text.length > 0) sectionTexts.push(text);
  }

  return { totalSections: sectionTexts.length, sectionTexts };
}

// ---- Helpers ----

function readTextFile(files: Record<string, Uint8Array>, path: string): string | null {
  const bytes = files[path];
  return bytes ? strFromU8(bytes) : null;
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// EPUB hrefs are relative to the .opf's own directory and may be
// percent-encoded (e.g. a space as %20) — decode before joining, and
// resolve any "../" segments so the result matches fflate's archive keys.
function resolvePath(dir: string, href: string): string {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {
    // Not actually percent-encoded (e.g. a literal "%" in the filename) — use as-is.
  }

  const segments = `${dir}${decoded}`.split('/').filter((s) => s !== '.');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '..') resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join('/');
}

function stripHtml(xhtml: string): string {
  return xhtml
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
