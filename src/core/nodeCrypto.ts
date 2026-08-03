import { toHexString } from '../utils/strings';

/**
 * Node-backed versions of the primitives that ISO 32000-2 Algorithm 2.B (the
 * revision 6 key derivation) spends nearly all of its time in.
 *
 * Algorithm 2.B is expensive by design: it runs at least 64 rounds, each of
 * which hashes and AES-encrypts 64 copies of the running key, so that guessing
 * a password stays costly. In JavaScript that adds up to tens of milliseconds
 * per derivation, paid every time an encrypted document is saved or opened,
 * whereas Node's OpenSSL bindings do the same work in well under a millisecond.
 *
 * `crypto` is deliberately never imported statically. pdf-lib also runs in
 * browsers, Deno and React Native, and the rollup bundles are built with no
 * `external` configuration, so a static import would break them. Loading goes
 * through `process.getBuiltinModule` instead, which Node added in 20.16 and
 * 22.3 for exactly this purpose. Anywhere else — including older Node — callers
 * fall back to the JavaScript implementations.
 */

export type NodeDigestAlgorithm = 'sha256' | 'sha384' | 'sha512';

export interface NodeCryptoPrimitives {
  hash(algorithm: NodeDigestAlgorithm, data: Uint8Array): Uint8Array;

  /**
   * AES-128-CBC with padding disabled, so the output has the same length as the
   * input. `data` must be a whole number of 16 byte blocks.
   */
  aes128CbcNoPadding(
    key: Uint8Array,
    iv: Uint8Array,
    data: Uint8Array,
  ): Uint8Array;
}

/**
 * The slice of Node's `crypto` surface used here. Declared locally rather than
 * taken from `@types/node` so that the types hold whether or not the consuming
 * project installs them, and regardless of their version.
 */
interface NodeHash {
  update(data: Uint8Array): NodeHash;
  digest(): Uint8Array;
}

interface NodeCipher {
  setAutoPadding(autoPadding: boolean): unknown;
  update(data: Uint8Array): Uint8Array;
  final(): Uint8Array;
}

interface NodeCryptoModule {
  createHash(algorithm: string): NodeHash;
  createCipheriv(
    algorithm: string,
    key: Uint8Array,
    iv: Uint8Array,
  ): NodeCipher;
}

interface HostWithBuiltinModules {
  process?: { getBuiltinModule?: (id: string) => unknown };
}

const loadNodeCryptoModule = (): NodeCryptoModule | undefined => {
  try {
    const host = globalThis as HostWithBuiltinModules;
    const module = host.process?.getBuiltinModule?.('crypto') as
      | NodeCryptoModule
      | undefined;
    return typeof module?.createHash === 'function' &&
      typeof module?.createCipheriv === 'function'
      ? module
      : undefined;
  } catch {
    return undefined;
  }
};

const buildPrimitives = (module: NodeCryptoModule): NodeCryptoPrimitives => ({
  hash: (algorithm, data) =>
    new Uint8Array(module.createHash(algorithm).update(data).digest()),

  aes128CbcNoPadding: (key, iv, data) => {
    const cipher = module.createCipheriv('aes-128-cbc', key, iv);
    cipher.setAutoPadding(false);
    const body = cipher.update(data);
    const tail = cipher.final();
    // Concatenated by hand rather than with `Buffer.concat` so that no bundler
    // sees a reason to inject a Buffer polyfill into browser builds.
    const output = new Uint8Array(body.length + tail.length);
    output.set(body, 0);
    output.set(tail, body.length);
    return output;
  },
});

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map(toHexString).join('');

/**
 * Hardened Node builds can refuse an algorithm (FIPS mode being the usual
 * culprit), and a wrong answer here would write a document nobody can decrypt.
 * So each primitive has to reproduce a known vector before it is trusted: the
 * digests of the empty input, and AES-128 over a zero block under a zero key.
 */
const passesSelfTest = (primitives: NodeCryptoPrimitives): boolean => {
  try {
    const empty = new Uint8Array(0);
    const zeros = new Uint8Array(16);
    return (
      toHex(primitives.hash('sha256', empty)) ===
        'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855' &&
      toHex(primitives.hash('sha384', empty)) ===
        '38B060A751AC96384CD9327EB1B1E36A21FDB71114BE07434C0CC7BF63F6E1DA' +
          '274EDEBFE76F65FBD51AD2F14898B95B' &&
      toHex(primitives.hash('sha512', empty)) ===
        'CF83E1357EEFB8BDF1542850D66D8007D620E4050B5715DC83F4A921D36CE9CE' +
          '47D0D13C5D85F2B0FF8318D2877EEC2F63B931BD47417A81A538327AF927DA3E' &&
      toHex(primitives.aes128CbcNoPadding(zeros, zeros, zeros)) ===
        '66E94BD4EF8A2C3B884CFA59CA342B2E'
    );
  } catch {
    return false;
  }
};

// `null` means "not looked up yet"; `undefined` means "no Node crypto here".
let resolved: NodeCryptoPrimitives | undefined | null = null;

/**
 * The Node primitives, or `undefined` when they are unavailable or untrustworthy
 * and the caller should use its own JavaScript implementation. Resolved on first
 * use so that merely importing pdf-lib does not reach into `crypto`.
 */
export const getNodeCrypto = (): NodeCryptoPrimitives | undefined => {
  if (resolved === null) {
    const module = loadNodeCryptoModule();
    const primitives = module && buildPrimitives(module);
    resolved =
      primitives && passesSelfTest(primitives) ? primitives : undefined;
  }
  return resolved;
};
