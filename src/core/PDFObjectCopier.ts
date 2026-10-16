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
 * When copying indirect objects, identical stream **payloads** (as encoded,
 * under the same `/Filter`) are merged only together with a matching
 * stream-dictionary fingerprint (BBox, Subtype, etc.), so page content and
 * form XObjects are not
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
  /** Stream buckets and indirect value fingerprints, by source object. */
  private readonly fingerprints = new Map<PDFObject, string | undefined>();

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

    let dedupKey: string | undefined;
    if (dereferencedValue instanceof PDFStream) {
      const bucket = this.streamBucket(dereferencedValue, new Set());
      if (bucket !== undefined) {
        const match = this.findCopiedStream(dereferencedValue, bucket);
        if (match.ref) {
          this.traversedObjects.set(ref, match.ref);
          return match.ref;
        }
        dedupKey = match.freeKey;
      }
    }

    const newRef = this.dest.nextRef();
    this.traversedObjects.set(ref, newRef);

    if (dereferencedValue) {
      const cloned = this.copy(dereferencedValue);
      this.dest.assign(newRef, cloned);
      if (dedupKey !== undefined) this.streamKeyToDestRef.set(dedupKey, newRef);
    }

    return newRef;
  };

  /**
   * Looks for an already copied stream identical to `stream`. Its bucket is
   * derived from the dictionary and the payload length only, so a stream with
   * a bucket of its own is never read. Otherwise it is compared with the
   * bucket's occupant and, if they differ, hashed into a sub-bucket. Every
   * match is confirmed byte for byte, so collisions cost time, never output.
   *
   * Returns either the copy to reuse or the key under which to register the
   * new copy, or neither when both slots hold other streams.
   */
  private findCopiedStream(
    stream: PDFStream,
    bucket: string,
  ): { ref?: PDFRef; freeKey?: string } {
    const occupant = this.streamKeyToDestRef.get(bucket);
    if (occupant === undefined) return { freeKey: bucket };
    if (this.isCopyOf(stream, occupant)) return { ref: occupant };

    const subBucket = `${bucket}#${hashBytes(payloadOf(stream))}`;
    const subOccupant = this.streamKeyToDestRef.get(subBucket);
    if (subOccupant === undefined) return { freeKey: subBucket };
    if (this.isCopyOf(stream, subOccupant)) return { ref: subOccupant };
    return {};
  }

  private isCopyOf(stream: PDFStream, destRef: PDFRef): boolean {
    const candidate = this.dest.lookup(destRef);
    return (
      candidate instanceof PDFStream &&
      this.isSameStream(stream, candidate, new Set())
    );
  }

  /**
   * The bucket of a stream that may be merged with an identical one, or
   * `undefined` when it must always be copied. Object numbers mean nothing
   * outside their source document, so indirect values in the stream
   * dictionary are fingerprinted by the value they point to. The fingerprint
   * is hashed so that buckets stay small however many documents are merged.
   */
  private streamBucket(
    stream: PDFStream,
    visiting: Set<PDFObject>,
  ): string | undefined {
    if (this.fingerprints.has(stream)) return this.fingerprints.get(stream);
    if (
      !(stream instanceof PDFRawStream || stream instanceof PDFContentStream) ||
      visiting.has(stream)
    ) {
      return undefined;
    }
    visiting.add(stream);
    let bucket: string | undefined;
    try {
      const dictFp = this.streamDictFingerprint(stream.dict, visiting);
      if (dictFp !== undefined) {
        const length = payloadOf(stream).length;
        bucket = `${fnv1a32String(dictFp)}:${dictFp.length}:${length}`;
      }
    } catch {
      bucket = undefined;
    } finally {
      visiting.delete(stream);
    }
    this.fingerprints.set(stream, bucket);
    return bucket;
  }

  /**
   * Stream bodies can match while PDF semantics differ (e.g. two Form XObjects
   * with different BBox), so all dictionary entries count except the lengths.
   */
  private streamDictFingerprint(
    dict: PDFDict,
    visiting: Set<PDFObject>,
  ): string | undefined {
    const ents = dict
      .entries()
      .filter(([key]) => !IGNORED_STREAM_KEYS.has(key));
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
      if (target === undefined || isDocumentStructure(target)) return undefined;
      if (target instanceof PDFStream) {
        const bucket = this.streamBucket(target, visiting);
        return bucket === undefined ? undefined : `R{${bucket}}`;
      }
      if (this.fingerprints.has(target)) return this.fingerprints.get(target);
      if (visiting.has(target)) return undefined;
      visiting.add(target);
      let fp: string | undefined;
      try {
        const inner = this.valueFingerprint(target, context, visiting);
        fp = inner === undefined ? undefined : `R{${inner}}`;
      } finally {
        visiting.delete(target);
      }
      this.fingerprints.set(target, fp);
      return fp;
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
   * Whether `a`, from the source document, and `b`, from the destination,
   * have the same payload and dictionary, following indirect values on both
   * sides.
   */
  private isSameStream(
    a: PDFStream,
    b: PDFStream,
    visiting: Set<PDFObject>,
  ): boolean {
    if (visiting.has(a)) return false;
    visiting.add(a);
    try {
      if (a instanceof PDFRawStream !== b instanceof PDFRawStream) {
        return false;
      }
      if (!bytesEqual(payloadOf(a), payloadOf(b))) return false;

      const entriesA = a.dict
        .entries()
        .filter(([key]) => !IGNORED_STREAM_KEYS.has(key));
      const entriesB = b.dict
        .entries()
        .filter(([key]) => !IGNORED_STREAM_KEYS.has(key));
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

  private isSameValue(
    a: PDFObject,
    contextA: PDFContext,
    b: PDFObject,
    contextB: PDFContext,
    visiting: Set<PDFObject>,
  ): boolean {
    if (a instanceof PDFRef || b instanceof PDFRef) {
      if (!(a instanceof PDFRef && b instanceof PDFRef)) return false;
      // `b` is then the copy of `a` this copier made or matched earlier.
      if (this.traversedObjects.get(a) === b) return true;
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

/**
 * Entries that only restate the payload size. Everything else, `/Filter`
 * included, is compared: payloads are compared as encoded, without decoding.
 */
const IGNORED_STREAM_KEYS = new Set([PDFName.of('Length'), PDFName.of('DL')]);

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

const payloadOf = (stream: PDFStream): Uint8Array =>
  stream instanceof PDFContentStream
    ? stream.getUnencodedContents()
    : stream.getContents();

/**
 * FNV-1a over 32-bit words, four times faster than over bytes. Word order
 * depends on the platform, which is fine for keys that never leave memory.
 */
const hashBytes = (bytes: Uint8Array): number => {
  // Not `slice()`: on a Node Buffer it returns a view at the same offset.
  const data = bytes.byteOffset % 4 === 0 ? bytes : new Uint8Array(bytes);
  const words = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
  let h = 2166136261;
  for (let idx = 0, len = words.length; idx < len; idx++) {
    h = Math.imul(h ^ words[idx], 16777619);
  }
  for (let idx = words.length << 2, len = data.length; idx < len; idx++) {
    h = Math.imul(h ^ data[idx], 16777619);
  }
  return h >>> 0;
};

type BytesCompare = (a: Uint8Array, b: Uint8Array) => number;

interface HostWithBuiltinModules {
  process?: { getBuiltinModule?: (id: string) => unknown };
}

/**
 * Node's `Buffer.compare` is a `memcmp`, an order of magnitude faster than any
 * JavaScript loop. It is loaded the same way as in `nodeCrypto.ts`, so that
 * bundles for browsers, Deno and React Native keep working.
 */
const loadNativeCompare = (): BytesCompare | undefined => {
  try {
    const host = globalThis as HostWithBuiltinModules;
    const module = host.process?.getBuiltinModule?.('buffer') as
      | { Buffer?: { compare?: BytesCompare } }
      | undefined;
    const compare = module?.Buffer?.compare;
    return typeof compare === 'function'
      ? compare.bind(module!.Buffer)
      : undefined;
  } catch {
    return undefined;
  }
};

// `null` means "not looked up yet"; `undefined` means "not available here".
let nativeCompare: BytesCompare | undefined | null = null;

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  if (nativeCompare === null) nativeCompare = loadNativeCompare();
  if (nativeCompare) return nativeCompare(a, b) === 0;

  let idx = 0;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const count = a.length >> 2;
    const wordsA = new Uint32Array(a.buffer, a.byteOffset, count);
    const wordsB = new Uint32Array(b.buffer, b.byteOffset, count);
    for (; idx < count; idx++) if (wordsA[idx] !== wordsB[idx]) return false;
    idx = count << 2;
  }
  for (const len = a.length; idx < len; idx++) {
    if (a[idx] !== b[idx]) return false;
  }
  return true;
};

const fnv1a32String = (text: string): number => {
  let h = 2166136261;
  for (let idx = 0, len = text.length; idx < len; idx++) {
    h ^= text.charCodeAt(idx);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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
