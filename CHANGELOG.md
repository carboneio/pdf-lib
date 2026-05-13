# Changelog

## v2.7.0

- Added optional **`dedupeContent`** flag to `PDFDocument.create()` and `PDFDocument.load()` (default: `false`). When set to `true`, duplicate fonts and images are de-duplicated across multiple calls to `copyPages` and `embedPages`, reducing PDF size. When `false`, deduplication is limited to individual calls, which may increase PDF size if the same content is embedded repeatedly.
