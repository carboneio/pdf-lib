/*eslint no-undef: "off"*/
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const PASSWORD = 'smoke-test';

const roundTrip = async (label, PDFLib) => {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  assert.equal(typeof PDFDocument, 'function', `${label}: PDFDocument export`);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  pdfDoc.addPage().drawText(`Smoke test ${label}`, {
    x: 50,
    y: 700,
    size: 24,
    font,
    color: rgb(0, 0, 0),
  });
  pdfDoc.addPage();
  pdfDoc.encrypt({ userPassword: PASSWORD, ownerPassword: PASSWORD });
  const bytes = await pdfDoc.save();
  assert.ok(bytes.length > 0, `${label}: saved bytes`);

  const reloaded = await PDFDocument.load(bytes, { password: PASSWORD });
  assert.equal(reloaded.getPageCount(), 2, `${label}: page count`);
  console.log(`ok ${label}`);
};

await roundTrip('cjs', require(pkg.name));
await roundTrip('es', await import(pkg.name));

runInThisContext(readFileSync('dist/pdf-lib.min.js', 'utf8'));
await roundTrip('umd', globalThis.PDFLib);

for (const file of [
  'cjs/index.d.ts',
  'es/index.d.ts',
  'ts3.4/cjs/index.d.ts',
]) {
  assert.ok(existsSync(file), `missing ${file}`);
}
console.log('ok type declarations');
