/**
 * Redis Storage Adapter for @tummycrypt/tinyland-auth
 *
 * Backed by Upstash Redis (@upstash/redis) with HTTP-based REST API.
 * Uses pipelines for multi-key atomic operations and sorted sets
 * for efficient time-based queries (sessions, audit events).
 *
 * NOTE: @upstash/redis automatically serializes values to JSON on set()
 * and deserializes on get(). We leverage this rather than fighting it.
 */

import { Redis } from '@upstash/redis';
import { randomUUID } from 'crypto';
import { createKeys, type KeyGenerators } from './keys.js';
import { nowMsFor } from './seams.js';
import type { IStorageAdapter, AuditEventFilters } from '@tummycrypt/tinyland-auth/storage';
import type {
  AdminUser,
  Session,
  SessionMetadata,
  EncryptedTOTPSecret,
  BackupCodeSet,
  AdminInvitation,
  AuditEvent,
} from '@tummycrypt/tinyland-auth/types';

export interface RedisStorageConfig {
  /** Existing Redis instance */
  redis?: Redis;
  /** Upstash REST URL (used if redis not provided) */
  url?: string;
  /** Upstash REST token (used if redis not provided) */
  token?: string;
  /** Key prefix (default: 'auth') */
  prefix?: string;
  /** Session TTL in milliseconds (default: 7 days) */
  sessionMaxAge?: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class RedisStorageAdapter implements IStorageAdapter {
  private readonly redis: Redis;
  private readonly keys: KeyGenerators;
  private readonly sessionMaxAge: number;

  constructor(config: RedisStorageConfig) {
    if (config.redis) {
      this.redis = config.redis;
    } else if (config.url && config.token) {
      this.redis = new Redis({ url: config.url, token: config.token });
    } else {
      throw new Error('RedisStorageAdapter requires either a Redis instance or url+token');
    }
    this.keys = createKeys(config.prefix ?? 'auth');
    this.sessionMaxAge = config.sessionMaxAge ?? SEVEN_DAYS_MS;
  }

  // System time. A test clock has no public option (RS5/RS6 pattern); it can
  // be attached only through the gated src/testing build. Audit event ids
  // keep using the system clock.
  private nowMs(): number {
    return nowMsFor(this);
  }

  private nowDate(): Date {
    return new Date(nowMsFor(this));
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async init(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    // Upstash HTTP client has no persistent connection to close
  }

  // ==========================================================================
  // User Operations
  // ==========================================================================

  async getUser(id: string): Promise<AdminUser | null> {
    const data = await this.redis.get<AdminUser>(this.keys.user(id));
    return data ?? null;
  }

  async getUserByHandle(handle: string): Promise<AdminUser | null> {
    const userId = await this.redis.get<string>(this.keys.userHandle(handle.toLowerCase()));
    if (!userId) return null;
    return this.getUser(userId);
  }

  async getUserByEmail(email: string): Promise<AdminUser | null> {
    const userId = await this.redis.get<string>(this.keys.userEmail(email.toLowerCase()));
    if (!userId) return null;
    return this.getUser(userId);
  }

  async getAllUsers(): Promise<AdminUser[]> {
    const userIds = await this.redis.smembers(this.keys.usersAll());
    if (!userIds.length) return [];

    const pipeline = this.redis.pipeline();
    for (const id of userIds) {
      pipeline.get(this.keys.user(id as string));
    }
    const results = await pipeline.exec<(AdminUser | null)[]>();

    return results.filter((u): u is AdminUser => u !== null);
  }

  async createUser(user: Omit<AdminUser, 'id'>): Promise<AdminUser> {
    const id = randomUUID();
    const newUser: AdminUser = { ...user, id } as AdminUser;

    const pipeline = this.redis.pipeline();
    pipeline.set(this.keys.user(id), newUser);
    pipeline.set(this.keys.userHandle(newUser.handle.toLowerCase()), id);
    if (newUser.email) {
      pipeline.set(this.keys.userEmail(newUser.email.toLowerCase()), id);
    }
    pipeline.sadd(this.keys.usersAll(), id);
    await pipeline.exec();

    return newUser;
  }

  async updateUser(id: string, updates: Partial<AdminUser>): Promise<AdminUser> {
    const existing = await this.getUser(id);
    if (!existing) {
      throw new Error(`User ${id} not found`);
    }

    const pipeline = this.redis.pipeline();

    // Update handle index if changed
    if (updates.handle && updates.handle !== existing.handle) {
      pipeline.del(this.keys.userHandle(existing.handle.toLowerCase()));
      pipeline.set(this.keys.userHandle(updates.handle.toLowerCase()), id);
    }

    // Update email index if changed
    if (updates.email && updates.email !== existing.email) {
      if (existing.email) {
        pipeline.del(this.keys.userEmail(existing.email.toLowerCase()));
      }
      pipeline.set(this.keys.userEmail(updates.email.toLowerCase()), id);
    }

    const updatedUser: AdminUser = {
      ...existing,
      ...updates,
      id, // Ensure ID is not changed
      updatedAt: this.nowDate().toISOString(),
    };

    pipeline.set(this.keys.user(id), updatedUser);
    await pipeline.exec();

    return updatedUser;
  }

  async deleteUser(id: string): Promise<boolean> {
    const user = await this.getUser(id);
    if (!user) return false;

    const pipeline = this.redis.pipeline();
    pipeline.del(this.keys.user(id));
    pipeline.del(this.keys.userHandle(user.handle.toLowerCase()));
    if (user.email) {
      pipeline.del(this.keys.userEmail(user.email.toLowerCase()));
    }
    pipeline.srem(this.keys.usersAll(), id);
    await pipeline.exec();

    // Clean up related data
    await this.deleteUserSessions(id);
    await this.deleteTOTPSecret(user.handle);
    await this.deleteBackupCodes(id);

    return true;
  }

  async hasUsers(): Promise<boolean> {
    const count = await this.redis.scard(this.keys.usersAll());
    return count > 0;
  }

  // ==========================================================================
  // Session Operations
  // ==========================================================================

  async getSession(id: string): Promise<Session | null> {
    const session = await this.redis.get<Session>(this.keys.session(id));
    if (!session) return null;

    // Check expiration
    if (new Date(session.expires) < this.nowDate()) {
      await this.deleteSession(id);
      return null;
    }

    return session;
  }

  async getSessionsByUser(userId: string): Promise<Session[]> {
    const now = this.nowMs();

    // Get non-expired session IDs from the sorted set
    const sessionIds = await this.redis.zrange(
      this.keys.sessionsByUser(userId),
      now,
      '+inf',
      { byScore: true },
    );
    if (!sessionIds.length) return [];

    const pipeline = this.redis.pipeline();
    for (const sid of sessionIds) {
      pipeline.get(this.keys.session(sid as string));
    }
    const results = await pipeline.exec<(Session | null)[]>();

    return results.filter((s): s is Session => s !== null);
  }

  async getAllSessions(): Promise<Session[]> {
    const userIds = await this.redis.smembers(this.keys.usersAll());
    const allSessions: Session[] = [];

    for (const userId of userIds) {
      const sessions = await this.getSessionsByUser(userId as string);
      allSessions.push(...sessions);
    }

    return allSessions;
  }

  async createSession(
    userId: string,
    user: Partial<AdminUser>,
    metadata?: SessionMetadata,
  ): Promise<Session> {
    const id = randomUUID();
    const now = this.nowDate();
    const expires = new Date(now.getTime() + this.sessionMaxAge);

    const session: Session = {
      id,
      userId,
      expires: expires.toISOString(),
      expiresAt: expires.toISOString(),
      createdAt: now.toISOString(),
      user: {
        id: user.id || userId,
        username: user.handle || '',
        name: user.displayName || user.handle || '',
        role: user.role || 'viewer',
        needsOnboarding: user.needsOnboarding,
        onboardingStep: user.onboardingStep,
      },
      clientIp: metadata?.clientIp || 'unknown',
      clientIpMasked: metadata?.clientIpMasked,
      userAgent: metadata?.userAgent || 'unknown',
      deviceType: metadata?.deviceType || 'unknown',
      browserFingerprint: metadata?.browserFingerprint,
      geoLocation: metadata?.geoLocation,
    };

    const pipeline = this.redis.pipeline();
    pipeline.set(this.keys.session(id), session);
    pipeline.zadd(this.keys.sessionsByUser(userId), {
      score: expires.getTime(),
      member: id,
    });
    await pipeline.exec();

    return session;
  }

  async updateSession(id: string, updates: Partial<Session>): Promise<Session> {
    const existing = await this.getSession(id);
    if (!existing) {
      throw new Error(`Session ${id} not found`);
    }

    const updatedSession: Session = {
      ...existing,
      ...updates,
      id, // Ensure ID is not changed
    };

    const pipeline = this.redis.pipeline();
    pipeline.set(this.keys.session(id), updatedSession);

    // If expiry changed, update the sorted set score
    if (updates.expires && updates.expires !== existing.expires) {
      pipeline.zadd(this.keys.sessionsByUser(existing.userId), {
        score: new Date(updates.expires).getTime(),
        member: id,
      });
    }

    await pipeline.exec();
    return updatedSession;
  }

  async deleteSession(id: string): Promise<boolean> {
    const session = await this.redis.get<Session>(this.keys.session(id));
    if (!session) return false;

    const pipeline = this.redis.pipeline();
    pipeline.del(this.keys.session(id));
    pipeline.zrem(this.keys.sessionsByUser(session.userId), id);
    await pipeline.exec();

    return true;
  }

  async deleteUserSessions(userId: string): Promise<number> {
    const sessionIds = await this.redis.zrange(
      this.keys.sessionsByUser(userId),
      '-inf' as const,
      '+inf',
      { byScore: true },
    );
    if (!sessionIds.length) return 0;

    const pipeline = this.redis.pipeline();
    for (const sid of sessionIds) {
      pipeline.del(this.keys.session(sid as string));
    }
    pipeline.del(this.keys.sessionsByUser(userId));
    await pipeline.exec();

    return sessionIds.length;
  }

  async cleanupExpiredSessions(): Promise<number> {
    const now = this.nowMs();
    let totalCleaned = 0;

    const userIds = await this.redis.smembers(this.keys.usersAll());

    for (const userId of userIds) {
      const key = this.keys.sessionsByUser(userId as string);
      const expiredIds = await this.redis.zrange(key, '-inf' as const, now, { byScore: true });

      if (expiredIds.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const sid of expiredIds) {
          pipeline.del(this.keys.session(sid as string));
        }
        pipeline.zremrangebyscore(key, '-inf', now);
        await pipeline.exec();
        totalCleaned += expiredIds.length;
      }
    }

    return totalCleaned;
  }

  // ==========================================================================
  // TOTP Operations
  // ==========================================================================

  async getTOTPSecret(handle: string): Promise<EncryptedTOTPSecret | null> {
    const data = await this.redis.get<EncryptedTOTPSecret>(this.keys.totp(handle.toLowerCase()));
    return data ?? null;
  }

  async saveTOTPSecret(handle: string, secret: EncryptedTOTPSecret): Promise<void> {
    await this.redis.set(this.keys.totp(handle.toLowerCase()), secret);
  }

  async deleteTOTPSecret(handle: string): Promise<boolean> {
    const result = await this.redis.del(this.keys.totp(handle.toLowerCase()));
    return result > 0;
  }

  // ==========================================================================
  // Backup Code Operations
  // ==========================================================================

  async getBackupCodes(userId: string): Promise<BackupCodeSet | null> {
    const data = await this.redis.get<BackupCodeSet>(this.keys.backup(userId));
    return data ?? null;
  }

  async saveBackupCodes(userId: string, codes: BackupCodeSet): Promise<void> {
    await this.redis.set(this.keys.backup(userId), codes);
  }

  async deleteBackupCodes(userId: string): Promise<boolean> {
    const result = await this.redis.del(this.keys.backup(userId));
    return result > 0;
  }

  // ==========================================================================
  // Invitation Operations
  // ==========================================================================

  async getInvitation(token: string): Promise<AdminInvitation | null> {
    const invitation = await this.redis.get<AdminInvitation>(this.keys.invite(token));
    if (!invitation) return null;

    if (new Date(invitation.expiresAt) < this.nowDate()) {
      return null;
    }

    return invitation;
  }

  async getInvitationById(id: string): Promise<AdminInvitation | null> {
    const token = await this.redis.get<string>(this.keys.inviteById(id));
    if (!token) return null;
    const data = await this.redis.get<AdminInvitation>(this.keys.invite(token));
    return data ?? null;
  }

  async getAllInvitations(): Promise<AdminInvitation[]> {
    const tokens = await this.redis.smembers(this.keys.invitesAll());
    if (!tokens.length) return [];

    const pipeline = this.redis.pipeline();
    for (const token of tokens) {
      pipeline.get(this.keys.invite(token as string));
    }
    const results = await pipeline.exec<(AdminInvitation | null)[]>();

    return results.filter((i): i is AdminInvitation => i !== null);
  }

  async getPendingInvitations(): Promise<AdminInvitation[]> {
    const tokens = await this.redis.smembers(this.keys.invitesPending());
    if (!tokens.length) return [];

    const now = this.nowDate();
    const pipeline = this.redis.pipeline();
    for (const token of tokens) {
      pipeline.get(this.keys.invite(token as string));
    }
    const results = await pipeline.exec<(AdminInvitation | null)[]>();

    return results.filter(
      (i): i is AdminInvitation =>
        i !== null && new Date(i.expiresAt) > now && !i.usedAt,
    );
  }

  async createInvitation(
    invitation: Omit<AdminInvitation, 'id'>,
  ): Promise<AdminInvitation> {
    const id = randomUUID();
    const newInvitation: AdminInvitation = { ...invitation, id } as AdminInvitation;

    const pipeline = this.redis.pipeline();
    pipeline.set(this.keys.invite(invitation.token), newInvitation);
    pipeline.set(this.keys.inviteById(id), invitation.token);
    pipeline.sadd(this.keys.invitesAll(), invitation.token);
    if (!invitation.usedAt) {
      pipeline.sadd(this.keys.invitesPending(), invitation.token);
    }
    await pipeline.exec();

    return newInvitation;
  }

  async updateInvitation(
    token: string,
    updates: Partial<AdminInvitation>,
  ): Promise<AdminInvitation> {
    const existing = await this.redis.get<AdminInvitation>(this.keys.invite(token));
    if (!existing) {
      throw new Error('Invitation not found');
    }

    const updatedInvitation: AdminInvitation = {
      ...existing,
      ...updates,
    };

    const pipeline = this.redis.pipeline();
    pipeline.set(this.keys.invite(token), updatedInvitation);

    // If invitation was used or deactivated, remove from pending
    if (updates.usedAt || updates.isActive === false) {
      pipeline.srem(this.keys.invitesPending(), token);
    }

    await pipeline.exec();
    return updatedInvitation;
  }

  async deleteInvitation(token: string): Promise<boolean> {
    const invitation = await this.redis.get<AdminInvitation>(this.keys.invite(token));
    if (!invitation) return false;

    const pipeline = this.redis.pipeline();
    pipeline.del(this.keys.invite(token));
    pipeline.del(this.keys.inviteById(invitation.id));
    pipeline.srem(this.keys.invitesAll(), token);
    pipeline.srem(this.keys.invitesPending(), token);
    await pipeline.exec();

    return true;
  }

  async cleanupExpiredInvitations(): Promise<number> {
    const all = await this.getAllInvitations();
    const now = this.nowDate();
    let count = 0;

    for (const invitation of all) {
      if (new Date(invitation.expiresAt) < now || invitation.usedAt) {
        await this.deleteInvitation(invitation.token);
        count++;
      }
    }

    return count;
  }

  // ==========================================================================
  // Audit Operations
  // ==========================================================================

  async logAuditEvent(event: Omit<AuditEvent, 'id'>): Promise<AuditEvent> {
    const id = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const auditEvent: AuditEvent = { ...event, id } as AuditEvent;
    const timestamp = new Date(event.timestamp).getTime();

    const pipeline = this.redis.pipeline();
    pipeline.set(this.keys.audit(id), auditEvent);
    pipeline.zadd(this.keys.auditLog(), { score: timestamp, member: id });
    await pipeline.exec();

    return auditEvent;
  }

  async getAuditEvents(filters: AuditEventFilters): Promise<AuditEvent[]> {
    const minScore = filters.startDate ? filters.startDate.getTime() : '-inf';
    const maxScore = filters.endDate ? filters.endDate.getTime() : '+inf';

    const eventIds = await this.redis.zrange(
      this.keys.auditLog(),
      minScore as number | '-inf' | '+inf',
      maxScore as number | '-inf' | '+inf',
      { byScore: true },
    );
    if (!eventIds.length) return [];

    const pipeline = this.redis.pipeline();
    for (const eid of eventIds) {
      pipeline.get(this.keys.audit(eid as string));
    }
    const results = await pipeline.exec<(AuditEvent | null)[]>();

    let events = results.filter((e): e is AuditEvent => e !== null);

    if (filters.type) {
      events = events.filter((e) => e.type === filters.type);
    }
    if (filters.userId) {
      events = events.filter((e) => e.userId === filters.userId);
    }
    if (filters.severity) {
      events = events.filter((e) => e.severity === filters.severity);
    }

    if (filters.offset) {
      events = events.slice(filters.offset);
    }
    if (filters.limit) {
      events = events.slice(0, filters.limit);
    }

    return events;
  }

  async getRecentAuditEvents(limit = 100): Promise<AuditEvent[]> {
    const eventIds = await this.redis.zrange(this.keys.auditLog(), -limit, -1);
    if (!eventIds.length) return [];

    const pipeline = this.redis.pipeline();
    for (const eid of eventIds) {
      pipeline.get(this.keys.audit(eid as string));
    }
    const results = await pipeline.exec<(AuditEvent | null)[]>();

    return results
      .filter((e): e is AuditEvent => e !== null)
      .reverse(); // Most recent first
  }
}

/**
 * Factory function for creating a RedisStorageAdapter
 */
export const createRedisStorageAdapter = (config: RedisStorageConfig): RedisStorageAdapter =>
  new RedisStorageAdapter(config);
