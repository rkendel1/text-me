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

/**
 * The single-owner schema called the tenant column `owner_id`; the SaaS schema
 * calls it `account_id`. Renaming is structural only: legacy rows keep their
 * old value (e.g. 'owner'), which matches no account, so they stay invisible
 * until the legacy migration assigns them to a real account.
 */
export async function renameOwnerColumn(db: Pick<PoolClient, 'query'>, table: string): Promise<void> {
  await db.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name = 'owner_id')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '${table}' AND column_name = 'account_id') THEN
        ALTER TABLE ${table} RENAME COLUMN owner_id TO account_id;
      END IF;
    END $$;
  `);
}
