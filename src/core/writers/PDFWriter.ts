import PDFCrossRefSection from '../document/PDFCrossRefSection';
import PDFHeader from '../document/PDFHeader';
import PDFTrailer from '../document/PDFTrailer';
import PDFTrailerDict from '../document/PDFTrailerDict';
import PDFArray from '../objects/PDFArray';
import PDFDict from '../objects/PDFDict';
import PDFHexString from '../objects/PDFHexString';
import PDFObject from '../objects/PDFObject';
import PDFRef from '../objects/PDFRef';
import PDFStream from '../objects/PDFStream';
import PDFString from '../objects/PDFString';
import PDFContext from '../PDFContext';
import PDFObjectStream from '../structures/PDFObjectStream';
import PDFSecurity, { EncryptFn } from '../security/PDFSecurity';
import CharCodes from '../syntax/CharCodes';
import { copyStringIntoBuffer, waitForTick } from '../../utils';
import {
  DefaultDocumentSnapshot,
  defaultDocumentSnapshot,
} from '../../api/snapshot';
import type { DocumentSnapshot } from '../../api/snapshot';
import PDFNumber from '../objects/PDFNumber';
import PDFName from '../objects/PDFName';
import PDFRawStream from '../objects/PDFRawStream';

export interface SerializationInfo {
  size: number;
  header: PDFHeader;
  indirectObjects: [PDFRef, PDFObject][];
  xref?: PDFCrossRefSection;
  trailerDict?: PDFTrailerDict;
  trailer: PDFTrailer;
}

class PDFWriter {
  static forContext = (context: PDFContext, objectsPerTick: number) =>
    new PDFWriter(context, objectsPerTick, defaultDocumentSnapshot);

  static forContextWithSnapshot = (
    context: PDFContext,
    objectsPerTick: number,
    snapshot: DocumentSnapshot,
  ) => new PDFWriter(context, objectsPerTick, snapshot);

  protected readonly context: PDFContext;

  protected readonly objectsPerTick: number;
  protected readonly snapshot: DocumentSnapshot;
  private parsedObjects = 0;

  protected constructor(
    context: PDFContext,
    objectsPerTick: number,
    snapshot: DocumentSnapshot,
  ) {
    this.context = context;
    this.objectsPerTick = objectsPerTick;
    this.snapshot = snapshot;
  }

  /**
   * Highest object number actually written. Skipped objects leave gaps, so the
   * context's largest object number can overstate what the file contains.
   */
  protected _largestSavedObjectNum: number = 0;

  /**
   * Whether an indirect object is written out.
   *
   * An incremental save keeps the original bytes and only appends, so the
   * snapshot decides. A full save rebuilds the whole file, which makes the parts
   * it regenerates from scratch stale; see [[isStaleCopiedObject]].
   *
   * @param incremental If making an incremental save, or a full save of the PDF
   * @param ref Reference the object is registered under
   * @param object The object itself
   * @returns whether the object should be saved or not
   */
  protected shouldSave(
    incremental: boolean,
    ref: PDFRef,
    object: PDFObject,
  ): boolean {
    const should = incremental
      ? this.snapshot.shouldSave(ref.objectNumber)
      : !this.isStaleCopiedObject(object);

    if (should && this._largestSavedObjectNum < ref.objectNumber) {
      this._largestSavedObjectNum = ref.objectNumber;
    }

    return should;
  }

  /**
   * Whether `object` was parsed from the source file but is regenerated from
   * scratch by a full save, which leaves the parsed copy stale.
   *
   * Neither kind is reachable from the object graph — a reader reaches them only
   * through `startxref` and `/Prev`, which a full save rewrites — so writing them
   * back serves no purpose, and does harm:
   *
   * - A cross-reference stream holds byte offsets into the *source* file, which
   *   mean nothing once objects move. Worse, cross-reference streams are written
   *   in the clear, so keeping one copies the source's plaintext (its `/ID`, and
   *   its whole inflatable payload) into a document that is being encrypted.
   * - An object stream container's contents were already extracted and
   *   registered individually by PDFObjectStreamParser. Re-serialising the
   *   container duplicates them, and on the next load the stale copies overwrite
   *   the current ones (last assignment wins), silently discarding any change
   *   made in between.
   *
   * Only copies from the source qualify: a full save regenerates these as a
   * PDFCrossRefStream or a PDFObjectStream, never as a PDFRawStream.
   */
  protected isStaleCopiedObject(object: PDFObject): boolean {
    if (!(object instanceof PDFRawStream)) return false;
    const type = object.dict.lookup(PDFName.of('Type'));
    return type === PDFName.of('XRef') || type === PDFName.of('ObjStm');
  }

  async serializeToBuffer() {
    const incremental = !(this.snapshot instanceof DefaultDocumentSnapshot);
    const { size, header, indirectObjects, xref, trailerDict, trailer } =
      await this.computeBufferSize(incremental);

    let offset = 0;
    const buffer = new Uint8Array(size);

    if (!incremental) {
      offset += header.copyBytesInto(buffer, offset);
      buffer[offset++] = CharCodes.Newline;
    }
    buffer[offset++] = CharCodes.Newline;

    for (let idx = 0, len = indirectObjects.length; idx < len; idx++) {
      const [ref, object] = indirectObjects[idx];

      if (!this.shouldSave(incremental, ref, object)) continue;

      const objectNumber = String(ref.objectNumber);
      offset += copyStringIntoBuffer(objectNumber, buffer, offset);
      buffer[offset++] = CharCodes.Space;

      const generationNumber = String(ref.generationNumber);
      offset += copyStringIntoBuffer(generationNumber, buffer, offset);
      buffer[offset++] = CharCodes.Space;

      buffer[offset++] = CharCodes.o;
      buffer[offset++] = CharCodes.b;
      buffer[offset++] = CharCodes.j;
      buffer[offset++] = CharCodes.Newline;

      offset += object.copyBytesInto(buffer, offset);

      buffer[offset++] = CharCodes.Newline;
      buffer[offset++] = CharCodes.e;
      buffer[offset++] = CharCodes.n;
      buffer[offset++] = CharCodes.d;
      buffer[offset++] = CharCodes.o;
      buffer[offset++] = CharCodes.b;
      buffer[offset++] = CharCodes.j;
      buffer[offset++] = CharCodes.Newline;
      buffer[offset++] = CharCodes.Newline;

      const n =
        object instanceof PDFObjectStream ? object.getObjectsCount() : 1;
      if (this.shouldWaitForTick(n)) await waitForTick();
    }

    if (xref) {
      offset += xref.copyBytesInto(buffer, offset);
      buffer[offset++] = CharCodes.Newline;
    }

    if (trailerDict) {
      offset += trailerDict.copyBytesInto(buffer, offset);
      buffer[offset++] = CharCodes.Newline;
      buffer[offset++] = CharCodes.Newline;
    }

    offset += trailer.copyBytesInto(buffer, offset);

    return buffer;
  }

  protected computeIndirectObjectSize([ref, object]: [
    PDFRef,
    PDFObject,
  ]): number {
    const refSize = ref.sizeInBytes() + 3; // 'R' -> 'obj\n'
    const objectSize = object.sizeInBytes() + 9; // '\nendobj\n\n'
    return refSize + objectSize;
  }

  protected createTrailerDict(prevStartXRef?: number): PDFDict {
    // /Size is one greater than the highest object number in the file. Objects
    // dropped as stale leave the context's largest object number higher than
    // anything actually written, so count what was written instead.
    const highestObjectNumber =
      this._largestSavedObjectNum || this.context.largestObjectNumber;
    return this.context.obj({
      Size: highestObjectNumber + 1,
      Root: this.context.trailerInfo.Root,
      Encrypt: this.context.trailerInfo.Encrypt,
      Info: this.context.trailerInfo.Info,
      ID: this.context.trailerInfo.ID,
      Prev: prevStartXRef ? PDFNumber.of(prevStartXRef) : undefined,
    });
  }

  protected async computeBufferSize(
    incremental: boolean,
  ): Promise<SerializationInfo> {
    this._largestSavedObjectNum = 0;
    const header = this.context.header;

    let size = this.snapshot.pdfSize;
    if (!incremental) {
      size += header.sizeInBytes() + 1;
    }
    size += 1;

    const xref = PDFCrossRefSection.create();

    const security = this.context.security;

    const indirectObjects = this.context.enumerateIndirectObjects();

    for (let idx = 0, len = indirectObjects.length; idx < len; idx++) {
      const indirectObject = indirectObjects[idx];
      const [ref, object] = indirectObject;
      if (!this.shouldSave(incremental, ref, object)) continue;
      // Swap in the encrypted object so its size and bytes stay consistent.
      if (security) indirectObject[1] = this.encrypt(ref, object, security);
      xref.addEntry(ref, size);
      size += this.computeIndirectObjectSize(indirectObject);
      if (this.shouldWaitForTick(1)) await waitForTick();
    }
    // deleted objects
    for (let idx = 0; idx < this.snapshot.deletedCount; idx++) {
      const dref = this.snapshot.deletedRef(idx);
      if (!dref) break;
      const nextdref = this.snapshot.deletedRef(idx + 1);
      // add 1 to generation number for deleted ref
      xref.addDeletedEntry(
        PDFRef.of(dref.objectNumber, dref.generationNumber + 1),
        nextdref ? nextdref.objectNumber : 0,
      );
    }

    const xrefOffset = size;
    size += xref.sizeInBytes() + 1; // '\n'

    const trailerDict = PDFTrailerDict.of(
      this.createTrailerDict(this.snapshot.prevStartXRef),
    );
    size += trailerDict.sizeInBytes() + 2; // '\n\n'

    const trailer = PDFTrailer.forLastCrossRefSectionOffset(xrefOffset);
    size += trailer.sizeInBytes();
    size -= this.snapshot.pdfSize;

    return { size, header, indirectObjects, xref, trailerDict, trailer };
  }

  /**
   * Returns the encrypted form of `object`, which for streams, dictionaries and
   * arrays is `object` itself, encrypted in place.
   *
   * Encrypting in place means an already encrypted document must not be saved a
   * second time: the second save would encrypt the same bytes again.
   */
  protected encrypt(
    ref: PDFRef,
    object: PDFObject,
    security: PDFSecurity,
  ): PDFObject {
    // The Encrypt dictionary itself is never encrypted.
    if (ref === this.context.trailerInfo.Encrypt) return object;

    // A cross-reference stream is written in the clear, like a plain trailer,
    // so neither its contents nor the strings in its dictionary are encrypted.
    if (
      object instanceof PDFStream &&
      object.dict.lookup(PDFName.of('Type')) === PDFName.of('XRef')
    ) {
      return object;
    }

    const encryptFn = security.getEncryptFn(
      ref.objectNumber,
      ref.generationNumber,
    );

    if (object instanceof PDFStream) {
      object.updateContents(encryptFn(object.getContents()));
      this.encryptStringsInObject(object.dict, encryptFn);
      return object;
    }

    // Strings are immutable, so an indirect string is replaced rather than
    // updated. The caller must use the returned object.
    if (object instanceof PDFString || object instanceof PDFHexString) {
      return PDFHexString.fromBytes(encryptFn(object.asBytes()));
    }

    this.encryptStringsInObject(object, encryptFn);
    return object;
  }

  private encryptStringsInObject(
    object: PDFObject,
    encryptFn: EncryptFn,
  ): void {
    if (object instanceof PDFDict) {
      // The signed contents of a signature dictionary are exempt from
      // encryption.
      const isSignature =
        object.lookup(PDFName.of('Type')) === PDFName.of('Sig');

      for (const [key, value] of object.entries()) {
        if (isSignature && key === PDFName.of('Contents')) continue;

        if (value instanceof PDFString || value instanceof PDFHexString) {
          object.set(key, PDFHexString.fromBytes(encryptFn(value.asBytes())));
        } else if (value instanceof PDFDict || value instanceof PDFArray) {
          this.encryptStringsInObject(value, encryptFn);
        }
      }
      return;
    }

    if (object instanceof PDFArray) {
      for (let idx = 0, len = object.size(); idx < len; idx++) {
        const value = object.get(idx);
        if (value instanceof PDFString || value instanceof PDFHexString) {
          object.set(idx, PDFHexString.fromBytes(encryptFn(value.asBytes())));
        } else if (value instanceof PDFDict || value instanceof PDFArray) {
          this.encryptStringsInObject(value, encryptFn);
        }
      }
    }
  }

  protected shouldWaitForTick = (n: number) => {
    this.parsedObjects += n;
    return this.parsedObjects % this.objectsPerTick === 0;
  };
}

export default PDFWriter;
