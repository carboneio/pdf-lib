interface HostWithSetImmediate {
  setImmediate?: (callback: () => void) => unknown;
}

/**
 * Returns a Promise that resolves after at least one tick of the
 * Macro Task Queue occurs.
 */
export const waitForTick = (): Promise<void> =>
  new Promise((resolve) => {
    // Node clamps `setTimeout(fn, 0)` to a millisecond, which parsing and
    // writing pay hundreds of times over for a large document; `setImmediate`
    // reaches the same macro task queue without that floor. Looked up on the
    // host at each call rather than imported, because pdf-lib also runs where
    // it does not exist, and so that a replaced timer is still honoured.
    const immediate = (globalThis as HostWithSetImmediate).setImmediate;
    if (immediate) immediate(() => resolve());
    else setTimeout(() => resolve(), 0);
  });
