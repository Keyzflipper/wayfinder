// test/helpers.ts — shared test setup, used by any test that needs a real
// D1 schema (routes/identify, lib/guideChunks, routes/guide-upload,
// routes/guide-lookup). Split out of test/routes/identify.test.ts once a
// second consumer needed the same schema-application step.

import { env } from 'cloudflare:test';
// Vite's `?raw` suffix imports the file's contents as a string — lets tests
// apply the real schema instead of hand-maintaining a duplicate.
import schemaSql from '../src/db/schema.sql?raw';

export async function applySchema(): Promise<void> {
  // Strip full-line `--` comments first — otherwise a statement preceded by
  // a comment block (every statement in schema.sql) keeps its leading `--`
  // line after splitting on `;`, and D1 rejects it as a non-statement.
  const withoutComments = schemaSql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
}
