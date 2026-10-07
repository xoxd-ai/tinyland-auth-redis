/**
 * Test-only harness for `@tummycrypt/tinyland-auth-redis` (RS5 pattern).
 *
 * Hard gate, in layers:
 *
 * 1. Compile-time exclusion: `tsconfig.json` and Bazel
 *    `//:tinyland-auth-redis` exclude this directory, so `dist/` and the
 *    published package never contain it. It builds only through
 *    `tsconfig.testing.json` into git-ignored `dist-testing/`.
 * 2. Not exported: `package.json` has no entry for it.
 * 3. Load gate: evaluating this module throws unless `process.env.NODE_ENV`
 *    is exactly "test". No function takes a caller-supplied environment.
 *
 * `src/__tests__/production-artifact.test.ts` proves all three on built output.
 */
import { RedisStorageAdapter, type RedisStorageConfig } from '../adapter.js';
import { installClock, type Clock } from '../seams.js';

export type { Clock };

/** Unique marker that must never appear in the production build. */
export const TESTING_ENTRY_SENTINEL = 'tinyland-auth-redis-testing-entry-2c5ac5f8af3de8981843b487';

/** The only `NODE_ENV` value under which this module loads. */
export const TEST_NODE_ENV = 'test';

export class TestingEntryRefusedError extends Error {
  constructor(reason: string) {
    super(
      `@tummycrypt/tinyland-auth-redis testing entry refused to load: ${reason}. ` +
        `It loads only when NODE_ENV is exactly "${TEST_NODE_ENV}".`,
    );
    this.name = 'TestingEntryRefusedError';
  }
}

/** Throws unless the live `process.env.NODE_ENV` is exactly "test". */
export function assertTestEnvironment(): void {
  const nodeEnv =
    typeof process === 'object' && process !== null && typeof process.env === 'object'
      ? process.env.NODE_ENV
      : undefined;
  if (nodeEnv !== TEST_NODE_ENV) {
    throw new TestingEntryRefusedError(
      nodeEnv === undefined ? 'NODE_ENV is unset' : `NODE_ENV is ${JSON.stringify(nodeEnv)}`,
    );
  }
}

// Load gate: runs when this module is evaluated, before any export is usable.
assertTestEnvironment();

/** A clock a harness can move by hand. */
export interface ManualClock extends Clock {
  set(epochMs: number): void;
  advance(deltaMs: number): void;
}

export function createManualClock(startMs: number): ManualClock {
  let current = startMs;
  return {
    now: () => current,
    set: (epochMs) => {
      current = epochMs;
    },
    advance: (deltaMs) => {
      current += deltaMs;
    },
  };
}

/**
 * A `RedisStorageAdapter` whose own timestamps and session / invitation
 * expiry checks follow `seams.clock`. Production code cannot construct one.
 */
export function createTestRedisStorageAdapter(
  config: RedisStorageConfig,
  seams: { clock: Clock },
): RedisStorageAdapter {
  assertTestEnvironment();
  const adapter = new RedisStorageAdapter(config);
  installClock(adapter, seams.clock);
  return adapter;
}
