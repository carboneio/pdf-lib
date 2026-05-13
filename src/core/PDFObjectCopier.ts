import PDFArray from './objects/PDFArray';
import PDFBool from './objects/PDFBool';
import PDFDict from './objects/PDFDict';
import PDFHexString from './objects/PDFHexString';
import PDFName from './objects/PDFName';
import PDFNull from './objects/PDFNull';
import PDFNumber from './objects/PDFNumber';
import PDFObject from './objects/PDFObject';
import PDFRawStream from './objects/PDFRawStream';
import PDFRef from './objects/PDFRef';
import PDFStream from './objects/PDFStream';
import PDFString from './objects/PDFString';
import PDFContext from './PDFContext';
import PDFContentStream from './structures/PDFContentStream';
import PDFPageLeaf from './structures/PDFPageLeaf';
import { decodePDFRawStream } from './streams/decode';

/**
 * PDFObjectCopier copies PDFObjects from a src context to a dest context.
 * The primary use case for this is to copy pages between PDFs.
 *
 * _Copying_ an object with a PDFObjectCopier is different from _cloning_ an
 * object with its [[PDFObject.clone]] method:
 *
 * ```
 *   const src: PDFContext = ...
 *   const dest: PDFContext = ...
 *   const originalObject: PDFObject = ...
 *   const copiedObject = PDFObjectCopier.for(src, dest).copy(originalObject);
 *   const clonedObject = originalObject.clone();
 * ```
 *
 * Copying an object is equivalent to cloning it and then copying over any other
 * objects that it references. Note that only dictionaries, arrays, and streams
 * (or structures build from them) can contain indirect references to other
 * objects. Copying a PDFObject that is not a dictionary, array, or stream is
 * supported, but is equivalent to cloning it.
 *
 * When copying indirect objects, identical stream **payloads** (after
 * decoding) are merged only together with a matching stream-dictionary
 * fingerprint (BBox, Subtype, etc.), so page content and form XObjects are not
 * confused when byte content happens to match. Dictionary-level merging of
 * fonts or `/Resources` is not done — it caused encoding / glyph mismatches.
 *
 * Pass an optional shared `streamKeyToDestRef` map so identical streams can
 * merge across different source documents merged into one output.
 */
class PDFObjectCopier {
  static for = (
    src: PDFContext,
    dest: PDFContext,
    streamKeyToDestRef?: Map<string, PDFRef>,
  ) => new PDFObjectCopier(src, dest, streamKeyToDestRef);

  private readonly src: PDFContext;
  private readonly dest: PDFContext;
  private readonly traversedObjects = new Map<PDFObject, PDFObject>();
  private readonly streamKeyToDestRef: Map<string, PDFRef>;

  private constructor(
    src: PDFContext,
    dest: PDFContext,
    streamKeyToDestRef?: Map<string, PDFRef>,
  ) {
    this.src = src;
    this.dest = dest;
    this.streamKeyToDestRef = streamKeyToDestRef ?? new Map();
  }

  // prettier-ignore
  copy = <T extends PDFObject>(object: T): T => (
      object instanceof PDFPageLeaf ? this.copyPDFPage(object)
    : object instanceof PDFDict     ? this.copyPDFDict(object)
    : object instanceof PDFArray    ? this.copyPDFArray(object)
    : object instanceof PDFStream   ? this.copyPDFStream(object)
    : object instanceof PDFRef      ? this.copyPDFIndirectObject(object)
    : object.clone()
  ) as T;

  private copyPDFPage = (originalPage: PDFPageLeaf): PDFPageLeaf => {
    const clonedPage = originalPage.clone();

    // Move any entries that the originalPage is inheriting from its parent
    // tree nodes directly into originalPage so they are preserved during
    // the copy.
    const { InheritableEntries } = PDFPageLeaf;
    for (let idx = 0, len = InheritableEntries.length; idx < len; idx++) {
      const key = PDFName.of(InheritableEntries[idx]);
      const value = clonedPage.getInheritableAttribute(key)!;
      if (!clonedPage.get(key) && value) clonedPage.set(key, value);
    }

    // Remove the parent reference to prevent the whole donor document's page
    // tree from being copied when we only need a single page.
    clonedPage.delete(PDFName.of('Parent'));

    return this.copyPDFDict(clonedPage) as PDFPageLeaf;
  };

  private copyPDFDict = (originalDict: PDFDict): PDFDict => {
    if (this.traversedObjects.has(originalDict)) {
      return this.traversedObjects.get(originalDict) as PDFDict;
    }

    const clonedDict = originalDict.clone(this.dest);
    this.traversedObjects.set(originalDict, clonedDict);

    const entries = originalDict.entries();

    for (let idx = 0, len = entries.length; idx < len; idx++) {
      const [key, value] = entries[idx];
      clonedDict.set(key, this.copy(value));
    }

    return clonedDict;
  };

  private copyPDFArray = (originalArray: PDFArray): PDFArray => {
    if (this.traversedObjects.has(originalArray)) {
      return this.traversedObjects.get(originalArray) as PDFArray;
    }

    const clonedArray = originalArray.clone(this.dest);
    this.traversedObjects.set(originalArray, clonedArray);

    for (let idx = 0, len = originalArray.size(); idx < len; idx++) {
      const value = originalArray.get(idx);
      clonedArray.set(idx, this.copy(value));
    }

    return clonedArray;
  };

  private copyPDFStream = (originalStream: PDFStream): PDFStream => {
    if (this.traversedObjects.has(originalStream)) {
      return this.traversedObjects.get(originalStream) as PDFStream;
    }

    const clonedStream = originalStream.clone(this.dest);
    this.traversedObjects.set(originalStream, clonedStream);

    const entries = originalStream.dict.entries();
    for (let idx = 0, len = entries.length; idx < len; idx++) {
      const [key, value] = entries[idx];
      clonedStream.dict.set(key, this.copy(value));
    }

    return clonedStream;
  };

  private copyPDFIndirectObject = (ref: PDFRef): PDFRef => {
    if (this.traversedObjects.has(ref)) {
      return this.traversedObjects.get(ref) as PDFRef;
    }

    const dereferencedValue = this.src.lookup(ref);

    if (dereferencedValue) {
      if (dereferencedValue instanceof PDFStream) {
        const streamKey = this.streamByteDedupKey(dereferencedValue);
        if (streamKey) {
          const existingStreamRef = this.streamKeyToDestRef.get(streamKey);
          if (existingStreamRef) {
            this.traversedObjects.set(ref, existingStreamRef);
            return existingStreamRef;
          }
        }
      }
    }

    const newRef = this.dest.nextRef();
    this.traversedObjects.set(ref, newRef);

    if (dereferencedValue) {
      const cloned = this.copy(dereferencedValue);
      this.dest.assign(newRef, cloned);

      if (dereferencedValue instanceof PDFStream) {
        const streamKey = this.streamByteDedupKey(dereferencedValue);
        if (streamKey) {
          this.streamKeyToDestRef.set(streamKey, newRef);
        }
      }
    }

    return newRef;
  };

  private fnv1a32(data: Uint8Array): number {
    let h = 2166136261;
    for (let idx = 0, len = data.length; idx < len; idx++) {
      h ^= data[idx];
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  private streamByteDedupKey(stream: PDFStream): string | undefined {
    try {
      if (stream instanceof PDFRawStream) {
        try {
          const decoded = decodePDFRawStream(stream).decode();
          return this.streamKeyFromDecoded(stream, decoded);
        } catch {
          const raw = stream.getContents();
          return `${this.streamDictFingerprint(stream.dict)}:raw:${raw.length}:${this.fnv1a32(raw)}`;
        }
      }
      if (stream instanceof PDFContentStream) {
        const decoded = stream.getUnencodedContents();
        return this.streamKeyFromDecoded(stream, decoded);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private streamKeyFromDecoded(stream: PDFStream, decoded: Uint8Array): string {
    const dictFp = this.streamDictFingerprint(stream.dict);
    const parts: string[] = [
      dictFp,
      String(decoded.length),
      String(this.fnv1a32(decoded)),
    ];
    return parts.join(':');
  }

  /**
   * Stream bodies can match while PDF semantics differ (e.g. two Form XObjects
   * with different BBox). Include all dict entries except ones that only
   * describe encoding of the byte payload.
   */
  private streamDictFingerprint(dict: PDFDict): string {
    const skipKeys = new Set([
      'Length',
      'Filter',
      'DecodeParms',
      'DL',
      'F',
      'FFilter',
      'FDecodeParms',
    ]);
    const ents = dict.entries().slice();
    ents.sort((a, b) => a[0].asString().localeCompare(b[0].asString()));
    const parts = new Array<string>(ents.length);
    let n = 0;
    for (let idx = 0, len = ents.length; idx < len; idx++) {
      const [key, value] = ents[idx];
      if (skipKeys.has(key.asString())) continue;
      parts[n++] =
        `${key.asString()}=${this.streamDictValueFingerprint(value)}`;
    }
    parts.length = n;
    return parts.join('|');
  }

  private streamDictValueFingerprint(value: PDFObject): string {
    if (value instanceof PDFName) return `N(${value.asString()})`;
    if (value instanceof PDFNumber) return `Num(${value.asNumber()})`;
    if (value instanceof PDFString) return `S(${value.asString()})`;
    if (value instanceof PDFHexString) return `H(${value.asString()})`;
    if (value instanceof PDFBool) {
      return value.asBoolean() ? 'B(true)' : 'B(false)';
    }
    if (value === PDFNull) return 'null';
    if (value instanceof PDFRef) {
      return `R(${value.objectNumber}.${value.generationNumber})`;
    }
    if (value instanceof PDFArray) {
      const items = new Array<string>(value.size());
      for (let idx = 0, len = value.size(); idx < len; idx++) {
        items[idx] = this.streamDictValueFingerprint(value.get(idx));
      }
      return `[${items.join(',')}]`;
    }
    if (value instanceof PDFDict) {
      const ents = value.entries().slice();
      ents.sort((a, b) => a[0].asString().localeCompare(b[0].asString()));
      const inner = ents.map(
        ([k, v]) => `${k.asString()}=${this.streamDictValueFingerprint(v)}`,
      );
      return `{${inner.join(';')}}`;
    }
    return '?';
  }
}

export default PDFObjectCopier;
