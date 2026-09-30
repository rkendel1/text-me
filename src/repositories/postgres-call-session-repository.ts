import type { Pool, PoolClient } from 'pg';

import {
  CALL_SESSION_STATUSES,
  type CallDirection,
  type CallSessionRecord,
  type CallSessionStatus,
  type DialOutcome,
} from '../calls/model.js';
import {
  applyPatch,
  type CallSessionFilter,
  type CallSessionPatch,
  type CallSessionStore,
  type MutationOutcome,
  type MutationResult,
  type ProviderEventInput,
  type ReconcilableDialCriteria,
} from '../calls/store.js';
import { migrate } from './schema-lock.js';

interface CallSessionRow {
  id: string;
  account_id: string;
  direction: CallDirection;
  status: CallSessionStatus;
  provider: string;
  provider_call_id: string | null;
  from_number: string | null;
  to_number: string | null;
  conversation_id: string | null;
  started_at: Date | null;
  answered_at: Date | null;
  ended_at: Date | null;
  end_reason: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  requested_by: string | null;
  trace_id: string | null;
  idempotency_key: string | null;
  request_fingerprint: string | null;
  end_claimed_at: Date | null;
  last_provider_status: string | null;
  objective: string | null;
  dial_claimed_at: Date | null;
  dial_outcome: DialOutcome | null;
  reconciliation_attempts: number;
  last_reconciliation_at: Date | null;
}

const COLUMN_FOR: Record<keyof CallSessionPatch, string> = {
  status: 'status',
  providerCallId: 'provider_call_id',
  conversationId: 'conversation_id',
  from: 'from_number',
  to: 'to_number',
  startedAt: 'started_at',
  answeredAt: 'answered_at',
  endedAt: 'ended_at',
  endReason: 'end_reason',
  endClaimedAt: 'end_claimed_at',
  lastProviderStatus: 'last_provider_status',
  dialClaimedAt: 'dial_claimed_at',
  dialOutcome: 'dial_outcome',
  reconciliationAttempts: 'reconciliation_attempts',
  lastReconciliationAt: 'last_reconciliation_at',
};

function toRecord(row: CallSessionRow): CallSessionRecord {
  const date = (value: Date | null) => (value ? new Date(value) : null);
  return {
    id: row.id,
    accountId: row.account_id,
    direction: row.direction,
    status: row.status,
    provider: row.provider,
    providerCallId: row.provider_call_id,
    from: row.from_number,
    to: row.to_number,
    conversationId: row.conversation_id,
    startedAt: date(row.started_at),
    answeredAt: date(row.answered_at),
    endedAt: date(row.ended_at),
    endReason: row.end_reason,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    version: Number(row.version),
    requestedBy: row.requested_by,
    traceId: row.trace_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    endClaimedAt: date(row.end_claimed_at),
    lastProviderStatus: row.last_provider_status,
    objective: row.objective,
    dialClaimedAt: date(row.dial_claimed_at),
    dialOutcome: row.dial_outcome,
    reconciliationAttempts: Number(row.reconciliation_attempts ?? 0),
    lastReconciliationAt: date(row.last_reconciliation_at),
  };
}

export class PostgresCallSessionStore implements CallSessionStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await migrate(this.pool, async (db) => {
      const statuses = CALL_SESSION_STATUSES.map((status) => `'${status}'`).join(', ');
      await db.query(`
        CREATE TABLE IF NOT EXISTS call_sessions (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          status TEXT NOT NULL CHECK (status IN (${statuses})),
          provider TEXT NOT NULL,
          provider_call_id TEXT,
          from_number TEXT,
          to_number TEXT,
          conversation_id TEXT,
          started_at TIMESTAMPTZ,
          answered_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          end_reason TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          requested_by TEXT,
          trace_id TEXT,
          idempotency_key TEXT,
          request_fingerprint TEXT,
          end_claimed_at TIMESTAMPTZ,
          last_provider_status TEXT
        );
      `);
      // Outbound execution (added after the first release of this table): the objective, and the durable claim on the provider request.
      await db.query(`ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS objective TEXT, ADD COLUMN IF NOT EXISTS dial_claimed_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS dial_outcome TEXT`);
      await db.query(`ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS last_reconciliation_at TIMESTAMPTZ`);
      await db.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_sessions_dial_outcome_check') THEN
          ALTER TABLE call_sessions ADD CONSTRAINT call_sessions_dial_outcome_check CHECK (dial_outcome IS NULL OR dial_outcome IN ('pending', 'accepted', 'rejected', 'unconfirmed'));
        END IF;
      END $$`);
      // Webhooks find a call by the provider's id: one session per provider call.
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS call_sessions_provider_call ON call_sessions (provider, provider_call_id) WHERE provider_call_id IS NOT NULL`);
      // A retried request with the same key must land on the same session.
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS call_sessions_idempotency ON call_sessions (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
      // call.list: an account's calls, newest first (keyset on created_at, id), optionally by status.
      await db.query('CREATE INDEX IF NOT EXISTS idx_call_sessions_account_created ON call_sessions (account_id, created_at DESC, id DESC)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_call_sessions_account_status ON call_sessions (account_id, status, created_at DESC)');
      // Reconciling dials that never got a provider call id: a small, sparse set.
      await db.query(`CREATE INDEX IF NOT EXISTS idx_call_sessions_unconfirmed_dial ON call_sessions (dial_claimed_at) WHERE status = 'initiating' AND provider_call_id IS NULL`);
      // Reconciliation's own queue: a dial claimed but never tied to a provider call, whatever became of the session locally since.
      await db.query(`CREATE INDEX IF NOT EXISTS idx_call_sessions_dial_reconciliation ON call_sessions (dial_claimed_at) WHERE provider_call_id IS NULL AND dial_outcome IN ('pending', 'unconfirmed')`);
      // Owner Stop resolves a conversation's call.
      await db.query('CREATE INDEX IF NOT EXISTS idx_call_sessions_conversation ON call_sessions (conversation_id) WHERE conversation_id IS NOT NULL');
      // One row per provider callback, keyed by its identity: what makes redelivery harmless.
      await db.query(`
        CREATE TABLE IF NOT EXISTS call_provider_events (
          provider TEXT NOT NULL,
          event_id TEXT NOT NULL,
          call_session_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
          raw_status TEXT NOT NULL,
          sequence TEXT,
          provider_timestamp TEXT,
          outcome TEXT,
          received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (provider, event_id)
        );
      `);
      await db.query('CREATE INDEX IF NOT EXISTS idx_call_provider_events_session ON call_provider_events (call_session_id)');
    });
  }

  async insert(record: CallSessionRecord): Promise<{ session: CallSessionRecord; created: boolean }> {
    // No conflict target: either unique index (provider call, idempotency key) makes this a no-op.
    const result = await this.pool.query<CallSessionRow>(
      `INSERT INTO call_sessions (
         id, account_id, direction, status, provider, provider_call_id, from_number, to_number, conversation_id,
         started_at, answered_at, ended_at, end_reason, created_at, updated_at, version,
         requested_by, trace_id, idempotency_key, request_fingerprint, end_claimed_at, last_provider_status,
         objective, dial_claimed_at, dial_outcome, reconciliation_attempts, last_reconciliation_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        record.id, record.accountId, record.direction, record.status, record.provider, record.providerCallId,
        record.from, record.to, record.conversationId, record.startedAt, record.answeredAt, record.endedAt,
        record.endReason, record.createdAt, record.updatedAt, record.version, record.requestedBy, record.traceId,
        record.idempotencyKey, record.requestFingerprint, record.endClaimedAt, record.lastProviderStatus,
        record.objective, record.dialClaimedAt, record.dialOutcome, record.reconciliationAttempts, record.lastReconciliationAt,
      ],
    );
    if (result.rows[0]) return { session: toRecord(result.rows[0]), created: true };

    const existing = await this.pool.query<CallSessionRow>(
      `SELECT * FROM call_sessions
        WHERE ($1::text IS NOT NULL AND provider = $2 AND provider_call_id = $1)
           OR ($3::text IS NOT NULL AND account_id = $4 AND idempotency_key = $3)
        LIMIT 1`,
      [record.providerCallId, record.provider, record.idempotencyKey, record.accountId],
    );
    if (!existing.rows[0]) throw new Error('Call session insert conflicted but the existing session could not be found');
    return { session: toRecord(existing.rows[0]), created: false };
  }

  async get(accountId: string, id: string): Promise<CallSessionRecord | null> {
    const result = await this.pool.query<CallSessionRow>('SELECT * FROM call_sessions WHERE id = $1 AND account_id = $2', [id, accountId]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async findByProviderCallId(provider: string, providerCallId: string): Promise<CallSessionRecord | null> {
    const result = await this.pool.query<CallSessionRow>('SELECT * FROM call_sessions WHERE provider = $1 AND provider_call_id = $2', [provider, providerCallId]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async findByIdempotencyKey(accountId: string, idempotencyKey: string): Promise<CallSessionRecord | null> {
    const result = await this.pool.query<CallSessionRow>('SELECT * FROM call_sessions WHERE account_id = $1 AND idempotency_key = $2', [accountId, idempotencyKey]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async findById(id: string): Promise<CallSessionRecord | null> {
    const result = await this.pool.query<CallSessionRow>('SELECT * FROM call_sessions WHERE id = $1', [id]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async listReconcilableDials(criteria: ReconcilableDialCriteria): Promise<CallSessionRecord[]> {
    const result = await this.pool.query<CallSessionRow>(
      `SELECT * FROM call_sessions
        WHERE direction = 'outbound' AND provider_call_id IS NULL AND dial_outcome IN ('pending', 'unconfirmed')
          AND dial_claimed_at < $1 AND reconciliation_attempts < $3
          AND (last_reconciliation_at IS NULL OR last_reconciliation_at < $2)
        ORDER BY dial_claimed_at LIMIT $4`,
      [criteria.claimedBefore, criteria.attemptedBefore, criteria.maxAttempts, criteria.limit],
    );
    return result.rows.map(toRecord);
  }

  async countUnresolvedDials(maxAttempts: number): Promise<{ unresolved: number; exhausted: number }> {
    const result = await this.pool.query<{ unresolved: string; exhausted: string }>(
      `SELECT count(*) AS unresolved, count(*) FILTER (WHERE reconciliation_attempts >= $1) AS exhausted
         FROM call_sessions
        WHERE direction = 'outbound' AND provider_call_id IS NULL AND dial_claimed_at IS NOT NULL AND dial_outcome IN ('pending', 'unconfirmed')`,
      [maxAttempts],
    );
    return { unresolved: Number(result.rows[0]?.unresolved ?? 0), exhausted: Number(result.rows[0]?.exhausted ?? 0) };
  }

  async findByConversation(accountId: string, conversationId: string): Promise<CallSessionRecord | null> {
    const result = await this.pool.query<CallSessionRow>(
      'SELECT * FROM call_sessions WHERE account_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT 1',
      [accountId, conversationId],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async list(accountId: string, filter: CallSessionFilter): Promise<CallSessionRecord[]> {
    const where = ['account_id = $1'];
    const params: unknown[] = [accountId];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (filter.status?.length) add('status = ANY(?)', [...filter.status]);
    if (filter.direction) add('direction = ?', filter.direction);
    if (filter.createdAfter) add('created_at > ?', filter.createdAfter);
    if (filter.createdBefore) add('created_at < ?', filter.createdBefore);
    if (filter.after) {
      params.push(filter.after.createdAt, filter.after.id);
      where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(filter.limit);
    const result = await this.pool.query<CallSessionRow>(
      `SELECT * FROM call_sessions WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(toRecord);
  }

  async mutate(
    id: string,
    decide: (current: CallSessionRecord) => MutationOutcome,
    options: { providerEvent?: ProviderEventInput; now?: Date } = {},
  ): Promise<MutationResult | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<CallSessionRow>('SELECT * FROM call_sessions WHERE id = $1 FOR UPDATE', [id]);
      if (!locked.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const current = toRecord(locked.rows[0]);
      const now = options.now ?? new Date();

      if (options.providerEvent && !(await this.recordEvent(client, id, options.providerEvent))) {
        await client.query('COMMIT');
        return { session: current, changed: false, duplicateEvent: true };
      }

      const outcome = decide(structuredClone(current));
      if (options.providerEvent) {
        await client.query(
          'UPDATE call_provider_events SET outcome = $3 WHERE provider = $1 AND event_id = $2',
          [options.providerEvent.provider, options.providerEvent.eventId, outcome.eventOutcome ?? null],
        );
      }
      if (!outcome.patch || Object.keys(outcome.patch).length === 0) {
        await client.query('COMMIT');
        return { session: current, changed: false, duplicateEvent: false };
      }
      const next = applyPatch(current, outcome.patch, now);
      await this.write(client, id, outcome.patch, next);
      await client.query('COMMIT');
      return { session: next, changed: true, duplicateEvent: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** True when this callback had not been seen. */
  private async recordEvent(client: PoolClient, sessionId: string, event: ProviderEventInput): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO call_provider_events (provider, event_id, call_session_id, raw_status, sequence, provider_timestamp)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [event.provider, event.eventId, sessionId, event.rawStatus, event.sequence ?? null, event.providerTimestamp ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async write(client: PoolClient, id: string, patch: CallSessionPatch, next: CallSessionRecord): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const key of Object.keys(patch) as Array<keyof CallSessionPatch>) {
      params.push(next[key] ?? null);
      sets.push(`${COLUMN_FOR[key]} = $${params.length}`);
    }
    params.push(next.updatedAt, next.version);
    sets.push(`updated_at = $${params.length - 1}`, `version = $${params.length}`);
    await client.query(`UPDATE call_sessions SET ${sets.join(', ')} WHERE id = $1`, params);
  }
}
