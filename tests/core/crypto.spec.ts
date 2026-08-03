import { PDF20 } from '../../src/core/crypto';
import { getNodeCrypto } from '../../src/core/nodeCrypto';

const bytes = (...values: number[]) => new Uint8Array(values);

const range = (length: number, seed: number) =>
  new Uint8Array(length).map((_, index) => (index * 31 + seed) & 0xff);

/**
 * Derives a key from a freshly loaded copy of the crypto module, optionally with
 * `process.getBuiltinModule` hidden so that the module cannot reach Node's
 * primitives and has to use its own JavaScript implementations.
 */
const derive = (
  options: { withNodeCrypto: boolean },
  password: Uint8Array,
  input: Uint8Array,
  userBytes: Uint8Array,
) => {
  const original = Object.getOwnPropertyDescriptor(
    process,
    'getBuiltinModule',
  ) as PropertyDescriptor | undefined;

  if (!options.withNodeCrypto) {
    delete (process as { getBuiltinModule?: unknown }).getBuiltinModule;
  }

  try {
    let key!: Uint8Array;
    jest.isolateModules(() => {
      // Required inside the isolated registry so that the module memoizing the
      // lookup of Node's crypto is rebuilt under the current conditions.
      const crypto = require('../../src/core/crypto');
      key = new crypto.PDF20().calculatePDF20Hash(password, input, userBytes);
    });
    return key;
  } finally {
    if (original) {
      Object.defineProperty(process, 'getBuiltinModule', original);
    }
  }
};

describe('Algorithm 2.B key derivation (ISO 32000-2, revision 6)', () => {
  const cases: [string, Uint8Array, Uint8Array, Uint8Array][] = [
    ['empty password', bytes(), range(48, 1), bytes()],
    ['short password', bytes(0x61, 0x62, 0x63), range(48, 7), bytes()],
    [
      'non-ASCII password',
      bytes(0xc3, 0xa9, 0xc3, 0xa8),
      range(48, 13),
      bytes(),
    ],
    ['with owner user bytes', bytes(0x70, 0x77), range(48, 19), range(48, 23)],
    ['long password', range(127, 29), range(48, 31), bytes()],
  ];

  // Guards the Node fast path: it must be a drop-in replacement for the
  // JavaScript implementation, since a mismatch would produce documents that
  // only decrypt on the platform that wrote them.
  it.each(cases)(
    'matches the JavaScript implementation (%s)',
    (_name, password, input, userBytes) => {
      const withNode = derive(
        { withNodeCrypto: true },
        password,
        input,
        userBytes,
      );
      const withoutNode = derive(
        { withNodeCrypto: false },
        password,
        input,
        userBytes,
      );

      expect(withNode).toHaveLength(32);
      expect(Array.from(withNode)).toEqual(Array.from(withoutNode));
    },
  );

  it("uses Node's primitives when the host provides them", () => {
    expect(getNodeCrypto()).toBeDefined();
  });

  it('falls back to JavaScript when the host has no built-in modules', () => {
    const key = derive(
      { withNodeCrypto: false },
      bytes(0x61),
      range(48, 3),
      bytes(),
    );
    expect(key).toHaveLength(32);
  });

  it('is deterministic', () => {
    const password = bytes(0x73, 0x65, 0x63, 0x72, 0x65, 0x74);
    const input = range(48, 41);
    const hash = new PDF20().calculatePDF20Hash(password, input, bytes());
    expect(
      Array.from(new PDF20().calculatePDF20Hash(password, input, bytes())),
    ).toEqual(Array.from(hash));
  });
});
