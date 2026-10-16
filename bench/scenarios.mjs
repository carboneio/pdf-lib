import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fontkit = require('fontkit');

const asset = (path) =>
  readFileSync(new URL(`../assets/${path}`, import.meta.url));

export const PASSWORD = 'bench-password';

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod ' +
  'tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.';

const PARAGRAPH = (
  'Ada grew up on the edge of the oldest ruin, where her mother ' +
  'scavenged for a living. '
)
  .repeat(20)
  .trim();

const fixtures = {
  largePdf: asset('pdfs/with_large_page_count.pdf'),
  constitution: asset('pdfs/us_constitution.pdf'),
  toMerge: [
    'pdfs/normal.pdf',
    'pdfs/us_constitution.pdf',
    'pdfs/simple.pdf',
    'pdfs/with_update_sections.pdf',
    'pdfs/linearized_with_object_streams.pdf',
  ].map(asset),
  jpg: asset('images/cat_riding_unicorn.jpg'),
  png: asset('images/minions_banana_alpha.png'),
  font: asset('fonts/ubuntu/Ubuntu-R.ttf'),
  form: asset('pdfs/fancy_fields.pdf'),
};

/**
 * Each scenario receives the library namespace and resolves to the bytes of
 * the produced PDF, or to nothing when no PDF is written.
 */
export const scenarios = [
  {
    id: 'create',
    label: 'Create 100 pages of text',
    run: async ({ PDFDocument, StandardFonts }) => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      for (let page = 0; page < 100; page++) {
        const current = doc.addPage();
        for (let line = 0; line < 40; line++) {
          current.drawText(LOREM, { x: 20, y: 800 - line * 19, size: 8, font });
        }
      }
      return doc.save();
    },
  },
  {
    id: 'many-objects',
    label: 'Create and save 5,000 pages',
    run: async ({ PDFDocument, StandardFonts }) => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      for (let page = 0; page < 5000; page++) {
        doc.addPage().drawText(`Page ${page + 1}`, { x: 20, y: 800, font });
      }
      return doc.save();
    },
  },
  {
    id: 'load-save',
    label: 'Load and save an 8 MB PDF',
    run: async ({ PDFDocument }) => {
      const doc = await PDFDocument.load(fixtures.largePdf);
      return doc.save();
    },
  },
  {
    id: 'merge',
    label: 'Merge 5 PDFs',
    run: async ({ PDFDocument }) => {
      const merged = await PDFDocument.create();
      for (const bytes of fixtures.toMerge) {
        const source = await PDFDocument.load(bytes);
        const pages = await merged.copyPages(source, source.getPageIndices());
        for (const page of pages) merged.addPage(page);
      }
      return merged.save();
    },
  },
  {
    id: 'encrypt',
    label: 'Encrypt with AES-256 and save',
    run: async ({ PDFDocument }) => {
      const doc = await PDFDocument.load(fixtures.constitution);
      doc.encrypt({ userPassword: PASSWORD, ownerPassword: PASSWORD });
      return doc.save();
    },
  },
  {
    id: 'decrypt',
    label: 'Decrypt an AES-256 PDF on load',
    // Cantoo re-encrypts on save, so only the load (where both decrypt) is timed.
    run: async ({ PDFDocument }, { encrypted }) => {
      await PDFDocument.load(encrypted, { password: PASSWORD });
    },
  },
  {
    id: 'images',
    label: 'Embed a JPEG and a PNG',
    run: async ({ PDFDocument }) => {
      const doc = await PDFDocument.create();
      const jpg = await doc.embedJpg(fixtures.jpg);
      const png = await doc.embedPng(fixtures.png);
      const page = doc.addPage();
      page.drawImage(jpg, { x: 0, y: 400, width: 300, height: 300 });
      page.drawImage(png, { x: 300, y: 400, width: 300, height: 300 });
      return doc.save();
    },
  },
  {
    id: 'font',
    label: 'Embed a subset TrueType font',
    run: async ({ PDFDocument }) => {
      const doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(fixtures.font, { subset: true });
      const page = doc.addPage();
      for (let line = 0; line < 40; line++) {
        page.drawText(LOREM, { x: 20, y: 800 - line * 19, size: 8, font });
      }
      return doc.save();
    },
  },
  {
    id: 'form',
    label: 'Fill and flatten a form',
    run: async ({ PDFDocument, PDFTextField }) => {
      const doc = await PDFDocument.load(fixtures.form);
      const form = doc.getForm();
      for (const field of form.getFields()) {
        if (field instanceof PDFTextField) field.setText('Benchmark');
      }
      form.flatten();
      return doc.save();
    },
  },
  {
    id: 'long-text-field',
    label: 'Fill a multiline field with 1,700 characters',
    run: async ({ PDFDocument }) => {
      const doc = await PDFDocument.create();
      const page = doc.addPage();
      const field = doc.getForm().createTextField('story');
      field.enableMultiline();
      field.addToPage(page, { x: 50, y: 300, width: 220, height: 300 });
      field.setFontSize(8);
      field.setText(PARAGRAPH);
      return doc.save();
    },
  },
];

export const createEncryptedFixture = async ({ PDFDocument }) => {
  const doc = await PDFDocument.load(fixtures.constitution);
  doc.encrypt({ userPassword: PASSWORD, ownerPassword: PASSWORD });
  return doc.save();
};
