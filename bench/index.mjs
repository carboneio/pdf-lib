import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtures, scenarios } from './scenarios.mjs';

const require = createRequire(import.meta.url);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);
const README = fileURLToPath(new URL('../README.md', import.meta.url));
const RUNNER = fileURLToPath(new URL('./run.mjs', import.meta.url));
const START_MARKER = '<!-- BENCHMARK:START -->';
const END_MARKER = '<!-- BENCHMARK:END -->';

const cantooVersion = JSON.parse(
  readFileSync(new URL('./package-lock.json', import.meta.url), 'utf8'),
).packages['node_modules/@cantoo/pdf-lib'].version;
const libraries = {
  local: '@carboneio/pdf-lib',
  cantoo: `@cantoo/pdf-lib ${cantooVersion}`,
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const writeFixtures = async (dir) => {
  const { encrypted, reports } = await createFixtures(
    require('../cjs/index.js'),
  );
  writeFileSync(join(dir, 'encrypted.pdf'), encrypted);
  mkdirSync(join(dir, 'reports'));
  reports.forEach((bytes, index) => {
    const name = `report-${String(index + 1).padStart(3, '0')}.pdf`;
    writeFileSync(join(dir, 'reports', name), bytes);
  });
};

const runLibrary = (lib, fixturesDir) => {
  const child = spawnSync(
    process.execPath,
    ['--expose-gc', RUNNER, '--lib', lib, '--fixtures', fixturesDir],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (child.status !== 0) {
    throw new Error(`Benchmark of ${lib} failed:\n${child.stderr}`);
  }
  return JSON.parse(child.stdout);
};

const collect = async () => {
  const workDir = mkdtempSync(join(os.tmpdir(), 'pdf-lib-bench-'));
  try {
    await writeFixtures(workDir);

    const rounds = { local: [], cantoo: [] };
    for (let round = 0; round < ROUNDS; round++) {
      const order = round % 2 === 0 ? ['local', 'cantoo'] : ['cantoo', 'local'];
      for (const lib of order) {
        console.error(`round ${round + 1}/${ROUNDS}: ${libraries[lib]}`);
        rounds[lib].push(runLibrary(lib, workDir));
      }
    }
    return rounds;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
};

const summarize = (rounds) =>
  scenarios.map(({ id, label }) => {
    const pick = (lib) => ({
      median: median(rounds[lib].map((result) => result[id].median)),
      size: rounds[lib][0][id].size,
    });
    return { label, local: pick('local'), cantoo: pick('cantoo') };
  });

const formatTime = (ms) => `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;

const formatSize = (size) =>
  size === null ? '-' : `${Math.round(size / 1024).toLocaleString('en-US')} KB`;

const formatDifference = (local, cantoo) => {
  const ratio = cantoo / local;
  if (Math.abs(ratio - 1) < 0.05) return 'about the same';
  return ratio >= 1
    ? `${ratio.toFixed(2)}x faster`
    : `${(1 / ratio).toFixed(2)}x slower`;
};

const describeEnvironment = () => {
  let commit = 'unknown commit';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    // Not a git checkout.
  }
  const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
  const date = new Date().toISOString().slice(0, 10);
  return (
    `Node ${process.version}, ${os.type()} ${os.release()} ${os.arch()}, ` +
    `${cpu}, commit \`${commit}\`, ${date}`
  );
};

const renderTable = (rows) => {
  const lines = [
    `| Scenario | ${libraries.local} | ${libraries.cantoo} | Difference | Output size (Carbone / Cantoo) |`,
    '| --- | ---: | ---: | ---: | ---: |',
  ];
  for (const { label, local, cantoo } of rows) {
    lines.push(
      `| ${label} | ${formatTime(local.median)} | ${formatTime(cantoo.median)} | ` +
        `${formatDifference(local.median, cantoo.median)} | ` +
        `${formatSize(local.size)} / ${formatSize(cantoo.size)} |`,
    );
  }
  return lines.join('\n');
};

const updateReadme = (table) => {
  const readme = readFileSync(README, 'utf8');
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (start === -1 || end < start) {
    throw new Error(
      `README.md must contain ${START_MARKER} followed by ${END_MARKER}.`,
    );
  }
  const section = [
    START_MARKER,
    '',
    `Median duration of one operation, lower is better. Measured on ${describeEnvironment()}.`,
    '',
    table,
    '',
    END_MARKER,
  ].join('\n');
  writeFileSync(
    README,
    readme.slice(0, start) + section + readme.slice(end + END_MARKER.length),
  );
};

const table = renderTable(summarize(await collect()));
console.log(`\n${table}\n`);
updateReadme(table);
console.log('README.md updated.');
