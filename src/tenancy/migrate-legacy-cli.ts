/**
 * One-time migration of a single-owner deployment into the multi-tenant model.
 *
 *   DATABASE_URL=… TWILIO_ACCOUNT_SID=… TWILIO_AUTH_TOKEN=… PUBLIC_BASE_URL=https://<project>.vercel.app \
 *   MIGRATION_OWNER_PASSWORD='…' npm run migrate:legacy -- \
 *     --email you@example.com --name "Randy" --personal-number +15551112222 [--assistant-line +15550000000] [--legacy-owner-id owner]
 *
 * The flags carry what used to live in OWNER_PHONE_NUMBER, TWILIO_PHONE_NUMBER
 * and OWNER_ID, exactly once, into the database. Afterwards delete those
 * variables: the deployment refuses to start while any of them is set.
 */
import { parseArgs } from 'node:util';

import { Pool } from 'pg';

import { resolvePublicBaseUrl } from '../config.js';
import { TwilioMessagingProvider } from '../messaging/twilio-provider.js';
import { TwilioPhoneNumberClient } from '../telephony/phone-number.js';
import { migrateLegacyDeployment } from './legacy-migration.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    'account-name': { type: 'string' },
    'personal-number': { type: 'string' },
    'assistant-line': { type: 'string' },
    'legacy-owner-id': { type: 'string' },
  },
});

const required = (key: string) => {
  const value = process.env[key]?.trim();
  if (!value) {
    console.error(`${key} is required`);
    process.exit(2);
  }
  return value;
};

const password = process.env.MIGRATION_OWNER_PASSWORD ?? '';
if (!values.email || !values.name || !password) {
  console.error('Usage: MIGRATION_OWNER_PASSWORD=… npm run migrate:legacy -- --email <email> --name <name> [--personal-number +1…] [--assistant-line +1…] [--legacy-owner-id owner]');
  process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED || required('DATABASE_URL'), max: 2 });
try {
  const sid = required('TWILIO_ACCOUNT_SID');
  const token = required('TWILIO_AUTH_TOKEN');
  const result = await migrateLegacyDeployment(pool, {
    phoneNumberClient: new TwilioPhoneNumberClient(sid, token),
    messagingProvider: new TwilioMessagingProvider(sid, token),
    publicBaseUrl: resolvePublicBaseUrl(process.env),
  }, {
    email: values.email,
    name: values.name,
    password,
    accountName: values['account-name'],
    personalNumber: values['personal-number'],
    assistantLine: values['assistant-line'],
    legacyOwnerId: values['legacy-owner-id'],
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.onboarding !== 'ready') {
    console.warn(`The account migrated but its setup is at "${result.onboarding}"; the owner will finish it on first sign-in.`);
  }
  console.log('Done. Now remove OWNER_PHONE_NUMBER, OWNER_AUTH_TOKEN, OWNER_ID and TWILIO_PHONE_NUMBER from the deployment and redeploy.');
} finally {
  await pool.end();
}
