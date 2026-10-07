import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// RS5 pattern (TIN-5766, RP2), applied to the adapter test clock:
//   - the production build and the package manifest carry no testing path,
//     testing symbol or sentinel, and no entry reaches the clock writer;
//   - the testing build refuses to load unless NODE_ENV is exactly "test".

const ROOT = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const SENTINEL = 'tinyland-auth-redis-testing-entry-2c5ac5f8af3de8981843b487';
const TESTING_SYMBOLS = [
  SENTINEL,
  'TESTING_ENTRY_SENTINEL',
  'TestingEntryRefusedError',
  'assertTestEnvironment',
  'createManualClock',
  'createTestRedisStorageAdapter',
];
const require = createRequire(import.meta.url);
const TSC = require.resolve('typescript/bin/tsc');

let work = '';
let productionBuild = '';
let testingBuild = '';

function tsc(project: string, outDir: string): void {
  const result = spawnSync(process.execPath, [TSC, '-p', project, '--outDir', outDir], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`tsc -p ${project} failed:\n${result.stdout}${result.stderr}`);
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/** Returns one message per testing path or symbol found under `dir`. */
function leaks(dir: string): string[] {
  const found: string[] = [];
  for (const file of walk(dir)) {
    if (/(^|\/)(testing|dist-testing)(\/|$)/.test(file)) found.push(`path ${file}`);
    const text = readFileSync(join(dir, file), 'utf8');
    for (const symbol of TESTING_SYMBOLS) {
      if (text.includes(symbol)) found.push(`${file}: ${symbol}`);
    }
    if (/\binstallClock\b/.test(text) && file !== 'seams.js' && file !== 'seams.d.ts' && !file.endsWith('.map')) {
      found.push(`${file}: installClock`);
    }
  }
  return found;
}

function importTestingEntry(nodeEnv: string | undefined) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'NODE_ENV' && value !== undefined) env[key] = value;
  }
  if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
  const entry = join(testingBuild, 'testing/index.js');
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const t = await import(${JSON.stringify(entry)}); process.stdout.write(t.TESTING_ENTRY_SENTINEL);`],
    { cwd: work, encoding: 'utf8', env },
  );
}

beforeAll(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'tinyland-auth-redis-artifact-')));
  symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'dir');
  productionBuild = join(work, 'production');
  tsc('tsconfig.json', productionBuild);
  testingBuild = join(work, 'testing-build');
  tsc('tsconfig.testing.json', testingBuild);
}, 120_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('production artifact excludes the test clock writer (RS5 pattern)', () => {
  it('builds production output with no testing path, symbol or sentinel', () => {
    expect(walk(productionBuild)).toContain('seams.js');
    expect(leaks(productionBuild)).toEqual([]);
  });

  it('exports no testing entry and publishes only dist', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      files: string[];
    };
    expect(Object.keys(manifest.exports)).toEqual(['.']);
    expect(JSON.stringify(manifest.exports)).not.toMatch(/testing|seams/);
    expect(manifest.files).toEqual(['dist', '!dist/**/*.js.map']);
    const entry = readFileSync(join(productionBuild, 'index.js'), 'utf8');
    expect(entry).not.toMatch(/seams|testing/);
  });

  it('detects a leak when the testing build is copied into the package (check self-test)', () => {
    expect(leaks(testingBuild).some((leak) => leak.startsWith('path testing/'))).toBe(true);
    expect(leaks(testingBuild).some((leak) => leak.includes(SENTINEL))).toBe(true);
  });

  it('keeps src/testing out of the production build configuration', () => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as { exclude: string[] };
    expect(tsconfig.exclude).toContain('src/testing/**');
    const buildBazel = readFileSync(join(ROOT, 'BUILD.bazel'), 'utf8');
    const target = buildBazel.match(/ts_project\(\s*name = "tinyland-auth-redis",[\s\S]*?\n\)/)?.[0] ?? '';
    expect(target).toContain('"src/testing/**"');
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).toContain('dist-testing/');
  });
});

describe('testing entry load gate', () => {
  for (const [label, nodeEnv] of [
    ['unset', undefined],
    ['empty', ''],
    ['production', 'production'],
    ['development', 'development'],
    ['uppercase TEST', 'TEST'],
  ] as const) {
    it(`refuses to load when NODE_ENV is ${label}`, () => {
      const result = importTestingEntry(nodeEnv);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('TestingEntryRefusedError');
      expect(result.stderr).toContain(nodeEnv === undefined ? 'NODE_ENV is unset' : `NODE_ENV is ${JSON.stringify(nodeEnv)}`);
    });
  }

  it('loads under NODE_ENV=test', () => {
    const result = importTestingEntry('test');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(SENTINEL);
  });
});
