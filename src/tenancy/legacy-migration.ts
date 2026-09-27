import { createHash } from 'node:crypto';

import type { Pool } from 'pg';

import { createStores } from '../bootstrap.js';
import type { MessagingProvider } from '../messaging/provider.js';
import { OwnerConfigurationService } from '../owner/configuration.js';
import { OwnerDeviceService } from '../owner/device.js';
import { PhoneNumberService, type PhoneNumberClient } from '../telephony/phone-number.js';
import { NotificationChannelResolver } from './channels.js';
import { DEFAULT_ENTITLEMENTS, E164, isValidEmail, normalizeEmail, type OnboardingState } from './model.js';
import { hashPassword, passwordProblem } from './passwords.js';
import { TenancyService } from './service.js';

/**
 * Tables whose tenant column held the single owner's id (OWNER_ID, 'owner' by
 * default). Children of these (conversation events, runtime state, overrides,
 * chats) are owned through their parent's foreign key.
 */
export const LEGACY_TENANT_TABLES = [
  'conversations',
  'owner_devices',
  'owner_pairing_credentials',
  'owner_device_sessions',
  'owner_configurations',
  'owner_configuration_revisions',
  'owner_configuration_audit',
  'owner_message_deliveries',
  'runtime_commands',
  'owner_attention',
  'notification_deliveries',
  'owner_surface_devices',
] as const;

export interface LegacyMigrationInput {
  /** The old OWNER_ID value stored on every row ('owner' unless it was changed). */
  legacyOwnerId?: string;
  /** The owner's sign-in email and password (there was no user before; the access key is retired). */
  email: string;
  password: string;
  name: string;
  accountName?: string;
  /** The old OWNER_PHONE_NUMBER: the owner's real mobile. */
  personalNumber?: string;
  /** The old TWILIO_PHONE_NUMBER; if omitted, the provider account's only number. */
  assistantLine?: string;
}

export interface LegacyMigrationResult {
  accountId: string;
  userId: string;
  created: boolean;
  moved: Record<string, number>;
  assistantLine: string | null;
  personalNumber: string | null;
  onboarding: OnboardingState;
}

/** Same input → same ids, so the migration can be re-run safely and its output is predictable. */
export function legacyIds(legacyOwnerId: string, email: string) {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
  return {
    accountId: `acct_${digest(`legacy-account:${legacyOwnerId}`)}`,
    userId: `usr_${digest(`legacy-user:${normalizeEmail(email)}`)}`,
    membershipId: `mem_${digest(`legacy-membership:${legacyOwnerId}:${normalizeEmail(email)}`)}`,
  };
}

/**
 * Turns the single-user deployment's owner into an ordinary account:
 *
 *   Account (deterministic id) ─ Membership(owner) ─ User(email, password)
 *   PhoneNumber: the existing assistant line + the owner's real number
 *   Devices, planes, notifications, conversations, commands: re-owned by the account
 *
 * Then the account is verified through the same onboarding evaluation every
 * new customer goes through. Afterwards nothing reads the old environment
 * variables; the deployment refuses to start while they are still set.
 */
export async function migrateLegacyDeployment(
  pool: Pool,
  platform: { phoneNumberClient: PhoneNumberClient; messagingProvider?: MessagingProvider; publicBaseUrl: string; databaseListenUrl?: string },
  input: LegacyMigrationInput,
): Promise<LegacyMigrationResult> {
  const legacyOwnerId = input.legacyOwnerId?.trim() || 'owner';
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new Error('A valid --email is required');
  const problem = passwordProblem(input.password);
  if (problem) throw new Error(problem);
  if (!input.name.trim()) throw new Error('--name is required');
  if (input.personalNumber && !E164.test(input.personalNumber)) throw new Error('--personal-number must be E.164, e.g. +15551112222');
  if (input.assistantLine && !E164.test(input.assistantLine)) throw new Error('--assistant-line must be E.164');

  const stores = createStores(pool, { databaseListenUrl: platform.databaseListenUrl ?? '' });
  await stores.initialize();
  const { tenancyStore } = stores;
  const ids = legacyIds(legacyOwnerId, email);

  // 1. The user and the account (idempotent: a re-run finds them).
  const existingUser = await tenancyStore.findUserByEmail(email);
  if (existingUser && existingUser.user.id !== ids.userId) {
    throw new Error(`${email} already belongs to another user; pick the email the legacy owner should sign in with`);
  }
  const now = new Date();
  if (!existingUser) {
    await tenancyStore.createUser({ id: ids.userId, name: input.name.trim(), email, createdAt: now, updatedAt: now }, await hashPassword(input.password));
  }
  const created = !(await tenancyStore.getAccount(ids.accountId));
  if (created) {
    await tenancyStore.createAccount({
      account: { id: ids.accountId, name: (input.accountName ?? input.name).trim(), onboardingState: 'account_created', createdAt: now, updatedAt: now },
      membership: { id: ids.membershipId, accountId: ids.accountId, userId: ids.userId, role: 'owner', createdAt: now },
      subscription: { accountId: ids.accountId, plan: 'just-text-me', status: 'active', entitlements: DEFAULT_ENTITLEMENTS, createdAt: now, updatedAt: now },
      providerConfiguration: { accountId: ids.accountId, telephonyProvider: 'twilio', messagingProvider: 'twilio', settings: { migratedFrom: 'single_owner' }, updatedAt: now },
    });
  }

  // 2. Every row the single owner owned now belongs to the account. One transaction: all or nothing.
  const moved: Record<string, number> = {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of LEGACY_TENANT_TABLES) {
      const orphans = table === 'conversations' ? ' OR account_id IS NULL' : '';
      // A configuration row is keyed by account; if the account already has one (a re-run), keep it.
      const guard = table === 'owner_configurations'
        ? ' AND NOT EXISTS (SELECT 1 FROM owner_configurations WHERE account_id = $1)'
        : table === 'owner_configuration_revisions'
          ? ' AND NOT EXISTS (SELECT 1 FROM owner_configuration_revisions r WHERE r.account_id = $1 AND r.revision = owner_configuration_revisions.revision)'
          : '';
      const result = await client.query(`UPDATE ${table} SET account_id = $1 WHERE (account_id = $2${orphans})${guard}`, [ids.accountId, legacyOwnerId]);
      moved[table] = result.rowCount ?? 0;
    }
    await client.query('UPDATE owner_surface_devices SET user_id = $2 WHERE account_id = $1 AND user_id IS NULL', [ids.accountId, ids.userId]);
    await client.query('UPDATE owner_devices SET user_id = $2 WHERE account_id = $1 AND user_id IS NULL', [ids.accountId, ids.userId]);
    // Access-key sessions have no user behind them; every device signs in again as the user.
    await client.query('DROP TABLE IF EXISTS owner_auth_sessions');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // 3. The same machinery a new customer goes through.
  const configuration = new OwnerConfigurationService(stores.ownerConfigurations);
  const phoneNumbers = new PhoneNumberService(tenancyStore, platform.phoneNumberClient, platform.publicBaseUrl, platform.messagingProvider);
  const devices = new OwnerDeviceService(stores.ownerDeviceStore, Date.now, stores.ownerPairings, stores.ownerSessions);
  const channels = new NotificationChannelResolver({
    surfaceDevices: stores.surfaceDevices, macDevices: devices, configuration,
    personalNumber: (accountId) => phoneNumbers.personalNumber(accountId), nativePush: true, messaging: true,
  });
  const tenancy = new TenancyService(tenancyStore, { configuration, phoneNumbers, channels });
  const context = { userId: ids.userId, accountId: ids.accountId, role: 'owner' as const, sessionId: 'legacy-migration' };

  const settings = await configuration.get(ids.accountId);
  if (!settings.assistant.ownerName.trim()) await tenancy.configureIdentity(context, { name: input.name });

  let assistantLine: string | null = await phoneNumbers.assistantLine(ids.accountId);
  if (!assistantLine) {
    let number = input.assistantLine;
    if (!number) {
      const held = await platform.phoneNumberClient.list();
      if (held.length !== 1) throw new Error(`The provider account holds ${held.length} numbers; pass --assistant-line with the old TWILIO_PHONE_NUMBER`);
      number = held[0].phoneNumber;
    }
    assistantLine = (await phoneNumbers.adoptAssistantLine(ids.accountId, number)).number;
  }
  let personalNumber: string | null = await phoneNumbers.personalNumber(ids.accountId);
  if (!personalNumber && input.personalNumber) {
    personalNumber = (await phoneNumbers.attestPersonalNumber(ids.accountId, input.personalNumber)).number;
    // The single-owner deployment always texted the owner's number as a fallback; keep that.
    await configuration.update(ids.accountId, { messages: { smsEnabled: true } }, 'legacy_migration');
  }
  if (!(await tenancyStore.getPlane(ids.accountId))) {
    await tenancy.configurePlane(context, { name: (await configuration.get(ids.accountId)).assistant.assistantName });
  }
  const onboarding = await tenancy.refreshOnboarding(ids.accountId);
  if (created) await tenancy.audit(ids.accountId, 'account.migrated_from_single_owner', { legacyOwnerId, moved }, ids.userId);
  return { accountId: ids.accountId, userId: ids.userId, created, moved, assistantLine, personalNumber, onboarding: onboarding.state };
}
