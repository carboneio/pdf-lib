# Changelog

## Unreleased


## v2.8.0

  - Fixed password encryption so document properties (Info dictionary strings such as Title, Author, Subject) are encrypted when `StrF` is set, and correctly decrypted when loading encrypted PDFs (including those that use object streams / XRef streams). Encrypted files now interoperate with viewers and tools such as Chrome, Preview, pdfinfo, and qpdf.
  - Fixed encryption of strings that are stored as indirect objects, which were previously written in plaintext.
  - The signed contents (`/Contents`) of a signature dictionary are no longer encrypted, as required by ISO 32000-2.
  - Only the trailer / cross-reference stream file identifier is exempt from encryption. An `/ID` entry in any other dictionary is now encrypted like any other string.
  - **Breaking:** `PDFDocument.encrypt()` now defaults to AES-256 (`/V 5`, `/R 6`), the only algorithm ISO 32000-2 still defines. Previously the cipher was inferred from the document's PDF version, so encrypting a 1.3 file silently produced 40-bit RC4 and a 1.4 or 1.5 file produced 128-bit RC4 — both broken. A document's version describes the syntax its producer used, not what the reader opening the encrypted file supports, so it no longer selects the cipher.
  - Implemented revision 6 of the standard security handler (ISO 32000-2 Algorithm 2.B, the iterated SHA-256/384/512 hash). AES-256 previously used the deprecated Adobe revision 5, whose single SHA-256 makes password guessing cheap, and was unreachable through the public API anyway. Revision 6 passwords are UTF-8 encoded, so non-ASCII passwords now round-trip.
  - The header is raised to the lowest version that defines the chosen handler (1.6 for AES-128, 1.7 for AES-256), and never lowered. For AES-256 in a 1.7 file, the catalog declares Adobe extension level 8. Encrypted files therefore no longer advertise a version older than the encryption they use. This matches `qpdf` byte for byte on `/V`, `/R`, the header, and `/Extensions`.
  - Added `SecurityOptions.algorithm` (`'AES-256'` by default, `'AES-128'`, `'RC4-128'`, `'RC4-40'`). Selecting an RC4 variant throws unless `SecurityOptions.allowWeakCryptography` is also set, mirroring `qpdf`'s `--allow-weak-crypto`.
  - Fixed a full save writing back the cross-reference streams parsed from the source file. A full save regenerates the cross-reference section, so those copies are stale: they hold byte offsets into the source file and are unreachable from the object graph. Because cross-reference streams are deliberately written in the clear, keeping one copied the source's plaintext — its `/ID`, and its whole inflatable payload — straight into a document being encrypted. Only the last few object numbers used to be searched, so any file whose cross-reference stream sits earlier slipped through; linearized files put the first-page one near the front.
  - The trailer's `/Size` is now derived from the highest object number actually written rather than the highest the context holds, so dropping stale objects cannot overstate it.
  - Revision 6 key derivation uses Node's `crypto` when the host provides it, taking a derivation from ~20 ms to ~0.5 ms. Algorithm 2.B is costly by design — at least 64 rounds of hashing and AES-encrypting ~2 KB each — and encrypting a document derives four keys, so `encrypt()` followed by `save()` drops from ~120 ms to ~20 ms on a small file. Browsers, Deno, React Native and Node older than 20.16 keep the JavaScript implementation, which is verified to derive byte-identical keys. `crypto` is reached through `process.getBuiltinModule` rather than a static import, leaving the browser bundles free of any Node dependency.
  - Speed up conversion of CryptoJS word arrays to bytes, which allocated an intermediate JavaScript array one byte at a time before copying it into a `Uint8Array`.
  - Speed up name interning in `PDFName.of()`, on a hot path of the whole library.
  - Fixed a quadratic insertion in the cross-reference stream, halving the time of a save that uses object streams.
  - Parsing and writing now yield through `setImmediate` on Node instead of `setTimeout(fn, 0)`, which Node clamps to a millisecond. Loading and saving a large document is about 4 times faster. Hosts without `setImmediate`, browsers among them, keep `setTimeout`.
  - Speed up the fallback that locates `endstream` when a stream's `/Length` is an indirect reference or is wrong.

**Imported changes from 2.8.0 to 2.8.1 (from cantoo/fork):**

  - Convert documents to PDF/A-1/2/3 (`1B`, `2B`, `2U`, `3B`, `3U`) with `PDFDocument.convertToPDFA()` — OutputIntent (bundled sRGB), `/ID`, and XMP kept in sync with the Info dictionary on save.
  - Embed Factur-X / ZUGFeRD invoice XML with `embedFacturX()` (PDF/A-3 hybrid + required XMP).
  - Work with XFA forms: read signature fields, scripts, and related helpers on `PDFForm`.
  - Prefer maintained upstream [`fontkit`](https://www.npmjs.com/package/fontkit) v2 for custom font embedding. Subsetting now supports both `subset.encode()` (fontkit v2+) and `subset.encodeStream()` (`@pdf-lib/fontkit`), so existing registrations keep working.
  - Upgrade direct `pako` dependency from v1 to v2, and force transitive `pako` installs to `^2.2.0` via Yarn `resolutions` / npm `overrides` (consumers should mirror this in their own root `package.json`).
  - `PDFForm.flatten()` now also flattens orphaned widget annotations that carry field properties (`/FT`, `/V`, …) on the page `Annots` entry but are not registered in `AcroForm.Fields` (text fields and stateful checkboxes / radios).

## v2.7.0

- switch to npm + fix npm install by updating eslint dependencies
- Added optional **`dedupeContent`** flag to `PDFDocument.create()` and `PDFDocument.load()` (default: `false`). When set to `true`, duplicate fonts and images are de-duplicated across multiple calls to `copyPages` and `embedPages`, reducing PDF size. When `false`, deduplication is limited to individual calls, which may increase PDF size if the same content is embedded repeatedly.
