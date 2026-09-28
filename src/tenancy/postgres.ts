import type { Pool } from 'pg';

import { migrate } from '../repositories/schema-lock.js';
import type {
  Account,
  AuditEvent,
  Membership,
  PhoneNumber,
  Plane,
  ProviderConfiguration,
  Subscription,
  User,
} from './model.js';
import { EmailTakenError, PhoneNumberTakenError, type PhoneNumberPatch, type TenancyStore } from './store.js';

const uniqueViolation = (error: unknown, constraint?: string) =>
  (error as { code?: string }).code === '23505' && (!constraint || (error as { constraint?: string }).constraint === constraint);

interface UserRow { id: string; name: string; email: string; password_hash: string; created_at: Date; updated_at: Date }
interface AccountRow { id: string; name: string; onboarding_state: Account['onboardingState']; created_at: Date; updated_at: Date }
interface MembershipRow { id: string; account_id: string; user_id: string; role: Membership['role']; created_at: Date }
interface PhoneNumberRow {
  id: string; account_id: string; kind: PhoneNumber['kind']; number: string; status: PhoneNumber['status']; provider: string;
  provider_ref: string | null; verification_status: PhoneNumber['verificationStatus']; verification_code_hash: string | null;
  verification_expires_at: Date | null; verification_attempts: number; verified_at: Date | null; created_at: Date; updated_at: Date;
}
interface PlaneRow { id: string; account_id: string; name: string; status: Plane['status']; created_at: Date; updated_at: Date }
interface SubscriptionRow {
  account_id: string; plan: string; status: Subscription['status']; stripe_customer_id: string | null;
  stripe_subscription_id: string | null; stripe_price_id: string | null; current_period_end: Date | null;
  entitlements: Subscription['entitlements']; created_at: Date; updated_at: Date;
}

const toUser = (row: UserRow): User => ({ id: row.id, name: row.name, email: row.email, createdAt: row.created_at, updatedAt: row.updated_at });
const toAccount = (row: AccountRow): Account => ({
  id: row.id, name: row.name, onboardingState: row.onboarding_state, createdAt: row.created_at, updatedAt: row.updated_at,
});
const toMembership = (row: MembershipRow): Membership => ({
  id: row.id, accountId: row.account_id, userId: row.user_id, role: row.role, createdAt: row.created_at,
});
const toPhoneNumber = (row: PhoneNumberRow): PhoneNumber => ({
  id: row.id, accountId: row.account_id, kind: row.kind, number: row.number, status: row.status, provider: row.provider,
  ...(row.provider_ref ? { providerRef: row.provider_ref } : {}),
  verificationStatus: row.verification_status,
  ...(row.verification_code_hash ? { verificationCodeHash: row.verification_code_hash } : {}),
  ...(row.verification_expires_at ? { verificationExpiresAt: row.verification_expires_at } : {}),
  verificationAttempts: row.verification_attempts,
  ...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at,
});

const PHONE_COLUMNS: Record<keyof PhoneNumberPatch, string> = {
  status: 'status',
  verificationStatus: 'verification_status',
  verificationCodeHash: 'verification_code_hash',
  verificationExpiresAt: 'verification_expires_at',
  verificationAttempts: 'verification_attempts',
  verifiedAt: 'verified_at',
  providerRef: 'provider_ref',
  number: 'number',
};

export class PostgresTenancyStore implements TenancyStore {
  constructor(private readonly pool: Pool) {}

  async authProviders(): Promise<string[]> {
    const result = await this.pool.query<{ id: string | null }>(`
      SELECT provider->>'id' AS id
      FROM neon_auth.project_config,
      LATERAL jsonb_array_elements(COALESCE(social_providers, '[]'::jsonb)) AS provider
    `).catch((error: unknown) => {
      // Older/local databases may not have Neon Auth installed.
      if ((error as { code?: string }).code === '42P01' || (error as { code?: string }).code === '3F000') return { rows: [] };
      throw error;
    });
    return result.rows.map((row) => row.id).filter((id): id is string => Boolean(id));
  }

  async initialize(): Promise<void> {
    await migrate(this.pool, async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          CONSTRAINT users_email_unique UNIQUE (email)
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          onboarding_state TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS memberships (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          UNIQUE (account_id, user_id)
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id)');
      await db.query(`
        CREATE TABLE IF NOT EXISTS phone_numbers (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          number TEXT NOT NULL,
          status TEXT NOT NULL,
          provider TEXT NOT NULL,
          provider_ref TEXT,
          verification_status TEXT NOT NULL,
          verification_code_hash TEXT,
          verification_expires_at TIMESTAMPTZ,
          verification_attempts INTEGER NOT NULL DEFAULT 0,
          verified_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      // A number can never silently become shared: an assistant line routes calls for exactly one
      // account, and a verified personal number identifies exactly one account's owner.
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS phone_numbers_line_unique ON phone_numbers (number)
        WHERE kind = 'assistant_line' AND status IN ('pending_verification', 'verified', 'active')`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS phone_numbers_personal_unique ON phone_numbers (number)
        WHERE kind = 'personal' AND status IN ('verified', 'active')`);
      await db.query('CREATE INDEX IF NOT EXISTS idx_phone_numbers_account ON phone_numbers (account_id)');
      await db.query(`
        CREATE TABLE IF NOT EXISTS planes (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          plan TEXT NOT NULL,
          status TEXT NOT NULL,
          stripe_customer_id TEXT,
          stripe_subscription_id TEXT,
          stripe_price_id TEXT,
          current_period_end TIMESTAMPTZ,
          entitlements JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await db.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT');
      await db.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT');
      await db.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_price_id TEXT');
      await db.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ');
      await db.query(`
        CREATE TABLE IF NOT EXISTS provider_configurations (
          account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          telephony_provider TEXT NOT NULL,
          messaging_provider TEXT NOT NULL,
          settings JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          user_id TEXT,
          type TEXT NOT NULL,
          detail JSONB NOT NULL DEFAULT '{}'::jsonb,
          occurred_at TIMESTAMPTZ NOT NULL
        )
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_audit_events_account ON audit_events (account_id, occurred_at DESC)');
    });
  }

  async createUser(user: User, passwordHash: string): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO users (id, name, email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [user.id, user.name, user.email, passwordHash, user.createdAt, user.updatedAt],
      );
    } catch (error) {
      if (uniqueViolation(error, 'users_email_unique')) throw new EmailTakenError();
      throw error;
    }
  }

  async getUser(id: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ? toUser(result.rows[0]) : null;
  }

  async findUserByEmail(email: string): Promise<{ user: User; passwordHash: string } | null> {
    const result = await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    const row = result.rows[0];
    return row ? { user: toUser(row), passwordHash: row.password_hash } : null;
  }

  async updateUser(id: string, patch: { name?: string }): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      'UPDATE users SET name = COALESCE($2, name), updated_at = NOW() WHERE id = $1 RETURNING *', [id, patch.name ?? null]);
    return result.rows[0] ? toUser(result.rows[0]) : null;
  }

  async createAccount(input: Parameters<TenancyStore['createAccount']>[0]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { account, membership, subscription, providerConfiguration: provider } = input;
      await client.query(
        'INSERT INTO accounts (id, name, onboarding_state, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
        [account.id, account.name, account.onboardingState, account.createdAt, account.updatedAt],
      );
      await client.query(
        'INSERT INTO memberships (id, account_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, $5)',
        [membership.id, membership.accountId, membership.userId, membership.role, membership.createdAt],
      );
      await client.query(
        'INSERT INTO subscriptions (account_id, plan, status, stripe_customer_id, stripe_subscription_id, stripe_price_id, current_period_end, entitlements, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [account.id, subscription.plan, subscription.status, subscription.stripeCustomerId ?? null, subscription.stripeSubscriptionId ?? null, subscription.stripePriceId ?? null, subscription.currentPeriodEnd ?? null, JSON.stringify(subscription.entitlements), subscription.createdAt, subscription.updatedAt],
      );
      await client.query(
        'INSERT INTO provider_configurations (account_id, telephony_provider, messaging_provider, settings, updated_at) VALUES ($1, $2, $3, $4, $5)',
        [account.id, provider.telephonyProvider, provider.messagingProvider, JSON.stringify(provider.settings), provider.updatedAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getAccount(id: string): Promise<Account | null> {
    const result = await this.pool.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [id]);
    return result.rows[0] ? toAccount(result.rows[0]) : null;
  }

  async updateAccount(id: string, patch: { name?: string; onboardingState?: Account['onboardingState'] }): Promise<Account | null> {
    const result = await this.pool.query<AccountRow>(
      `UPDATE accounts SET name = COALESCE($2, name), onboarding_state = COALESCE($3, onboarding_state), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, patch.name ?? null, patch.onboardingState ?? null],
    );
    return result.rows[0] ? toAccount(result.rows[0]) : null;
  }

  async getMembership(accountId: string, userId: string): Promise<Membership | null> {
    const result = await this.pool.query<MembershipRow>('SELECT * FROM memberships WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
    return result.rows[0] ? toMembership(result.rows[0]) : null;
  }

  async addMembership(membership: Membership): Promise<Membership> {
    await this.pool.query(
      'INSERT INTO memberships (id, account_id, user_id, role, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (account_id, user_id) DO NOTHING',
      [membership.id, membership.accountId, membership.userId, membership.role, membership.createdAt],
    );
    return (await this.getMembership(membership.accountId, membership.userId))!;
  }

  async removeMembership(accountId: string, userId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM memberships WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
    return (result.rowCount ?? 0) > 0;
  }

  async listMembershipsForUser(userId: string): Promise<Membership[]> {
    const result = await this.pool.query<MembershipRow>('SELECT * FROM memberships WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
    return result.rows.map(toMembership);
  }

  async listMembershipsForAccount(accountId: string): Promise<Membership[]> {
    const result = await this.pool.query<MembershipRow>('SELECT * FROM memberships WHERE account_id = $1 ORDER BY created_at ASC', [accountId]);
    return result.rows.map(toMembership);
  }

  async listPhoneNumbers(accountId: string): Promise<PhoneNumber[]> {
    const result = await this.pool.query<PhoneNumberRow>(
      "SELECT * FROM phone_numbers WHERE account_id = $1 AND status <> 'released' ORDER BY created_at ASC", [accountId]);
    return result.rows.map(toPhoneNumber);
  }

  async insertPhoneNumber(number: PhoneNumber): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO phone_numbers (id, account_id, kind, number, status, provider, provider_ref, verification_status,
           verification_code_hash, verification_expires_at, verification_attempts, verified_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [number.id, number.accountId, number.kind, number.number, number.status, number.provider, number.providerRef ?? null,
          number.verificationStatus, number.verificationCodeHash ?? null, number.verificationExpiresAt ?? null,
          number.verificationAttempts, number.verifiedAt ?? null, number.createdAt, number.updatedAt],
      );
    } catch (error) {
      if (uniqueViolation(error)) throw new PhoneNumberTakenError(number.number);
      throw error;
    }
  }

  async updatePhoneNumber(accountId: string, id: string, patch: PhoneNumberPatch): Promise<PhoneNumber | null> {
    const entries = (Object.keys(patch) as Array<keyof PhoneNumberPatch>).filter((key) => key in PHONE_COLUMNS);
    const sets = entries.map((key, index) => `${PHONE_COLUMNS[key]} = $${index + 3}`);
    try {
      const result = await this.pool.query<PhoneNumberRow>(
        `UPDATE phone_numbers SET ${[...sets, 'updated_at = NOW()'].join(', ')} WHERE id = $1 AND account_id = $2 RETURNING *`,
        [id, accountId, ...entries.map((key) => patch[key] ?? null)],
      );
      return result.rows[0] ? toPhoneNumber(result.rows[0]) : null;
    } catch (error) {
      if (uniqueViolation(error)) throw new PhoneNumberTakenError(String(patch.number ?? ''));
      throw error;
    }
  }

  async findAssistantLine(number: string): Promise<PhoneNumber | null> {
    const result = await this.pool.query<PhoneNumberRow>(
      "SELECT * FROM phone_numbers WHERE number = $1 AND kind = 'assistant_line' AND status IN ('verified', 'active')", [number]);
    return result.rows[0] ? toPhoneNumber(result.rows[0]) : null;
  }

  async listAssignedLines(): Promise<string[]> {
    const result = await this.pool.query<{ number: string }>(
      "SELECT number FROM phone_numbers WHERE kind = 'assistant_line' AND status IN ('pending_verification', 'verified', 'active')");
    return result.rows.map((row) => row.number);
  }

  async getPlane(accountId: string): Promise<Plane | null> {
    const result = await this.pool.query<PlaneRow>('SELECT * FROM planes WHERE account_id = $1', [accountId]);
    const row = result.rows[0];
    return row ? { id: row.id, accountId: row.account_id, name: row.name, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }

  async savePlane(plane: Plane): Promise<void> {
    await this.pool.query(
      `INSERT INTO planes (id, account_id, name, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [plane.id, plane.accountId, plane.name, plane.status, plane.createdAt, plane.updatedAt],
    );
  }

  async getSubscription(accountId: string): Promise<Subscription | null> {
    const result = await this.pool.query<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE account_id = $1', [accountId]);
    const row = result.rows[0];
    return row ? {
      accountId: row.account_id, plan: row.plan, status: row.status, entitlements: row.entitlements,
      ...(row.stripe_customer_id ? { stripeCustomerId: row.stripe_customer_id } : {}),
      ...(row.stripe_subscription_id ? { stripeSubscriptionId: row.stripe_subscription_id } : {}),
      ...(row.stripe_price_id ? { stripePriceId: row.stripe_price_id } : {}),
      ...(row.current_period_end ? { currentPeriodEnd: row.current_period_end } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }

  async updateSubscription(accountId: string, patch: Partial<Pick<Subscription, 'status' | 'stripeCustomerId' | 'stripeSubscriptionId' | 'stripePriceId' | 'currentPeriodEnd'>>): Promise<Subscription | null> {
    const current = await this.getSubscription(accountId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: new Date() };
    await this.pool.query(
      `UPDATE subscriptions SET status = $2, stripe_customer_id = $3, stripe_subscription_id = $4,
       stripe_price_id = $5, current_period_end = $6, updated_at = $7 WHERE account_id = $1`,
      [accountId, next.status, next.stripeCustomerId ?? null, next.stripeSubscriptionId ?? null,
        next.stripePriceId ?? null, next.currentPeriodEnd ?? null, next.updatedAt],
    );
    return next;
  }

  async findSubscriptionByStripeId(id: string): Promise<Subscription | null> {
    const result = await this.pool.query<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE stripe_customer_id = $1 OR stripe_subscription_id = $1 LIMIT 1', [id]);
    const row = result.rows[0];
    return row ? {
      accountId: row.account_id, plan: row.plan, status: row.status, entitlements: row.entitlements,
      ...(row.stripe_customer_id ? { stripeCustomerId: row.stripe_customer_id } : {}),
      ...(row.stripe_subscription_id ? { stripeSubscriptionId: row.stripe_subscription_id } : {}),
      ...(row.stripe_price_id ? { stripePriceId: row.stripe_price_id } : {}),
      ...(row.current_period_end ? { currentPeriodEnd: row.current_period_end } : {}),
      createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }

  async getProviderConfiguration(accountId: string): Promise<ProviderConfiguration | null> {
    const result = await this.pool.query<{ account_id: string; telephony_provider: string; messaging_provider: string; settings: Record<string, unknown>; updated_at: Date }>(
      'SELECT * FROM provider_configurations WHERE account_id = $1', [accountId]);
    const row = result.rows[0];
    return row ? {
      accountId: row.account_id, telephonyProvider: row.telephony_provider, messagingProvider: row.messaging_provider,
      settings: row.settings, updatedAt: row.updated_at,
    } : null;
  }

  async recordAudit(event: AuditEvent): Promise<void> {
    await this.pool.query(
      'INSERT INTO audit_events (id, account_id, user_id, type, detail, occurred_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING',
      [event.id, event.accountId, event.userId ?? null, event.type, JSON.stringify(event.detail), event.occurredAt],
    );
  }

  async listAudit(accountId: string, limit = 100): Promise<AuditEvent[]> {
    const result = await this.pool.query<{ id: string; account_id: string; user_id: string | null; type: string; detail: Record<string, unknown>; occurred_at: Date }>(
      'SELECT * FROM audit_events WHERE account_id = $1 ORDER BY occurred_at DESC LIMIT $2', [accountId, limit]);
    return result.rows.map((row) => ({
      id: row.id, accountId: row.account_id, ...(row.user_id ? { userId: row.user_id } : {}), type: row.type, detail: row.detail, occurredAt: row.occurred_at,
    }));
  }
}
