import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { scenarios } from './scenarios.mjs';

const require = createRequire(import.meta.url);

const libraries = {
  local: () => require('../cjs/index.js'),
  cantoo: () => require('@cantoo/pdf-lib'),
};

const MIN_RUNS = 5;
const MAX_RUNS = 50;
const BUDGET_MS = 1000;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const collectGarbage = () => globalThis.gc?.();

const measure = async (operation) => {
  let bytes = await operation();
  const samples = [];
  let elapsed = 0;
  while (
    samples.length < MAX_RUNS &&
    (samples.length < MIN_RUNS || elapsed < BUDGET_MS)
  ) {
    collectGarbage();
    const start = process.hrtime.bigint();
    bytes = await operation();
    const duration = Number(process.hrtime.bigint() - start) / 1e6;
    samples.push(duration);
    elapsed += duration;
  }
  return {
    median: median(samples),
    runs: samples.length,
    size: bytes ? bytes.length : null,
  };
};

const { values } = parseArgs({
  options: { lib: { type: 'string' }, encrypted: { type: 'string' } },
});

const PDFLib = libraries[values.lib]();
const context = { encrypted: readFileSync(values.encrypted) };

const results = {};
for (const scenario of scenarios) {
  results[scenario.id] = await measure(() => scenario.run(PDFLib, context));
}

process.stdout.write(JSON.stringify(results));
