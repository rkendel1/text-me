import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';

import { migrate } from '../repositories/schema-lock.js';

/**
 * One authentication model for every surface: the browser control plane and
 * the iOS app sign a *user* in (email + password) and get a session token,
 * then send `Authorization: Bearer <session>`. The session names the user and
 * their active account; which account is re-authorized against a live
 * membership on every request. Sessions expire, slide while used, and can be
 * revoked one by one. There is no shared access key and no unauthenticated mode.
 */
export type SessionPlatform = 'web' | 'ios';

export interface AuthSession {
  id: string;
  userId: string;
  /** The account this session is operating on; switchable to any account the user is a member of. */
  accountId: string;
  platform: SessionPlatform;
  label: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

export interface AuthSessionStore {
  create(session: AuthSession, tokenHash: string): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<AuthSession | null>;
  touch(id: string, lastUsedAt: Date, expiresAt: Date): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  setAccount(id: string, accountId: string): Promise<void>;
  listForUser(userId: string): Promise<AuthSession[]>;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Extend a session at most this often, so every request isn't a write. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = 'ses_';

export type AuthResult =
  | { ok: true; session: AuthSession }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'revoked' };

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class AuthService {
  constructor(
    private readonly store: AuthSessionStore,
    private readonly now: () => number = Date.now,
  ) {}

  async createSession(userId: string, accountId: string, input: { platform: SessionPlatform; label?: string }):
    Promise<{ token: string; session: AuthSession }> {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const now = new Date(this.now());
    const session: AuthSession = {
      id: `sess_${randomBytes(9).toString('hex')}`,
      userId,
      accountId,
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
    if (!token) return { ok: false, reason: 'missing' };
    if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, reason: 'invalid' };
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
    return { ok: true, session };
  }

  /** The caller must already have checked the user's membership in `accountId`. */
  async switchAccount(session: AuthSession, accountId: string): Promise<AuthSession> {
    await this.store.setAccount(session.id, accountId);
    return { ...session, accountId };
  }

  async revoke(userId: string, sessionId: string): Promise<AuthSession | null> {
    const session = (await this.store.listForUser(userId)).find((item) => item.id === sessionId);
    if (!session) return null;
    if (!session.revokedAt) await this.store.revoke(session.id, new Date(this.now()));
    return session;
  }

  async list(userId: string): Promise<AuthSession[]> {
    const now = this.now();
    return (await this.store.listForUser(userId)).filter((session) => !session.revokedAt && session.expiresAt.getTime() > now);
  }
}

export class InMemoryAuthSessionStore implements AuthSessionStore {
  private readonly sessions = new Map<string, { session: AuthSession; tokenHash: string }>();

  async create(session: AuthSession, tokenHash: string): Promise<void> {
    this.sessions.set(session.id, { session: structuredClone(session), tokenHash });
  }

  async findByTokenHash(tokenHash: string): Promise<AuthSession | null> {
    const found = [...this.sessions.values()].find((entry) => entry.tokenHash === tokenHash);
    return found ? structuredClone(found.session) : null;
  }

  async touch(id: string, lastUsedAt: Date, expiresAt: Date): Promise<void> {
    const entry = this.sessions.get(id);
    if (entry && !entry.session.revokedAt) Object.assign(entry.session, { lastUsedAt, expiresAt });
  }

  async revoke(id: string, at: Date): Promise<void> {
    const entry = this.sessions.get(id);
    if (entry) entry.session.revokedAt ??= at;
  }

  async setAccount(id: string, accountId: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (entry) entry.session.accountId = accountId;
  }

  async listForUser(userId: string): Promise<AuthSession[]> {
    return [...this.sessions.values()].filter((entry) => entry.session.userId === userId)
      .map((entry) => structuredClone(entry.session));
  }
}

interface SessionRow {
  id: string;
  user_id: string;
  account_id: string;
  platform: SessionPlatform;
  label: string;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

const toSession = (row: SessionRow): AuthSession => ({
  id: row.id,
  userId: row.user_id,
  accountId: row.account_id,
  platform: row.platform,
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
});

export class PostgresAuthSessionStore implements AuthSessionStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await migrate(this.pool, async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          platform TEXT NOT NULL,
          label TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          last_used_at TIMESTAMPTZ NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id)');
    });
  }

  async create(session: AuthSession, tokenHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_sessions (id, user_id, account_id, token_hash, platform, label, created_at, last_used_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [session.id, session.userId, session.accountId, tokenHash, session.platform, session.label, session.createdAt, session.lastUsedAt, session.expiresAt],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<AuthSession | null> {
    const result = await this.pool.query<SessionRow>('SELECT * FROM auth_sessions WHERE token_hash = $1', [tokenHash]);
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async touch(id: string, lastUsedAt: Date, expiresAt: Date): Promise<void> {
    await this.pool.query('UPDATE auth_sessions SET last_used_at = $2, expires_at = $3 WHERE id = $1 AND revoked_at IS NULL',
      [id, lastUsedAt, expiresAt]);
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE id = $1', [id, at]);
  }

  async setAccount(id: string, accountId: string): Promise<void> {
    await this.pool.query('UPDATE auth_sessions SET account_id = $2 WHERE id = $1 AND revoked_at IS NULL', [id, accountId]);
  }

  async listForUser(userId: string): Promise<AuthSession[]> {
    const result = await this.pool.query<SessionRow>(
      'SELECT * FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return result.rows.map(toSession);
  }
}
