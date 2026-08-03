# Changelog

## v2.8.0

- Fixed password encryption so document properties (Info dictionary strings such as Title, Author, Subject) are encrypted when `StrF` is set, and correctly decrypted when loading encrypted PDFs (including those that use object streams / XRef streams). Encrypted files now interoperate with viewers and tools such as Chrome, Preview, pdfinfo, and qpdf.

## v2.7.0

- switch to npm + fix npm install by updating eslint dependencies
- Added optional **`dedupeContent`** flag to `PDFDocument.create()` and `PDFDocument.load()` (default: `false`). When set to `true`, duplicate fonts and images are de-duplicated across multiple calls to `copyPages` and `embedPages`, reducing PDF size. When `false`, deduplication is limited to individual calls, which may increase PDF size if the same content is embedded repeatedly.
