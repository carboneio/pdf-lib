# Changelog

## Unreleased

Backported from [cantoo-scribe/pdf-lib](https://github.com/cantoo-scribe/pdf-lib):

  - Added `PDFPage.extractContents()`, which returns typed `PdfAsset[]` (text, images, and approximate vector `graphics` as SVG) from page content streams. Text is decoded via ToUnicode / WinAnsi and includes `x`, `y`, `fontSize`, and `fontFamily`. Image XObjects become JPEG or PNG bytes with page-space position. Painted paths become `kind: 'graphics'` with `getSvg()`. Form XObjects are traversed. Path-outlined text is not extracted as text.
  - Fixed catalog name trees for embedded files and document JavaScript, which are now kept in PDF lexical order by re-sorting flat `/Names` entries on insert (required by ISO 32000). Existing `/Kids` trees and other incompatible name-tree shapes are left untouched instead of creating an invalid sibling `/Names` array.
  - Fixed loading of truncated PDFs: an unterminated trailing object is now dropped instead of failing the whole parse, and the parser rewinds so a following xref section or trailer is still read. Strict mode (`throwOnInvalidObject`) is unchanged.
  - Added optional content (PDF layers) helpers: `PDFDocument.getOptionalContentGroups()` and `PDFDocument.setOptionalContentGroupVisibility()` update the default `/OCProperties` `/D` configuration (`/ON`, `/OFF`, `/BaseState`) so viewers open layers in the requested state. Also available via `catalog.getOCProperties()`.
  - Added `EmbedFontOptions.postscriptName` to select a face from TrueType/DFont collections (`.ttc` / `.dfont`) when embedding with fontkit.
  - Hardened custom-font / fontkit interop for upstream `fontkit` v2 and `@types/fontkit` (font collections, optional font tables, subset `includeGlyph` return values).

## v2.8.1

  - Fixed the release build which broke the 2.8.0 publication. Re-publish as 2.8.1.

## v2.8.0

  - Fixed password encryption so document properties (Title, Author, Subject and the other Info strings) are encrypted on save and decrypted on load. Encrypted files now open correctly in Chrome, Preview, pdfinfo and qpdf.
  - Fixed encryption of strings stored as indirect objects, which were written in plaintext.
  - The signed contents (`/Contents`) of a signature dictionary are no longer encrypted, as ISO 32000-2 requires.
  - Only the trailer's file identifier is exempt from encryption. An `/ID` entry in any other dictionary is now encrypted like any other string.
  - **Breaking:** `PDFDocument.encrypt()` now always defaults to AES-256 (`/V 5`, `/R 6`). The cipher used to be inferred from the document's PDF version, which silently produced 40-bit or 128-bit RC4 on older files.
  - Added `SecurityOptions.algorithm` (`'AES-256'` by default, `'AES-128'`, `'RC4-128'`, `'RC4-40'`). Choosing an RC4 variant throws unless `SecurityOptions.allowWeakCryptography` is also set.
  - Implemented revision 6 of the standard security handler, replacing the deprecated revision 5. Its passwords are UTF-8 encoded, so non-ASCII passwords now round-trip.
  - The PDF header is raised to the version the chosen cipher requires (1.6 for AES-128, 1.7 plus Adobe extension level 8 for AES-256), and never lowered.
  - Fixed a full save writing back the stale cross-reference streams parsed from the source file, which copied the source's plaintext into a document being encrypted. The trailer's `/Size` is now derived from the objects actually written.
  - Encryption is much faster: `encrypt()` followed by `save()` drops from ~120 ms to ~20 ms on a small file, using Node's `crypto` for revision 6 key derivation when the host provides it. Browsers and other hosts keep the JavaScript implementation, which derives byte-identical keys.
  - Speed up name interning in `PDFName.of()`, on a hot path of the whole library.
  - Fixed a quadratic insertion in the cross-reference stream, halving the time of a save that uses object streams.
  - Parsing and writing now yield through `setImmediate` on Node instead of `setTimeout(fn, 0)`, which Node clamps to a millisecond. Loading and saving a large document is about 4 times faster. Hosts without `setImmediate`, browsers among them, keep `setTimeout`.
  - Speed up the fallback that locates `endstream` when a stream's `/Length` is an indirect reference or is wrong.

**Imported changes up to 2.8.1 from @cantoo-scribe/pdf-lib fork:**

  - Convert documents to PDF/A-1/2/3 (`1B`, `2B`, `2U`, `3B`, `3U`) with `PDFDocument.convertToPDFA()` — OutputIntent (bundled sRGB), `/ID`, and XMP kept in sync with the Info dictionary on save.
  - Embed Factur-X / ZUGFeRD invoice XML with `embedFacturX()` (PDF/A-3 hybrid + required XMP).
  - Work with XFA forms: read signature fields, scripts, and related helpers on `PDFForm`.
  - Prefer maintained upstream [`fontkit`](https://www.npmjs.com/package/fontkit) v2 for custom font embedding. Subsetting now supports both `subset.encode()` (fontkit v2+) and `subset.encodeStream()` (`@pdf-lib/fontkit`), so existing registrations keep working.
  - Upgrade direct `pako` dependency from v1 to v2, and force transitive `pako` installs to `^2.2.0` via Yarn `resolutions` / npm `overrides` (consumers should mirror this in their own root `package.json`).
  - `PDFForm.flatten()` now also flattens orphaned widget annotations that carry field properties (`/FT`, `/V`, …) on the page `Annots` entry but are not registered in `AcroForm.Fields` (text fields and stateful checkboxes / radios).

## v2.7.0

- switch to npm + fix npm install by updating eslint dependencies
- Added optional **`dedupeContent`** flag to `PDFDocument.create()` and `PDFDocument.load()` (default: `false`). When set to `true`, duplicate fonts and images are de-duplicated across multiple calls to `copyPages` and `embedPages`, reducing PDF size. When `false`, deduplication is limited to individual calls, which may increase PDF size if the same content is embedded repeatedly.
