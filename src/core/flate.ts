import { zlibSync } from 'fflate';

/**
 * zlib-wrapped deflate, as expected by the `FlateDecode` filter.
 *
 * On Node, inputs of `NATIVE_MIN_LENGTH` bytes or more go through the native
 * zlib binding, which is 1.2x to 3x faster than fflate on page content, fonts
 * and image samples. Below that size the binding's fixed setup cost (around
 * 70 microseconds per call) outweighs the gain, so small streams stay on fflate.
 *
 * `zlib` is deliberately never imported statically: pdf-lib also runs in
 * browsers, Deno and React Native, and the rollup bundles are built with no
 * `external` configuration. See `nodeCrypto.ts` for the same pattern.
 */

const NATIVE_MIN_LENGTH = 16 * 1024;

interface NodeZlibModule {
  deflateSync(data: Uint8Array): Uint8Array;
}

interface HostWithBuiltinModules {
  process?: { getBuiltinModule?: (id: string) => unknown };
}

const loadNodeZlib = (): NodeZlibModule | undefined => {
  try {
    const host = globalThis as HostWithBuiltinModules;
    const module = host.process?.getBuiltinModule?.('zlib') as
      | NodeZlibModule
      | undefined;
    return typeof module?.deflateSync === 'function' ? module : undefined;
  } catch {
    return undefined;
  }
};

// `null` means "not looked up yet"; `undefined` means "no Node zlib here".
let nodeZlib: NodeZlibModule | undefined | null = null;

export const deflate = (data: Uint8Array): Uint8Array => {
  if (data.length >= NATIVE_MIN_LENGTH) {
    if (nodeZlib === null) nodeZlib = loadNodeZlib();
    if (nodeZlib) {
      const output = nodeZlib.deflateSync(data);
      // A plain view rather than the Buffer itself, whose `slice` shares memory.
      return new Uint8Array(
        output.buffer,
        output.byteOffset,
        output.byteLength,
      );
    }
  }
  return zlibSync(data);
};
