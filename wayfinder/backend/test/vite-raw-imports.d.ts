// Ambient declaration for Vite's `?raw` import suffix (used to load
// src/db/schema.sql as a string in test/helpers.ts, and
// test/fixtures/sample-guide.pdf as a string in
// test/routes/guide-upload.test.ts — see that file for why a `?raw` string
// is fine for a binary PDF fixture in this one specific case).
// No top-level import/export here deliberately — this must stay a global
// "script" file, not a module, or the wildcard pattern below is treated as
// module augmentation instead of a new ambient module and silently no-ops.
// (Mirrors vite/client.d.ts, which declares the same pattern the same way.)

declare module '*?raw' {
  const content: string;
  export default content;
}
