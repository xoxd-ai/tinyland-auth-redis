import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from '@upstash/redis';
import * as pkg from '../index.js';
import { RedisStorageAdapter } from '../adapter.js';
import { TestingEntryRefusedError, createTestRedisStorageAdapter } from '../testing/index.js';
import type { AdminInvitation, Session } from '@tummycrypt/tinyland-auth/types';

// RP2 harness seam. Since the RS5/RS6 rework there is no public clock option:
// a test clock attaches only through the gated src/testing build. These tests
// pin the default (system clock), that a clock smuggled through the public
// config is ignored, and that a test clock is the only thing consulted.

const T0 = Date.UTC(2030, 0, 1, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

function fakeRedis(store: Map<string, unknown>) {
  const pipeline = {
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return pipeline;
    }),
    get: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    sadd: vi.fn().mockReturnThis(),
    srem: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    zrem: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  const redis = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    pipeline: vi.fn(() => pipeline),
  };
  return { redis: redis as unknown as Redis, pipeline };
}

const sessionExpiringAt = (epochMs: number): Session =>
  ({
    id: 'sess-1',
    userId: 'user-1',
    expires: new Date(epochMs).toISOString(),
    expiresAt: new Date(epochMs).toISOString(),
    createdAt: new Date(T0).toISOString(),
    clientIp: '127.0.0.1',
    userAgent: 'clock-seam-test',
  }) as Session;

const invitationExpiringAt = (epochMs: number): AdminInvitation =>
  ({
    id: 'inv-1',
    token: 'tok-clock',
    email: 'invitee@ax-harness.test',
    role: 'editor',
    createdBy: 'user-1',
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(epochMs).toISOString(),
    isActive: true,
  }) as AdminInvitation;

describe('RedisStorageAdapter clock seam', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('exposes no clock on the public entry point', () => {
    expect(Object.keys(pkg).filter((name) => /clock|seam|testing/i.test(name))).toEqual([]);
  });

  it('ignores a clock passed through the public config', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 48 * HOUR);
    const store = new Map<string, unknown>([['auth:session:sess-1', sessionExpiringAt(T0 + HOUR)]]);
    const adapter = new RedisStorageAdapter({
      redis: fakeRedis(store).redis,
      ...({ clock: { now: () => T0 } } as object),
    });
    expect(await adapter.getSession('sess-1')).toBeNull();
  });

  it('refuses to build a test adapter once NODE_ENV leaves "test"', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() =>
      createTestRedisStorageAdapter({ redis: fakeRedis(new Map()).redis }, { clock: { now: () => T0 } }),
    ).toThrow(TestingEntryRefusedError);
  });

  it('defaults to the system clock for session expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = new Map<string, unknown>([['auth:session:sess-1', sessionExpiringAt(T0 + HOUR)]]);
    const adapter = new RedisStorageAdapter({ redis: fakeRedis(store).redis });

    expect(await adapter.getSession('sess-1')).not.toBeNull();

    vi.setSystemTime(T0 + 2 * HOUR);
    expect(await adapter.getSession('sess-1')).toBeNull();
  });

  it('uses only the test clock for session expiry', async () => {
    vi.useFakeTimers();
    // System time is far past expiry; the injected clock is not.
    vi.setSystemTime(T0 + 48 * HOUR);
    let now = T0;
    const store = new Map<string, unknown>([['auth:session:sess-1', sessionExpiringAt(T0 + HOUR)]]);
    const adapter = createTestRedisStorageAdapter(
      { redis: fakeRedis(store).redis },
      { clock: { now: () => now } },
    );

    expect(await adapter.getSession('sess-1')).not.toBeNull();

    now = T0 + HOUR + 1;
    expect(await adapter.getSession('sess-1')).toBeNull();
  });

  it('stamps new sessions from the test clock', async () => {
    const adapter = createTestRedisStorageAdapter(
      { redis: fakeRedis(new Map()).redis, sessionMaxAge: HOUR },
      { clock: { now: () => T0 } },
    );

    const session = await adapter.createSession('user-1', { handle: 'ax-member' });

    expect(session.createdAt).toBe(new Date(T0).toISOString());
    expect(session.expires).toBe(new Date(T0 + HOUR).toISOString());
  });

  it('uses the test clock for invitation expiry and the system clock otherwise', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const store = new Map<string, unknown>([
      ['auth:invite:tok-clock', invitationExpiringAt(T0 + HOUR)],
    ]);

    const byDefault = new RedisStorageAdapter({ redis: fakeRedis(store).redis });
    expect(await byDefault.getInvitation('tok-clock')).not.toBeNull();

    const injected = createTestRedisStorageAdapter(
      { redis: fakeRedis(store).redis },
      { clock: { now: () => T0 + 2 * HOUR } },
    );
    expect(await injected.getInvitation('tok-clock')).toBeNull();
  });
});
