# Changelog

## v2.8.0

- Fixed password encryption so document properties (Info dictionary strings such as Title, Author, Subject) are encrypted when `StrF` is set, and correctly decrypted when loading encrypted PDFs (including those that use object streams / XRef streams). Encrypted files now interoperate with viewers and tools such as Chrome, Preview, pdfinfo, and qpdf.
- Fixed encryption of strings that are stored as indirect objects, which were previously written in plaintext.
- The signed contents (`/Contents`) of a signature dictionary are no longer encrypted, as required by ISO 32000-2.
- Only the trailer / cross-reference stream file identifier is exempt from encryption. An `/ID` entry in any other dictionary is now encrypted like any other string.

Import changed frome 2.8.0 to 2.8.1 from cantoo/fork:
- Convert documents to PDF/A-1/2/3 (`1B`, `2B`, `2U`, `3B`, `3U`) with
`PDFDocument.convertToPDFA()` — OutputIntent (bundled sRGB), `/ID`, and XMP
kept in sync with the Info dictionary on save.
- Embed Factur-X / ZUGFeRD invoice XML with `embedFacturX()` (PDF/A-3 hybrid +
required XMP).
- Work with XFA forms: read signature fields, scripts, and related helpers on
`PDFForm`.
- Prefer maintained upstream [`fontkit`](https://www.npmjs.com/package/fontkit) v2 for custom
font embedding. Subsetting now supports both `subset.encode()` (fontkit v2+) and
`subset.encodeStream()` (`@pdf-lib/fontkit`), so existing registrations keep working.
- Upgrade direct `pako` dependency from v1 to v2, and force transitive
`pako` installs to `^2.2.0` via Yarn `resolutions` / npm `overrides`
(consumers should mirror this in their own root `package.json`).
- `PDFForm.flatten()` now also flattens orphaned widget annotations that carry
field properties (`/FT`, `/V`, …) on the page `Annots` entry but are not
registered in `AcroForm.Fields` (text fields and stateful checkboxes / radios).


## v2.7.0

- switch to npm + fix npm install by updating eslint dependencies
- Added optional **`dedupeContent`** flag to `PDFDocument.create()` and `PDFDocument.load()` (default: `false`). When set to `true`, duplicate fonts and images are de-duplicated across multiple calls to `copyPages` and `embedPages`, reducing PDF size. When `false`, deduplication is limited to individual calls, which may increase PDF size if the same content is embedded repeatedly.
