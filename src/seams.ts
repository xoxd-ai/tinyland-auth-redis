/**
 * Internal time seam (RS5/RS6 pattern from @tummycrypt/tinyland-auth 1.0.0).
 *
 * Not exported from the package entry point, and `RedisStorageConfig` has no
 * option that changes it. An adapter with nothing installed reads the system
 * clock. The only writer is the `src/testing` build, which is excluded from
 * the production build and the published package and refuses to load unless
 * `NODE_ENV` is exactly "test".
 */

/** Time source: milliseconds since the Unix epoch. */
export interface Clock {
  now(): number;
}

const clocks = new WeakMap<object, Clock>();

/** Milliseconds for `adapter`: its installed test clock, else the system. */
export function nowMsFor(adapter: object): number {
  const clock = clocks.get(adapter);
  return clock ? clock.now() : Date.now();
}

/**
 * Attach a clock to one adapter instance. Called only from src/testing.
 *
 * This module ships in dist (unexported), so a file-URL import could still
 * reach it. It refuses unless `process.env.NODE_ENV` is exactly "test", read
 * live and never from a caller.
 */
export function installClock(adapter: object, clock: Clock): void {
  const nodeEnv = typeof process === 'object' && process?.env ? process.env.NODE_ENV : undefined;
  if (nodeEnv !== 'test') {
    throw new Error(
      `A test clock can only be installed when NODE_ENV is exactly "test" (it is ${
        nodeEnv === undefined ? 'unset' : JSON.stringify(nodeEnv)
      })`,
    );
  }
  if (clocks.has(adapter)) {
    throw new Error('A test clock is already installed on this adapter');
  }
  clocks.set(adapter, clock);
}
