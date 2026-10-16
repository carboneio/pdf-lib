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

const codePoints = (from, to) =>
  String.fromCodePoint(
    ...Array.from({ length: to - from + 1 }, (_, i) => from + i),
  );

// Printable ASCII, Latin-1 and Latin Extended-A: about 300 distinct glyphs.
const LATIN_LINES = (
  codePoints(0x21, 0x7e) +
  codePoints(0xa1, 0xff) +
  codePoints(0x100, 0x17f)
).match(/.{1,60}/gu);

const drawLatinLines = (page, font) => {
  LATIN_LINES.forEach((line, index) => {
    page.drawText(line, { x: 20, y: 800 - index * 19, size: 8, font });
  });
};

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
  jpgs: [
    'images/cat_riding_unicorn.jpg',
    'images/cmyk_colorspace.jpg',
    'images/minions_laughing.jpg',
    'images/cat_riding_unicorn_resized.jpg',
  ].map(asset),
  pngs: [
    'images/small_mario.png',
    'images/minions_banana_no_alpha.png',
    'images/greyscale_bird.png',
    'images/minions_banana_alpha.png',
    'images/etwe.png',
  ].map(asset),
  font: asset('fonts/ubuntu/Ubuntu-R.ttf'),
  logo: asset('images/minions_banana_alpha.png'),
  photo: asset('images/cat_riding_unicorn_resized.jpg'),
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
    run: ({ PDFDocument }) => mergeAll(PDFDocument, fixtures.toMerge),
  },
  {
    id: 'merge-reports',
    label: 'Merge 20 reports built from one template',
    run: ({ PDFDocument }, { reports }) => mergeAll(PDFDocument, reports),
  },
  {
    id: 'merge-reports-dedupe',
    label: 'Merge 20 reports with `dedupeContent` (Carbone only)',
    // Cantoo has no such option and ignores it, so its column is a plain merge.
    run: ({ PDFDocument }, { reports }) =>
      mergeAll(PDFDocument, reports, { dedupeContent: true }),
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
    id: 'jpegs',
    label: 'Embed 20 JPEGs, 5.5 MB in total',
    // JPEG data is copied into the PDF as is, without decoding or compression.
    run: async ({ PDFDocument }) => {
      const doc = await PDFDocument.create();
      for (let copy = 0; copy < 5; copy++) {
        for (const bytes of fixtures.jpgs) {
          const image = await doc.embedJpg(bytes);
          doc
            .addPage()
            .drawImage(image, { x: 0, y: 0, width: 300, height: 300 });
        }
      }
      return doc.save();
    },
  },
  {
    id: 'pngs',
    label: 'Embed 5 PNGs, 2.5 MB in total',
    run: async ({ PDFDocument }) => {
      const doc = await PDFDocument.create();
      for (const bytes of fixtures.pngs) {
        const image = await doc.embedPng(bytes);
        doc.addPage().drawImage(image, { x: 0, y: 0, width: 300, height: 300 });
      }
      return doc.save();
    },
  },
  {
    id: 'font-full',
    label: 'Embed a whole TrueType font',
    run: async ({ PDFDocument }) => {
      const doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(fixtures.font, { subset: false });
      drawLatinLines(doc.addPage(), font);
      return doc.save();
    },
  },
  {
    id: 'font-subset',
    label: 'Subset a TrueType font to 300 glyphs over 10 pages',
    run: async ({ PDFDocument }) => {
      const doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(fixtures.font, { subset: true });
      for (let page = 0; page < 10; page++) drawLatinLines(doc.addPage(), font);
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

const REPORT_COUNT = 20;

/**
 * A two-page invoice such as a template engine produces: every report shares
 * the logo, the photo and the font, and only the text differs.
 */
const createReport = async ({ PDFDocument }, number) => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fixtures.font, { subset: true });
  const logo = await doc.embedPng(fixtures.logo);
  const photo = await doc.embedJpg(fixtures.photo);
  for (let pageNumber = 1; pageNumber <= 2; pageNumber++) {
    const page = doc.addPage();
    page.drawImage(logo, { x: 20, y: 720, width: 100, height: 100 });
    page.drawImage(photo, { x: 400, y: 600, width: 150, height: 150 });
    for (let line = 0; line < 30; line++) {
      const amount = (number * 37 + line * 11) % 9973;
      const text = `Invoice ${number}, page ${pageNumber}, line ${line}: ${amount} EUR`;
      page.drawText(text, { x: 20, y: 680 - line * 19, size: 9, font });
    }
  }
  return doc.save();
};

/**
 * Inputs that both libraries must read identically, so they are written once
 * with the local build by `index.mjs` rather than by each library.
 */
export const createFixtures = async (PDFLib) => {
  const doc = await PDFLib.PDFDocument.load(fixtures.constitution);
  doc.encrypt({ userPassword: PASSWORD, ownerPassword: PASSWORD });
  const encrypted = await doc.save();

  const reports = [];
  for (let number = 1; number <= REPORT_COUNT; number++) {
    reports.push(await createReport(PDFLib, number));
  }
  return { encrypted, reports };
};

const mergeAll = async (PDFDocument, sources, options) => {
  const merged = await PDFDocument.create(options);
  for (const bytes of sources) {
    const source = await PDFDocument.load(bytes);
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const page of pages) merged.addPage(page);
  }
  return merged.save();
};
