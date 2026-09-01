#!/usr/bin/env node
// scripts/upload-guides.mjs — bulk-upload every PDF/EPUB sitting in a folder
// to POST /api/guide, instead of selecting and tapping "Upload" for each one
// by hand through the phone UI. This calls the exact same endpoint the app
// does, so every file still goes through real extraction, chunking, and
// geocoding — it's a faster way to trigger that pipeline for a batch of
// files already on disk, not a shortcut around it.
//
// Usage (from wayfinder/backend):
//   node scripts/upload-guides.mjs [folder] [--trip "Trip Name"] [--url <baseUrl>] [--dry-run]
//   npm run guides:upload -- [folder] [--trip "Trip Name"] [--url <baseUrl>] [--dry-run]
//
// --dry-run reports what each file would send (after EPUB image-stripping)
// without uploading anything or making any API calls — useful before
// running this for real against a folder of large, unfamiliar files.
//
// Without --trip, each file gets its own trip named after its filename
// (extension stripped, underscores/dashes turned into spaces) — the common
// case when a folder holds one guidebook per destination, e.g.
// "Rome.pdf" -> trip "Rome". With --trip, every file in the folder uploads
// under that one shared trip instead.
//
// Defaults to the local dev server (`npm run dev` must be running). Point
// --url at the deployed Worker to upload straight to production:
//   node scripts/upload-guides.mjs ./guides --url https://wayfinder-api.kokenziekw.workers.dev
//
// EPUBs get their images/fonts/audio stripped before upload, client-side,
// here in Node (no Workers memory/CPU constraints to worry about at this
// stage). Wayfinder only ever reads guide TEXT — it never displays guide
// images — and real-world guidebook EPUBs are often 90%+ embedded photos by
// size, so this alone is usually the difference between a file that fits
// Cloudflare's platform request-body limit (100MB on Free/Pro, 200MB on
// Business — separate from and smaller than MAX_GUIDE_UPLOAD_BYTES on some
// plans) and one that can't be uploaded as-is at all. PDFs aren't stripped
// this way — removing embedded images from a PDF means real content-stream
// surgery, not a simple file-list filter like a zip-based EPUB.

import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { unzipSync, zipSync } from 'fflate';

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.epub']);
const MIME_TYPES = { '.pdf': 'application/pdf', '.epub': 'application/epub+zip' };

// Everything an EPUB's container.xml/.opf/spine/CSS could plausibly be —
// keeping this deliberately narrow means images, fonts, audio, and video
// (the bulk of a photo-heavy guidebook's size) are dropped by default.
const EPUB_TEXT_EXTENSIONS = new Set(['.xhtml', '.html', '.htm', '.xml', '.opf', '.ncx', '.css', '.txt']);

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// fflate's filter runs BEFORE decompression per zip entry, so skipped
// files (images, fonts, ...) are never actually inflated — this stays fast
// and light even on a huge input, not just small in its output.
function stripEpubMedia(bytes) {
  const kept = unzipSync(new Uint8Array(bytes), {
    filter: (file) => {
      const ext = extname(file.name).toLowerCase();
      return EPUB_TEXT_EXTENSIONS.has(ext) || file.name.toLowerCase() === 'mimetype';
    },
  });
  return zipSync(kept);
}

function parseArgs(argv) {
  const args = { folder: './guides', trip: null, url: 'http://localhost:8787', dryRun: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--trip') args.trip = argv[++i];
    else if (argv[i] === '--url') args.url = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else positional.push(argv[i]);
  }
  if (positional[0]) args.folder = positional[0];
  return args;
}

function tripNameFromFilename(filename) {
  return basename(filename, extname(filename)).replace(/[_-]+/g, ' ').trim();
}

async function prepareUpload(filePath) {
  const originalBytes = await readFile(filePath);
  const ext = extname(filePath).toLowerCase();

  let uploadBytes = originalBytes;
  let strippedNote = '';
  if (ext === '.epub') {
    const stripped = stripEpubMedia(originalBytes);
    if (stripped.length < originalBytes.length) {
      strippedNote = ` (stripped images: ${formatBytes(originalBytes.length)} -> ${formatBytes(stripped.length)})`;
      uploadBytes = stripped;
    }
  }

  return { uploadBytes, ext, strippedNote };
}

async function uploadGuide(baseUrl, filePath, tripName) {
  const { uploadBytes, ext, strippedNote } = await prepareUpload(filePath);

  const form = new FormData();
  form.append('file', new Blob([uploadBytes], { type: MIME_TYPES[ext] }), basename(filePath));
  form.append('tripName', tripName);

  const response = await fetch(`${baseUrl}/api/guide`, { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${body.message || `HTTP ${response.status}`}${strippedNote}`);
  }
  return { ...body, strippedNote };
}

async function main() {
  const { folder, trip, url, dryRun } = parseArgs(process.argv.slice(2));

  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (err) {
    console.error(`Could not read folder "${folder}": ${err.message}`);
    console.error('Create it, or pass a different path as the first argument.');
    process.exitCode = 1;
    return;
  }

  const files = entries
    .filter((e) => e.isFile() && SUPPORTED_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();

  if (files.length === 0) {
    console.log(`No .pdf or .epub files found in "${folder}".`);
    return;
  }

  if (dryRun) {
    console.log(`Dry run — showing what would upload from "${folder}" (nothing sent, no API calls made):\n`);
    for (const file of files) {
      const tripName = trip || tripNameFromFilename(file);
      const filePath = join(folder, file);
      const { uploadBytes, strippedNote } = await prepareUpload(filePath);
      console.log(`  ${file} -> trip "${tripName}"${strippedNote} — would send ${formatBytes(uploadBytes.length)}`);
    }
    return;
  }

  console.log(`Uploading ${files.length} guide${files.length === 1 ? '' : 's'} from "${folder}" to ${url}\n`);

  let failures = 0;
  for (const file of files) {
    const tripName = trip || tripNameFromFilename(file);
    process.stdout.write(`  ${file} -> trip "${tripName}" ... `);
    try {
      const result = await uploadGuide(url, join(folder, file), tripName);
      const truncatedNote = result.truncated ? ' (truncated — more chunks than a single upload processes)' : '';
      console.log(`ok${result.strippedNote} — ${result.chunksCreated} excerpts, ${result.chunksGeocoded} geocoded${truncatedNote}`);
    } catch (err) {
      failures += 1;
      console.log(`FAILED — ${err.message}`);
    }
  }

  if (failures > 0) {
    console.log(`\n${failures} of ${files.length} upload${files.length === 1 ? '' : 's'} failed.`);
    process.exitCode = 1;
  }
}

main();
