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
import { isArrayEqual } from '../utils';

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
 * confused when byte content happens to match. Objects referenced from that
 * dictionary (`/SMask`, `/ColorSpace`, `/Resources`) are compared by value, as
 * object numbers differ between documents, and every match is confirmed byte
 * for byte. Dictionary-level merging of fonts or `/Resources` is not done — it
 * caused encoding / glyph mismatches.
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

    const streamKey =
      dereferencedValue instanceof PDFStream
        ? this.streamDedupKey(dereferencedValue, new Set())
        : undefined;
    if (streamKey !== undefined) {
      const existingRef = this.streamKeyToDestRef.get(streamKey);
      const existing = existingRef && this.dest.lookup(existingRef);
      if (
        existingRef &&
        existing instanceof PDFStream &&
        this.isSameStream(dereferencedValue as PDFStream, existing, new Set())
      ) {
        this.traversedObjects.set(ref, existingRef);
        return existingRef;
      }
    }

    const newRef = this.dest.nextRef();
    this.traversedObjects.set(ref, newRef);

    if (dereferencedValue) {
      const cloned = this.copy(dereferencedValue);
      this.dest.assign(newRef, cloned);

      if (streamKey !== undefined && !this.streamKeyToDestRef.has(streamKey)) {
        this.streamKeyToDestRef.set(streamKey, newRef);
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

  /**
   * The bytes a stream stands for: decoded when its filters are supported,
   * raw otherwise.
   */
  private payloadOf(stream: PDFStream): {
    bytes: Uint8Array;
    decoded: boolean;
  } {
    if (stream instanceof PDFContentStream) {
      return { bytes: stream.getUnencodedContents(), decoded: true };
    }
    try {
      const bytes = decodePDFRawStream(stream as PDFRawStream).decode();
      return { bytes, decoded: true };
    } catch {
      return { bytes: stream.getContents(), decoded: false };
    }
  }

  /**
   * A lookup key for a stream that may be merged with an identical one, or
   * `undefined` when it must always be copied. Object numbers mean nothing
   * outside their source document, so indirect values in the stream
   * dictionary are keyed by the value they point to.
   *
   * The key only finds candidates: [[isSameStream]] confirms each match.
   */
  private streamDedupKey(
    stream: PDFStream,
    visiting: Set<PDFObject>,
  ): string | undefined {
    if (
      !(stream instanceof PDFRawStream || stream instanceof PDFContentStream) ||
      visiting.has(stream)
    ) {
      return undefined;
    }
    visiting.add(stream);
    try {
      const dictFp = this.streamDictFingerprint(stream.dict, visiting);
      if (dictFp === undefined) return undefined;
      const { bytes, decoded } = this.payloadOf(stream);
      const encoding = decoded ? '' : 'raw:';
      return `${dictFp}:${encoding}${bytes.length}:${this.fnv1a32(bytes)}`;
    } catch {
      return undefined;
    } finally {
      visiting.delete(stream);
    }
  }

  /**
   * Stream bodies can match while PDF semantics differ (e.g. two Form XObjects
   * with different BBox). Include all dict entries except ones that only
   * describe encoding of the byte payload.
   */
  private streamDictFingerprint(
    dict: PDFDict,
    visiting: Set<PDFObject>,
  ): string | undefined {
    const ents = dict
      .entries()
      .filter(([key]) => !STREAM_ENCODING_KEYS.has(key));
    ents.sort((a, b) => a[0].asString().localeCompare(b[0].asString()));
    const parts = new Array<string>(ents.length);
    for (let idx = 0, len = ents.length; idx < len; idx++) {
      const [key, value] = ents[idx];
      const fp = this.valueFingerprint(value, dict.context, visiting);
      if (fp === undefined) return undefined;
      parts[idx] = `${key.asString()}=${fp}`;
    }
    return parts.join('|');
  }

  private valueFingerprint(
    value: PDFObject,
    context: PDFContext,
    visiting: Set<PDFObject>,
  ): string | undefined {
    if (value instanceof PDFRef) {
      const target = context.lookup(value);
      if (
        target === undefined ||
        visiting.has(target) ||
        isDocumentStructure(target)
      ) {
        return undefined;
      }
      if (target instanceof PDFStream) {
        const key = this.streamDedupKey(target, visiting);
        return key === undefined ? undefined : `R{${key}}`;
      }
      visiting.add(target);
      try {
        const fp = this.valueFingerprint(target, context, visiting);
        return fp === undefined ? undefined : `R{${fp}}`;
      } finally {
        visiting.delete(target);
      }
    }
    if (value instanceof PDFArray) {
      const items = new Array<string>(value.size());
      for (let idx = 0, len = value.size(); idx < len; idx++) {
        const fp = this.valueFingerprint(value.get(idx), context, visiting);
        if (fp === undefined) return undefined;
        items[idx] = fp;
      }
      return `[${items.join(',')}]`;
    }
    if (value instanceof PDFDict) {
      const ents = value.entries().slice();
      ents.sort((a, b) => a[0].asString().localeCompare(b[0].asString()));
      const inner = new Array<string>(ents.length);
      for (let idx = 0, len = ents.length; idx < len; idx++) {
        const [key, entry] = ents[idx];
        const fp = this.valueFingerprint(entry, context, visiting);
        if (fp === undefined) return undefined;
        inner[idx] = `${key.asString()}=${fp}`;
      }
      return `{${inner.join(';')}}`;
    }
    return primitiveFingerprint(value);
  }

  /**
   * Byte-for-byte confirmation of a key match, following indirect streams on
   * both sides, so that a hash collision can never merge different streams.
   */
  private isSameStream(
    a: PDFStream,
    b: PDFStream,
    visiting: Set<PDFObject>,
  ): boolean {
    if (visiting.has(a)) return false;
    visiting.add(a);
    try {
      if (!this.hasSamePayload(a, b, visiting)) return false;

      const entriesA = a.dict
        .entries()
        .filter(([key]) => !STREAM_ENCODING_KEYS.has(key));
      const entriesB = b.dict
        .entries()
        .filter(([key]) => !STREAM_ENCODING_KEYS.has(key));
      if (entriesA.length !== entriesB.length) return false;
      for (let idx = 0, len = entriesA.length; idx < len; idx++) {
        const [key, valueA] = entriesA[idx];
        const valueB = b.dict.get(key);
        if (
          valueB === undefined ||
          !this.isSameValue(
            valueA,
            a.dict.context,
            valueB,
            b.dict.context,
            visiting,
          )
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    } finally {
      visiting.delete(a);
    }
  }

  /**
   * Equal encoded bytes under equal filters settle the question without
   * decoding; otherwise the decoded bytes are compared.
   */
  private hasSamePayload(
    a: PDFStream,
    b: PDFStream,
    visiting: Set<PDFObject>,
  ): boolean {
    if (
      a instanceof PDFRawStream &&
      b instanceof PDFRawStream &&
      isArrayEqual(a.getContents(), b.getContents()) &&
      this.isSameEntry(a, b, PDFName.of('Filter'), visiting) &&
      this.isSameEntry(a, b, PDFName.of('DecodeParms'), visiting)
    ) {
      return true;
    }
    const payloadA = this.payloadOf(a);
    const payloadB = this.payloadOf(b);
    return (
      payloadA.decoded === payloadB.decoded &&
      isArrayEqual(payloadA.bytes, payloadB.bytes)
    );
  }

  private isSameEntry(
    a: PDFStream,
    b: PDFStream,
    key: PDFName,
    visiting: Set<PDFObject>,
  ): boolean {
    const valueA = a.dict.get(key);
    const valueB = b.dict.get(key);
    if (valueA === undefined || valueB === undefined) return valueA === valueB;
    return this.isSameValue(
      valueA,
      a.dict.context,
      valueB,
      b.dict.context,
      visiting,
    );
  }

  private isSameValue(
    a: PDFObject,
    contextA: PDFContext,
    b: PDFObject,
    contextB: PDFContext,
    visiting: Set<PDFObject>,
  ): boolean {
    if (a instanceof PDFRef || b instanceof PDFRef) {
      if (!(a instanceof PDFRef && b instanceof PDFRef)) return false;
      const targetA = contextA.lookup(a);
      const targetB = contextB.lookup(b);
      if (
        targetA === undefined ||
        targetB === undefined ||
        visiting.has(targetA) ||
        isDocumentStructure(targetA)
      ) {
        return false;
      }
      if (targetA instanceof PDFStream || targetB instanceof PDFStream) {
        return (
          targetA instanceof PDFStream &&
          targetB instanceof PDFStream &&
          this.isSameStream(targetA, targetB, visiting)
        );
      }
      visiting.add(targetA);
      try {
        return this.isSameValue(targetA, contextA, targetB, contextB, visiting);
      } finally {
        visiting.delete(targetA);
      }
    }
    if (a instanceof PDFArray || b instanceof PDFArray) {
      if (!(a instanceof PDFArray && b instanceof PDFArray)) return false;
      if (a.size() !== b.size()) return false;
      for (let idx = 0, len = a.size(); idx < len; idx++) {
        if (
          !this.isSameValue(
            a.get(idx),
            contextA,
            b.get(idx),
            contextB,
            visiting,
          )
        ) {
          return false;
        }
      }
      return true;
    }
    if (a instanceof PDFDict || b instanceof PDFDict) {
      if (!(a instanceof PDFDict && b instanceof PDFDict)) return false;
      const entriesA = a.entries();
      if (entriesA.length !== b.entries().length) return false;
      for (let idx = 0, len = entriesA.length; idx < len; idx++) {
        const [key, valueA] = entriesA[idx];
        const valueB = b.get(key);
        if (
          valueB === undefined ||
          !this.isSameValue(valueA, contextA, valueB, contextB, visiting)
        ) {
          return false;
        }
      }
      return true;
    }
    const fingerprintA = primitiveFingerprint(a);
    return (
      fingerprintA !== undefined && fingerprintA === primitiveFingerprint(b)
    );
  }
}

/** Dictionary entries that only describe how a stream payload is encoded. */
const STREAM_ENCODING_KEYS = new Set(
  ['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms'].map(
    (key) => PDFName.of(key),
  ),
);

/**
 * Objects whose value takes in the whole document, which no stream can be
 * shown to share with a stream from another document.
 */
const isDocumentStructure = (object: PDFObject): boolean => {
  if (object instanceof PDFPageLeaf) return true;
  if (!(object instanceof PDFDict)) return false;
  const type = object.get(PDFName.of('Type'));
  return (
    type === PDFName.of('Page') ||
    type === PDFName.of('Pages') ||
    type === PDFName.of('Catalog')
  );
};

const primitiveFingerprint = (value: PDFObject): string | undefined => {
  if (value instanceof PDFName) return `N(${value.asString()})`;
  if (value instanceof PDFNumber) return `Num(${value.asNumber()})`;
  if (value instanceof PDFString) return `S(${value.asString()})`;
  if (value instanceof PDFHexString) return `H(${value.asString()})`;
  if (value instanceof PDFBool) {
    return value.asBoolean() ? 'B(true)' : 'B(false)';
  }
  if (value === PDFNull) return 'null';
  return undefined;
};

export default PDFObjectCopier;
