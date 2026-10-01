import type { Pool } from 'pg';

import type { CallSessionRecord } from '../calls/model.js';
import type { CostComponent, UsageEvent, UsageRecord } from '../calls/cost/model.js';
import type { AwaitingFinalUsageQuery, CallUsageStore, CostRow, CostRowQuery } from '../calls/cost/store.js';
import { PostgresCallSessionStore } from './postgres-call-session-repository.js';
import { migrate } from './schema-lock.js';

interface Row {
  id: string; call_session_id: string; account_id: string; subject: string; idempotency_key: string; category: string; provider: string;
  product: string; model: string | null; metric: string; quantity: string; unit: string; basis: string; source: string;
  reported_amount: string | null; reported_currency: string | null; occurred_at: Date; recorded_at: Date; metadata: Record<string, unknown>;
  c_id: string; c_amount: string | null; c_currency: string | null; c_rate_source: string; c_rate_id: string | null; c_rate: string | null;
  c_rate_per: string | null; c_rate_unit: string | null; c_priced_quantity: string | null; c_priced_at: Date;
}

const num = (value: string | null): number | null => (value === null ? null : Number(value));

function toRecord(row: Row): UsageRecord {
  const event: UsageEvent = {
    id: row.id, callSessionId: row.call_session_id, accountId: row.account_id, subject: row.subject, idempotencyKey: row.idempotency_key,
    category: row.category as UsageEvent['category'], provider: row.provider, product: row.product, model: row.model,
    metric: row.metric as UsageEvent['metric'], quantity: Number(row.quantity), unit: row.unit as UsageEvent['unit'],
    basis: row.basis as UsageEvent['basis'], source: row.source as UsageEvent['source'],
    reportedAmount: num(row.reported_amount), reportedCurrency: row.reported_currency,
    occurredAt: new Date(row.occurred_at), recordedAt: new Date(row.recorded_at), metadata: row.metadata ?? {},
  };
  const component: CostComponent = {
    id: row.c_id, usageEventId: row.id, callSessionId: row.call_session_id, accountId: row.account_id, amount: num(row.c_amount),
    currency: row.c_currency, rateSource: row.c_rate_source as CostComponent['rateSource'], rateId: row.c_rate_id, rate: num(row.c_rate),
    ratePer: num(row.c_rate_per), rateUnit: row.c_rate_unit as CostComponent['rateUnit'], pricedQuantity: num(row.c_priced_quantity), pricedAt: new Date(row.c_priced_at),
  };
  return { event, component };
}

const SELECT = `
  SELECT e.*, c.id AS c_id, c.amount AS c_amount, c.currency AS c_currency, c.rate_source AS c_rate_source, c.rate_id AS c_rate_id,
         c.rate AS c_rate, c.rate_per AS c_rate_per, c.rate_unit AS c_rate_unit, c.priced_quantity AS c_priced_quantity, c.priced_at AS c_priced_at
    FROM call_usage_events e JOIN call_cost_components c ON c.usage_event_id = e.id`;

/**
 * The cost ledger in Postgres. Two insert-only tables: what was used (`call_usage_events`) and what it was priced
 * at, with the rate (`call_cost_components`). This class never issues an UPDATE or DELETE against either.
 */
export class PostgresCallUsageStore implements CallUsageStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await migrate(this.pool, async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS call_usage_events (
          id TEXT PRIMARY KEY,
          call_session_id TEXT NOT NULL REFERENCES call_sessions(id),
          account_id TEXT NOT NULL,
          subject TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          category TEXT NOT NULL,
          provider TEXT NOT NULL,
          product TEXT NOT NULL,
          model TEXT,
          metric TEXT NOT NULL,
          quantity NUMERIC(24, 9) NOT NULL CHECK (quantity >= 0),
          unit TEXT NOT NULL,
          basis TEXT NOT NULL CHECK (basis IN ('estimated', 'final')),
          source TEXT NOT NULL,
          reported_amount NUMERIC(24, 9),
          reported_currency TEXT,
          occurred_at TIMESTAMPTZ NOT NULL,
          recorded_at TIMESTAMPTZ NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        );
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS call_cost_components (
          id TEXT PRIMARY KEY,
          usage_event_id TEXT NOT NULL UNIQUE REFERENCES call_usage_events(id),
          call_session_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          amount NUMERIC(24, 9),
          currency TEXT,
          rate_source TEXT NOT NULL CHECK (rate_source IN ('rate_card', 'provider_reported', 'unpriced')),
          rate_id TEXT,
          rate NUMERIC(24, 12),
          rate_per NUMERIC(24, 9),
          rate_unit TEXT,
          priced_quantity NUMERIC(24, 9),
          priced_at TIMESTAMPTZ NOT NULL
        );
      `);
      // A call's ledger (call.get), and an account's usage over time (aggregation).
      await db.query('CREATE INDEX IF NOT EXISTS idx_call_usage_call ON call_usage_events (account_id, call_session_id)');
      await db.query('CREATE INDEX IF NOT EXISTS idx_call_usage_account_time ON call_usage_events (account_id, occurred_at)');
      // Finalization looks for calls with no authoritative telephony usage.
      await db.query(`CREATE INDEX IF NOT EXISTS idx_call_usage_final_telephony ON call_usage_events (call_session_id) WHERE basis = 'final' AND category = 'telephony'`);
    });
  }

  async append(event: UsageEvent, component: CostComponent): Promise<{ record: UsageRecord; duplicate: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO call_usage_events (id, call_session_id, account_id, subject, idempotency_key, category, provider, product, model, metric, quantity, unit,
           basis, source, reported_amount, reported_currency, occurred_at, recorded_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [event.id, event.callSessionId, event.accountId, event.subject, event.idempotencyKey, event.category, event.provider, event.product, event.model,
          event.metric, event.quantity, event.unit, event.basis, event.source, event.reportedAmount, event.reportedCurrency, event.occurredAt, event.recordedAt,
          JSON.stringify(event.metadata)],
      );
      const created = inserted.rowCount === 1;
      if (created) {
        await client.query(
          `INSERT INTO call_cost_components (id, usage_event_id, call_session_id, account_id, amount, currency, rate_source, rate_id, rate, rate_per, rate_unit, priced_quantity, priced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [component.id, event.id, component.callSessionId, component.accountId, component.amount, component.currency, component.rateSource, component.rateId,
            component.rate, component.ratePer, component.rateUnit, component.pricedQuantity, component.pricedAt],
        );
      }
      const stored = await client.query<Row>(`${SELECT} WHERE e.idempotency_key = $1`, [event.idempotencyKey]);
      await client.query('COMMIT');
      return { record: toRecord(stored.rows[0]), duplicate: !created };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listForCall(accountId: string, callSessionId: string): Promise<UsageRecord[]> {
    const result = await this.pool.query<Row>(`${SELECT} WHERE e.account_id = $1 AND e.call_session_id = $2 ORDER BY e.recorded_at, e.id`, [accountId, callSessionId]);
    return result.rows.map(toRecord);
  }

  async listCostRows(query: CostRowQuery): Promise<CostRow[]> {
    const result = await this.pool.query<Row & { s_direction: CostRow['direction']; s_status: CostRow['outcome']; s_provider: string; s_created_at: Date }>(
      `SELECT e.*, c.id AS c_id, c.amount AS c_amount, c.currency AS c_currency, c.rate_source AS c_rate_source, c.rate_id AS c_rate_id,
              c.rate AS c_rate, c.rate_per AS c_rate_per, c.rate_unit AS c_rate_unit, c.priced_quantity AS c_priced_quantity, c.priced_at AS c_priced_at,
              s.direction AS s_direction, s.status AS s_status, s.provider AS s_provider, s.created_at AS s_created_at
         FROM call_usage_events e
         JOIN call_cost_components c ON c.usage_event_id = e.id
         JOIN call_sessions s ON s.id = e.call_session_id AND s.account_id = e.account_id
        WHERE e.account_id = $1 AND ($2::timestamptz IS NULL OR e.occurred_at >= $2) AND ($3::timestamptz IS NULL OR e.occurred_at < $3)
        ORDER BY e.occurred_at, e.id LIMIT $4`,
      [query.accountId, query.from ?? null, query.to ?? null, query.limit],
    );
    return result.rows.map((row) => ({
      record: toRecord(row), direction: row.s_direction, outcome: row.s_status, callProvider: row.s_provider, callCreatedAt: new Date(row.s_created_at),
    }));
  }

  async findCallsAwaitingFinalUsage(query: AwaitingFinalUsageQuery): Promise<CallSessionRecord[]> {
    const sessions = await this.pool.query<{ id: string }>(
      `SELECT s.id FROM call_sessions s
        WHERE s.status IN ('completed', 'failed', 'no_answer', 'busy', 'canceled') AND s.provider_call_id IS NOT NULL
          AND s.ended_at >= $1 AND s.ended_at < $2
          AND NOT EXISTS (SELECT 1 FROM call_usage_events e WHERE e.call_session_id = s.id AND e.basis = 'final' AND e.category = 'telephony')
        ORDER BY s.ended_at DESC LIMIT $3`,
      [query.endedAfter, query.endedBefore, query.limit],
    );
    if (sessions.rows.length === 0) return [];
    const store = new PostgresCallSessionStore(this.pool);
    const found = await Promise.all(sessions.rows.map((row) => store.findById(row.id)));
    return found.filter((session): session is CallSessionRecord => session !== null);
  }
}
