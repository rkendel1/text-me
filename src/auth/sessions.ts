import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Pool } from 'pg';

import { migrate } from '../repositories/schema-lock.js';

/**
 * One authentication model for every owner surface: the browser control plane
 * and the iOS app both exchange the owner's access key for a session, then send
 * `Authorization: Bearer <session>`. Sessions expire, slide while used, and can
 * be revoked one by one. The access key itself is never stored on a device.
 */
export type SessionPlatform = 'web' | 'ios';

export interface OwnerAuthSession {
  id: string;
  ownerId: string;
  platform: SessionPlatform;
  label: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface OwnerAuthSessionStore {
  create(session: OwnerAuthSession, tokenHash: string): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<OwnerAuthSession | null>;
  touch(id: string, lastUsedAt: Date, expiresAt: Date): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  list(ownerId: string): Promise<OwnerAuthSession[]>;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Extend a session at most this often, so every request isn't a write. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = 'ses_';

export type AuthResult =
  | { ok: true; ownerId: string; session?: OwnerAuthSession; credential: 'session' | 'access_key' }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'revoked' };

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

function safeEqual(given: string, expected: string): boolean {
  const left = Buffer.from(hash(given));
  const right = Buffer.from(hash(expected));
  return timingSafeEqual(left, right);
}

export class OwnerAuthService {
  constructor(
    private readonly store: OwnerAuthSessionStore,
    private readonly accessKey: string | undefined,
    private readonly ownerId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether the server has an access key at all (tests and local demos may run open). */
  get enforced(): boolean {
    return Boolean(this.accessKey);
  }

  async signIn(accessKey: string, input: { platform: SessionPlatform; label?: string }):
    Promise<{ token: string; session: OwnerAuthSession } | null> {
    if (!this.accessKey || !accessKey || !safeEqual(accessKey, this.accessKey)) return null;
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const now = new Date(this.now());
    const session: OwnerAuthSession = {
      id: `sess_${randomBytes(9).toString('hex')}`,
      ownerId: this.ownerId,
      platform: input.platform,
      label: (input.label ?? (input.platform === 'ios' ? 'iPhone' : 'Browser')).slice(0, 80),
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    };
    await this.store.create(session, hash(token));
    return { token, session };
  }

  async authenticate(token: string | undefined): Promise<AuthResult> {
    if (!this.accessKey) return { ok: true, ownerId: this.ownerId, credential: 'access_key' };
    if (!token) return { ok: false, reason: 'missing' };
    if (!token.startsWith(TOKEN_PREFIX)) {
      // The access key still works as an API credential (scripts, the smoke test); surfaces use sessions.
      return safeEqual(token, this.accessKey)
        ? { ok: true, ownerId: this.ownerId, credential: 'access_key' }
        : { ok: false, reason: 'invalid' };
    }
    const session = await this.store.findByTokenHash(hash(token));
    if (!session) return { ok: false, reason: 'invalid' };
    if (session.revokedAt) return { ok: false, reason: 'revoked' };
    const now = this.now();
    if (session.expiresAt.getTime() <= now) return { ok: false, reason: 'expired' };
    if (now - session.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
      session.lastUsedAt = new Date(now);
      session.expiresAt = new Date(now + SESSION_TTL_MS);
      await this.store.touch(session.id, session.lastUsedAt, session.expiresAt);
    }
    return { ok: true, ownerId: session.ownerId, session, credential: 'session' };
  }

  async revoke(ownerId: string, sessionId: string): Promise<boolean> {
    const session = (await this.store.list(ownerId)).find((item) => item.id === sessionId);
    if (!session) return false;
    if (!session.revokedAt) await this.store.revoke(session.id, new Date(this.now()));
    return true;
  }

  async list(ownerId: string): Promise<OwnerAuthSession[]> {
    const now = this.now();
    return (await this.store.list(ownerId)).filter((session) => !session.revokedAt && session.expiresAt.getTime() > now);
  }
}

export class InMemoryOwnerAuthSessionStore implements OwnerAuthSessionStore {
  private readonly sessions = new Map<string, { session: OwnerAuthSession; tokenHash: string }>();

  async create(session: OwnerAuthSession, tokenHash: string): Promise<void> {
    this.sessions.set(session.id, { session: structuredClone(session), tokenHash });
  }

  async findByTokenHash(tokenHash: string): Promise<OwnerAuthSession | null> {
    const found = [...this.sessions.values()].find((entry) => entry.tokenHash === tokenHash);
    return found ? structuredClone(found.session) : null;
  }

  async touch(id: string, lastUsedAt: Date, expiresAt: Date): Promise<void> {
    const entry = this.sessions.get(id);
    if (entry) Object.assign(entry.session, { lastUsedAt, expiresAt });
  }

  async revoke(id: string, at: Date): Promise<void> {
    const entry = this.sessions.get(id);
    if (entry) entry.session.revokedAt = at;
  }

  async list(ownerId: string): Promise<OwnerAuthSession[]> {
    return [...this.sessions.values()].filter((entry) => entry.session.ownerId === ownerId)
      .map((entry) => structuredClone(entry.session));
  }
}

interface SessionRow {
  id: string;
  owner_id: string;
  platform: SessionPlatform;
  label: string;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const toSession = (row: SessionRow): OwnerAuthSession => ({
  id: row.id,
  ownerId: row.owner_id,
  platform: row.platform,
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
});

export class PostgresOwnerAuthSessionStore implements OwnerAuthSessionStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await migrate(this.pool, async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS owner_auth_sessions (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          platform TEXT NOT NULL,
          label TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          last_used_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ
        )
      `);
    });
  }

  async create(session: OwnerAuthSession, tokenHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO owner_auth_sessions (id, owner_id, token_hash, platform, label, created_at, last_used_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [session.id, session.ownerId, tokenHash, session.platform, session.label, session.createdAt, session.lastUsedAt, session.expiresAt],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<OwnerAuthSession | null> {
    const result = await this.pool.query<SessionRow>('SELECT * FROM owner_auth_sessions WHERE token_hash = $1', [tokenHash]);
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async touch(id: string, lastUsedAt: Date, expiresAt: Date): Promise<void> {
    await this.pool.query('UPDATE owner_auth_sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1 AND revoked_at IS NULL',
      [id, lastUsedAt, expiresAt]);
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE owner_auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1', [id, at]);
  }

  async list(ownerId: string): Promise<OwnerAuthSession[]> {
    const result = await this.pool.query<SessionRow>(
      'SELECT * FROM owner_auth_sessions WHERE owner_id = $1 ORDER BY created_at DESC', [ownerId]);
    return result.rows.map(toSession);
  }
}
