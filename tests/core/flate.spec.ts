import zlib from 'zlib';
import { unzlibSync, zlibSync } from 'fflate';

import { deflate } from '../../src/core/flate';

const sample = (length: number) =>
  new Uint8Array(length).map((_, index) => (index * 31 + (index >> 7)) & 0xff);

/**
 * Loads a fresh copy of the module with `process.getBuiltinModule` hidden, so
 * that it cannot reach Node's zlib and has to use fflate.
 */
const deflateWithoutNode = (data: Uint8Array) => {
  const original = Object.getOwnPropertyDescriptor(
    process,
    'getBuiltinModule',
  ) as PropertyDescriptor | undefined;
  delete (process as { getBuiltinModule?: unknown }).getBuiltinModule;

  try {
    let output!: Uint8Array;
    jest.isolateModules(() => {
      output = require('../../src/core/flate').deflate(data);
    });
    return output;
  } finally {
    if (original) {
      Object.defineProperty(process, 'getBuiltinModule', original);
    }
  }
};

describe('deflate', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([0, 1, 300, 16 * 1024 - 1, 16 * 1024, 200_000])(
    'produces a zlib stream that inflates back to the input (%i bytes)',
    (length) => {
      const data = sample(length);
      expect(unzlibSync(deflate(data))).toEqual(data);
    },
  );

  it('keeps small inputs on fflate', () => {
    const spy = jest.spyOn(zlib, 'deflateSync');
    const data = sample(16 * 1024 - 1);
    expect(deflate(data)).toEqual(zlibSync(data));
    expect(spy).not.toHaveBeenCalled();
  });

  it('uses Node zlib for large inputs', () => {
    const spy = jest.spyOn(zlib, 'deflateSync');
    deflate(sample(16 * 1024));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns a plain Uint8Array rather than a Buffer', () => {
    const output = deflate(sample(200_000));
    expect(Object.getPrototypeOf(output)).toBe(Uint8Array.prototype);
  });

  it('falls back to fflate when Node zlib is unavailable', () => {
    const data = sample(200_000);
    expect(deflateWithoutNode(data)).toEqual(zlibSync(data));
  });
});
