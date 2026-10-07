# @tummycrypt/tinyland-auth-redis

Redis storage adapter for [@tummycrypt/tinyland-auth](https://www.npmjs.com/package/@tummycrypt/tinyland-auth), backed by [Upstash Redis](https://upstash.com/) (`@upstash/redis`).

Implements the full `IStorageAdapter` interface: users, sessions, TOTP secrets, backup codes, invitations, and audit events.

## Installation

Current Bazel-first release authority is the GitHub release/tag, GitHub
Packages artifact, and Tinyland Bazel registry module. The npmjs
`@tummycrypt/tinyland-auth-redis` package remains a legacy compatibility surface
and may lag the current release.

```bash
npm install @tummycrypt/tinyland-auth-redis
# or
pnpm add @tummycrypt/tinyland-auth-redis
```

Peer dependency:

```bash
npm install @tummycrypt/tinyland-auth
```

`@tummycrypt/tinyland-auth-redis` accepts `@tummycrypt/tinyland-auth`
`^0.2.0 || ^0.3.0 || ^1.0.0`. The package test/build lane uses the latest 0.3
line so the Redis adapter stays compatible with the current auth contract. The
adapter imports only the `./storage` types, which 1.0.0 (RS6, TIN-5766) leaves
unchanged; it typechecks and passes its tests against the 1.0.0 build.

## Quick Start

```typescript
import { createRedisStorageAdapter } from '@tummycrypt/tinyland-auth-redis';

const storage = createRedisStorageAdapter({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  prefix: 'auth',           // optional, default: 'auth'
  sessionMaxAge: 7 * 24 * 60 * 60 * 1000, // optional, default: 7 days
});

await storage.init(); // verifies connectivity with PING
```

### Using an Existing Redis Instance

```typescript
import { Redis } from '@upstash/redis';
import { createRedisStorageAdapter } from '@tummycrypt/tinyland-auth-redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const storage = createRedisStorageAdapter({ redis });
```

## Graceful Fallback

When Redis is unavailable (e.g., local development without Upstash credentials), fall back to an in-memory Map:

```typescript
import { createRedisStorageAdapter } from '@tummycrypt/tinyland-auth-redis';

const createStorage = () => {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (url && token) {
    return createRedisStorageAdapter({ url, token });
  }

  console.warn('Redis not configured, using in-memory fallback');
  // Use your own in-memory adapter or the one from tinyland-auth
  return createInMemoryAdapter();
};
```

## Key Namespacing

All keys are namespaced under a configurable prefix (default: `auth`). This allows multiple applications to share a single Redis instance without collisions.

| Pattern | Example | Purpose |
|---------|---------|---------|
| `{prefix}:user:{id}` | `auth:user:abc-123` | User entity |
| `{prefix}:user:handle:{handle}` | `auth:user:handle:jen` | Handle lookup index |
| `{prefix}:user:email:{email}` | `auth:user:email:jen@example.com` | Email lookup index |
| `{prefix}:users:all` | `auth:users:all` | Set of all user IDs |
| `{prefix}:session:{id}` | `auth:session:sess-1` | Session entity |
| `{prefix}:sessions:user:{userId}` | `auth:sessions:user:abc-123` | Sorted set of session IDs by expiry |
| `{prefix}:totp:{handle}` | `auth:totp:jen` | Encrypted TOTP secret |
| `{prefix}:backup:{userId}` | `auth:backup:abc-123` | Backup codes |
| `{prefix}:invite:{token}` | `auth:invite:tok-abc` | Invitation entity |
| `{prefix}:invite:id:{id}` | `auth:invite:id:inv-1` | Invitation ID to token index |
| `{prefix}:invites:all` | `auth:invites:all` | Set of all invitation tokens |
| `{prefix}:invites:pending` | `auth:invites:pending` | Set of pending invitation tokens |
| `{prefix}:audit:{id}` | `auth:audit:evt_123_abc` | Audit event entity |
| `{prefix}:audit:log` | `auth:audit:log` | Sorted set of audit event IDs by timestamp |

## API Reference

### `createRedisStorageAdapter(config: RedisStorageConfig): RedisStorageAdapter`

Factory function. Accepts:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `redis` | `Redis` | - | Existing Upstash Redis instance |
| `url` | `string` | - | Upstash REST URL (used if `redis` not provided) |
| `token` | `string` | - | Upstash REST token (used if `redis` not provided) |
| `prefix` | `string` | `'auth'` | Key namespace prefix |
| `sessionMaxAge` | `number` | `604800000` | Session TTL in milliseconds (7 days) |

### `RedisStorageAdapter` (implements `IStorageAdapter`)

**Lifecycle:**
- `init()` - Verify Redis connectivity (PING)
- `close()` - No-op (Upstash uses HTTP, no persistent connection)

**Users:** `getUser`, `getUserByHandle`, `getUserByEmail`, `getAllUsers`, `createUser`, `updateUser`, `deleteUser`, `hasUsers`

**Sessions:** `getSession`, `getSessionsByUser`, `getAllSessions`, `createSession`, `updateSession`, `deleteSession`, `deleteUserSessions`, `cleanupExpiredSessions`

**TOTP:** `getTOTPSecret`, `saveTOTPSecret`, `deleteTOTPSecret`

**Backup Codes:** `getBackupCodes`, `saveBackupCodes`, `deleteBackupCodes`

**Invitations:** `getInvitation`, `getInvitationById`, `getAllInvitations`, `getPendingInvitations`, `createInvitation`, `updateInvitation`, `deleteInvitation`, `cleanupExpiredInvitations`

**Audit:** `logAuditEvent`, `getAuditEvents`, `getRecentAuditEvents`

### Serialization Utilities

Exported for advanced use cases:

```typescript
import { serialize, deserialize, toHashFields, fromHashFields } from '@tummycrypt/tinyland-auth-redis';
```

- `serialize<T>(value: T): string` - Safe JSON.stringify wrapper
- `deserialize<T>(value: string | null): T | null` - Safe JSON.parse with null handling
- `toHashFields(obj: Record<string, unknown>): Record<string, string>` - Convert to Redis HSET-compatible flat map
- `fromHashFields<T>(hash: Record<string, string> | null): T | null` - Parse Redis HGETALL result back to typed object

### Key Generators

```typescript
import { createKeys } from '@tummycrypt/tinyland-auth-redis';

const keys = createKeys('myapp');
keys.user('abc-123');      // 'myapp:user:abc-123'
keys.session('sess-1');    // 'myapp:session:sess-1'
keys.auditLog();           // 'myapp:audit:log'
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KV_REST_API_URL` | Yes | Upstash Redis REST URL |
| `KV_REST_API_TOKEN` | Yes | Upstash Redis REST token |

These are the standard environment variable names used by Vercel KV (Upstash integration).

## License

MIT
