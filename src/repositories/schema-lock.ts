import type { Pool, PoolClient } from 'pg';

/** Every instance migrates on cold start; this key serializes them. */
const SCHEMA_LOCK_KEY = 7_318_004_211;

/**
 * Runs schema statements under a transaction-scoped advisory lock, so two
 * instances starting against a fresh database can't race on CREATE TABLE.
 * Works through Neon's transaction-mode pooler.
 */
export async function migrate(pool: Pool, run: (db: Pick<PoolClient, 'query'>) => Promise<unknown>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK_KEY]);
    await run(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
