#!/usr/bin/env node
// scripts/upload-guides.mjs — bulk-upload every PDF/EPUB sitting in a folder
// to POST /api/guide, instead of selecting and tapping "Upload" for each one
// by hand through the phone UI. This calls the exact same endpoint the app
// does, so every file still goes through real extraction, chunking, and
// geocoding — it's a faster way to trigger that pipeline for a batch of
// files already on disk, not a shortcut around it.
//
// Usage (from wayfinder/backend):
//   node scripts/upload-guides.mjs [folder] [--trip "Trip Name"] [--url <baseUrl>]
//   npm run guides:upload -- [folder] [--trip "Trip Name"] [--url <baseUrl>]
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

import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.epub']);
const MIME_TYPES = { '.pdf': 'application/pdf', '.epub': 'application/epub+zip' };

function parseArgs(argv) {
  const args = { folder: './guides', trip: null, url: 'http://localhost:8787' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--trip') args.trip = argv[++i];
    else if (argv[i] === '--url') args.url = argv[++i];
    else positional.push(argv[i]);
  }
  if (positional[0]) args.folder = positional[0];
  return args;
}

function tripNameFromFilename(filename) {
  return basename(filename, extname(filename)).replace(/[_-]+/g, ' ').trim();
}

async function uploadGuide(baseUrl, filePath, tripName) {
  const bytes = await readFile(filePath);
  const mimeType = MIME_TYPES[extname(filePath).toLowerCase()];

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), basename(filePath));
  form.append('tripName', tripName);

  const response = await fetch(`${baseUrl}/api/guide`, { method: 'POST', body: form });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.message || `HTTP ${response.status}`);
  }
  return body;
}

async function main() {
  const { folder, trip, url } = parseArgs(process.argv.slice(2));

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

  console.log(`Uploading ${files.length} guide${files.length === 1 ? '' : 's'} from "${folder}" to ${url}\n`);

  let failures = 0;
  for (const file of files) {
    const tripName = trip || tripNameFromFilename(file);
    process.stdout.write(`  ${file} -> trip "${tripName}" ... `);
    try {
      const result = await uploadGuide(url, join(folder, file), tripName);
      const truncatedNote = result.truncated ? ' (truncated — more chunks than a single upload processes)' : '';
      console.log(`ok — ${result.chunksCreated} excerpts, ${result.chunksGeocoded} geocoded${truncatedNote}`);
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
