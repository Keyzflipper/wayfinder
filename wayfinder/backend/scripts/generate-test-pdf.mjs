// scripts/generate-test-pdf.mjs — one-off generator for
// test/fixtures/sample-guide.pdf. Hand-builds a minimal, valid two-page
// PDF (no external PDF library needed) with real extractable text: page 1
// names a specific, geocodable place; page 2 is generic text with none —
// exercising both branches guide-upload.ts's per-chunk geocoding takes.
// Run with `node scripts/generate-test-pdf.mjs` if the fixture ever needs
// regenerating; not part of the normal test run.

function makeStream(lines) {
  const body = lines.map((l) => `BT /F1 ${l.size} Tf 72 ${l.y} Td (${l.text}) Tj ET`).join('\n');
  return body;
}

const page1Stream = makeStream([
  { size: 24, y: 700, text: 'Independence Hall' },
  { size: 12, y: 660, text: 'Where the Declaration of Independence was debated and adopted.' },
  { size: 12, y: 640, text: 'Located in Philadelphia, Pennsylvania.' },
]);

const page2Stream = makeStream([
  { size: 24, y: 700, text: 'Planning Your Trip' },
  { size: 12, y: 660, text: 'Pack comfortable walking shoes and bring a reusable water bottle.' },
  { size: 12, y: 640, text: 'Most museums open at nine and close by five in the evening.' },
]);

const objects = [];
// 1: Catalog
objects.push('<< /Type /Catalog /Pages 2 0 R >>');
// 2: Pages
objects.push('<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>');
// 3: Page 1
objects.push(
  '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>'
);
// 4: Page 2
objects.push(
  '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 6 0 R >> >> /MediaBox [0 0 612 792] /Contents 7 0 R >>'
);
// 5: Page 1 content stream
objects.push({ stream: page1Stream });
// 6: Font
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
// 7: Page 2 content stream
objects.push({ stream: page2Stream });

let pdf = '%PDF-1.4\n';
const offsets = [0]; // offsets[0] unused (object numbers are 1-indexed)

objects.forEach((obj, i) => {
  offsets.push(pdf.length);
  const num = i + 1;
  if (typeof obj === 'string') {
    pdf += `${num} 0 obj\n${obj}\nendobj\n`;
  } else {
    pdf += `${num} 0 obj\n<< /Length ${obj.stream.length} >>\nstream\n${obj.stream}\nendstream\nendobj\n`;
  }
});

const xrefStart = pdf.length;
const count = objects.length + 1;
let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i++) {
  xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}

pdf += xref;
pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

const fs = await import('node:fs');
const path = await import('node:path');
const outPath = path.join(import.meta.dirname, '..', 'test', 'fixtures', 'sample-guide.pdf');
fs.writeFileSync(outPath, pdf, 'latin1');
console.log(`Wrote ${outPath} (${pdf.length} bytes)`);
