/**
 * The existing single-owner deployment becomes an ordinary account, verified
 * through the same machinery (onboarding evaluation, phone-number lifecycle,
 * sign-in, account-scoped routes) as any new customer.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';

import pg from 'pg';
import request from 'supertest';

import { buildServerWithPool } from '../src/bootstrap.js';
import { getConfig } from '../src/config.js';
import { FakeMessagingProvider } from '../src/messaging/fake-provider.js';
import { FakePhoneNumberClient } from '../src/telephony/phone-number.js';
import { legacyIds, migrateLegacyDeployment } from '../src/tenancy/legacy-migration.js';
import { PASSWORD, signIn, signUp } from './support/tenant.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('legacy ids are deterministic and opaque', () => {
  const first = legacyIds('owner', 'Randy@Example.com');
  assert.deepEqual(first, legacyIds('owner', 'randy@example.com'));
  assert.match(first.accountId, /^acct_[0-9a-f]{24}$/);
  assert.ok(!first.accountId.includes('owner') && !first.userId.includes('randy'));
  assert.notEqual(legacyIds('someone-else', 'randy@example.com').accountId, first.accountId);
});

/** The schema and data a single-owner deployment had before accounts existed. */
async function seedLegacyDatabase(pool: pg.Pool) {
  await pool.query(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_call_id TEXT NOT NULL, caller_phone TEXT NOT NULL, status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ, duration_seconds INTEGER, state TEXT NOT NULL DEFAULT 'voice_active',
      channels JSONB NOT NULL DEFAULT '["voice"]', primary_channel TEXT NOT NULL DEFAULT 'voice', participants JSONB NOT NULL DEFAULT '[]',
      owner_id TEXT, last_owner_read_at TIMESTAMPTZ, UNIQUE (provider, provider_call_id));
    CREATE TABLE conversation_events (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      type TEXT NOT NULL, payload JSONB NOT NULL, occurred_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE owner_configurations (owner_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, assistant JSONB NOT NULL, calls JSONB NOT NULL,
      messages JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), onboarding JSONB NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE owner_configuration_revisions (owner_id TEXT NOT NULL, revision INTEGER NOT NULL, assistant JSONB NOT NULL, calls JSONB NOT NULL,
      messages JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (owner_id, revision));
    CREATE TABLE owner_configuration_audit (owner_id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL, occurred_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE owner_surface_devices (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, platform TEXT NOT NULL, device_token TEXT NOT NULL,
      capabilities JSONB NOT NULL DEFAULT '[]'::jsonb, label TEXT, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL,
      session_id TEXT, UNIQUE (owner_id, device_token));
    CREATE TABLE owner_attention (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      type TEXT NOT NULL, priority TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, actions JSONB NOT NULL DEFAULT '[]'::jsonb, status TEXT NOT NULL,
      dedupe_key TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ, UNIQUE (owner_id, dedupe_key));
    CREATE TABLE runtime_commands (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
      type TEXT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL, error TEXT, created_at TIMESTAMPTZ NOT NULL, processed_at TIMESTAMPTZ,
      applied_live_at TIMESTAMPTZ, runtime_id TEXT);
    CREATE TABLE owner_auth_sessions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, label TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, last_used_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ);
  `);
  const assistant = { ownerName: 'Randy', assistantName: 'Ava', behavior: 'automatic', greeting: "Hi, Randy's phone, Ava here.",
    ownerIntroduction: 'Randy prefers text.', tone: 'warm', responseStyle: 'concise' };
  const calls = { answerCalls: true, collectCallerName: true, collectReason: true, offerSmsTransition: true, requireSmsConsent: true, voicemailFallback: false };
  const messages = { webEnabled: true, macosMessagesEnabled: false, notifyOwner: true, interruptOnlyWhenNeeded: true, includeSummary: true, includeSuggestedResponse: true };
  await pool.query(`INSERT INTO owner_configurations (owner_id, revision, assistant, calls, messages, onboarding) VALUES ('owner', 7, $1, $2, $3, '{"completed":true}')`,
    [assistant, calls, messages]);
  await pool.query(`INSERT INTO owner_configuration_revisions (owner_id, revision, assistant, calls, messages) VALUES ('owner', 7, $1, $2, $3)`, [assistant, calls, messages]);
  await pool.query(`INSERT INTO owner_configuration_audit VALUES ('owner', 7, 'assistant.settings.updated', 'web', NOW())`);
  await pool.query(`INSERT INTO conversations (id, provider, provider_call_id, caller_phone, status, started_at, owner_id)
    VALUES ('conv_legacy1', 'twilio', 'CA-legacy-1', '+15553334444', 'completed', NOW() - interval '1 day', 'owner')`);
  await pool.query(`INSERT INTO conversation_events VALUES ('evt_legacy1', 'conv_legacy1', 'call.received', '{}', NOW() - interval '1 day')`);
  await pool.query(`INSERT INTO owner_attention VALUES ('att_legacy1', 'owner', 'conv_legacy1', 'voicemail', 'passive', 'Jordan left a voicemail', '14 second message',
    '["open"]', 'delivered', 'voicemail:legacy', '{}', NOW(), NOW(), NULL)`);
  await pool.query(`INSERT INTO runtime_commands VALUES ('cmd_legacy1', 'conv_legacy1', 'owner', 'take_over', '{}', 'applied', NULL, NOW(), NOW(), NULL, 'rt_legacy1')`);
  await pool.query(`INSERT INTO owner_surface_devices VALUES ('dev_legacy1', 'owner', 'web', '{"endpoint":"https://web.push.apple.com/legacy","keys":{"p256dh":"k","auth":"a"}}',
    '["push","deep_link"]', 'iPhone', 'active', NOW(), NOW(), 'sess_legacy')`);
  await pool.query(`INSERT INTO owner_auth_sessions VALUES ('sess_legacy', 'owner', 'hash', 'web', 'Browser', NOW(), NOW(), NOW() + interval '30 days', NULL)`);
}

test('the single-owner deployment migrates deterministically into an ordinary account', {
  skip: databaseUrl ? false : 'set TEST_DATABASE_URL to run against Postgres',
}, async (t) => {
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const name = `legacy_${randomBytes(4).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  const pools: pg.Pool[] = [];
  const pool = () => { const created = new pg.Pool({ connectionString: url.toString(), max: 4 }); pools.push(created); return created; };
  const servers: Array<{ close(): void }> = [];
  t.after(async () => {
    servers.forEach((server) => server.close());
    await Promise.all(pools.map((item) => item.end().catch(() => undefined)));
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  });

  const legacy = pool();
  await seedLegacyDatabase(legacy);
  // The provider account holds the old assistant line; the platform will keep it for this account.
  const numbers = new FakePhoneNumberClient(['+15550000000'], false);
  const messaging = new FakeMessagingProvider();
  const platform = { phoneNumberClient: numbers, messagingProvider: messaging, publicBaseUrl: 'https://text-me.vercel.app' };
  const input = { email: 'randy@example.com', password: PASSWORD, name: 'Randy', personalNumber: '+15551112222' };

  const result = await migrateLegacyDeployment(pool(), platform, input);
  const ids = legacyIds('owner', 'randy@example.com');
  assert.deepEqual([result.accountId, result.userId, result.created], [ids.accountId, ids.userId, true]);
  assert.equal(result.onboarding, 'ready', 'the migrated account passes the same onboarding checks as a new customer');
  assert.deepEqual([result.assistantLine, result.personalNumber], ['+15550000000', '+15551112222']);
  for (const table of ['conversations', 'owner_configurations', 'owner_attention', 'runtime_commands', 'owner_surface_devices']) {
    assert.equal(result.moved[table], 1, `${table} re-owned`);
  }
  // Nothing is left owned by the old id, and the access-key sessions are gone.
  for (const table of ['conversations', 'owner_configurations', 'owner_attention', 'runtime_commands', 'owner_surface_devices', 'owner_configuration_audit']) {
    const left = await legacy.query(`SELECT count(*)::int AS n FROM ${table} WHERE account_id = 'owner'`);
    assert.equal(left.rows[0].n, 0, `${table} still has legacy rows`);
  }
  assert.equal((await legacy.query("SELECT to_regclass('owner_auth_sessions') AS t")).rows[0].t, null);
  assert.equal((await numbers.find('+15550000000'))!.voiceUrl, 'https://text-me.vercel.app/webhooks/twilio/voice');

  // Re-running is a no-op with the same result.
  const again = await migrateLegacyDeployment(pool(), platform, input);
  assert.deepEqual([again.accountId, again.userId, again.created, again.onboarding], [ids.accountId, ids.userId, false, 'ready']);
  assert.ok(Object.values(again.moved).every((count) => count === 0));

  // The deployment, with no customer in its environment, serves the migrated owner like anyone else.
  const env = { DATABASE_URL: url.toString(), TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', PUBLIC_BASE_URL: 'https://text-me.vercel.app', REALTIME_VOICE: 'off' };
  const built = buildServerWithPool(getConfig(env), pool(), {}, { phoneNumberClient: numbers, messagingProvider: messaging });
  servers.push(built.server);
  await built.ready;
  const app = built.app;
  const session = await signIn(app, 'randy@example.com');
  const me = (await request(app).get('/me').set(session.headers)).body;
  assert.deepEqual([me.user.id, me.account.id, me.account.role, me.onboarding.state], [ids.userId, ids.accountId, 'owner', 'ready']);
  const configuration = (await request(app).get('/owner/configuration').set(session.headers)).body;
  assert.deepEqual([configuration.assistant.greeting, configuration.assistant.tone, configuration.revision >= 7, configuration.messages.smsEnabled],
    ["Hi, Randy's phone, Ava here.", 'warm', true, true], 'the owner’s settings survive, and the SMS fallback they always had stays on');
  const [conversation] = (await request(app).get('/conversations').set(session.headers)).body;
  assert.equal(conversation.id, 'conv_legacy1');
  assert.equal((await request(app).get('/owner/attention').set(session.headers)).body[0].id, 'att_legacy1');
  assert.deepEqual((await request(app).get('/conversations/conv_legacy1/runtime/commands').set(session.headers)).body.map((command: { id: string }) => command.id), ['cmd_legacy1']);
  const devices = (await request(app).get('/owner/push/devices').set(session.headers)).body;
  assert.deepEqual(devices.map((device: { id: string; status: string }) => [device.id, device.status]), [['dev_legacy1', 'active']]);
  const phone = (await request(app).get('/owner/phone').set(session.headers)).body;
  assert.deepEqual([phone.assistantLine, phone.ownerNumber, phone.connected, phone.numbers.personal.verificationStatus],
    ['+15550000000', '+15551112222', true, 'migrated']);
  const plane = (await request(app).get('/owner/control-plane').set(session.headers)).body;
  assert.deepEqual([plane.plane.name, plane.plane.status, plane.owner.name], ['Ava', 'online', 'Randy']);

  // New calls to the old line land in the migrated account, through the line → account resolution.
  const call = await request(app).post('/webhooks/fake/voice').send({ callId: 'CA-after', callerPhone: '+15557778888', to: '+15550000000' });
  assert.equal(call.status, 200);
  assert.match(call.text, /Hi, Randy&apos;s phone, Ava here\./);
  assert.equal((await request(app).get('/conversations').set(session.headers)).body.length, 2);

  // A brand-new customer on the same deployment sees none of it.
  const newcomer = await signUp(app, { email: `new-${randomBytes(3).toString('hex')}@example.test` });
  assert.deepEqual((await request(app).get('/conversations').set(newcomer.headers)).body, []);
  assert.equal((await request(app).get('/conversations/conv_legacy1').set(newcomer.headers)).status, 404);
  assert.equal((await request(app).post('/account/phone/line').set(newcomer.headers)).body.code, 'no_numbers_available',
    'the migrated line is the account’s, not up for grabs');
});
