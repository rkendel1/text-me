import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

import type {
  OwnerConfiguration,
  OwnerConfigurationAuditEvent,
  OwnerConfigurationStore,
} from '../owner/configuration.js';
import type {
  OwnerDevice,
  OwnerDeviceSessionRecord,
  OwnerDeviceSessionStore,
  OwnerDeviceStore,
  OwnerPairingCredentialRecord,
  OwnerPairingCredentialStore,
} from '../owner/device.js';
import type {
  OwnerMessageDeliveryRecord,
  OwnerMessageDeliveryStore,
} from '../owner/delivery.js';
import type { MessagesChat } from '../owner/mac-messages-adapter.js';

interface OwnerDeviceRow {
  id: string;
  owner_id: string;
  type: OwnerDevice['type'];
  name: string;
  status: OwnerDevice['status'];
  setup_status: OwnerDevice['setupStatus'];
  health: OwnerDevice['health'];
  messages_identity: OwnerDevice['messagesIdentity'];
  is_primary: boolean;
  bridge_version: string | null;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

interface OwnerMessageChatRow {
  device_id: string;
  chat_id: string;
  service: MessagesChat['service'];
  display_name: string | null;
  address: string | null;
  is_group: boolean;
  is_authorized: boolean;
}

interface OwnerPairingRow {
  device_id: string;
  owner_id: string;
  credential: string;
  expires_at: Date;
}

interface OwnerSessionRow {
  token: string;
  device_id: string;
  owner_id: string;
  created_at: Date;
  last_seen_at: Date;
}

interface OwnerConfigurationRow {
  owner_id: string;
  revision: number;
  assistant: OwnerConfiguration['assistant'];
  calls: OwnerConfiguration['calls'];
  messages: OwnerConfiguration['messages'];
}

interface OwnerAuditRow {
  owner_id: string;
  revision: number;
  type: string;
  source: string;
  occurred_at: Date;
}

interface OwnerMessageDeliveryRow {
  id: string;
  owner_id: string;
  device_id: string;
  conversation_id: string;
  message_id: string;
  body: string;
  correlation_key: string;
  status: OwnerMessageDeliveryRecord['status'];
  provider_request_id: string | null;
  observed_external_id: string | null;
  replied_external_id: string | null;
  created_at: Date;
  updated_at: Date;
  observed_at: Date | null;
  replied_at: Date | null;
  failed_at: Date | null;
  error: string | null;
}

function hydrateDevice(row: OwnerDeviceRow, chats: OwnerMessageChatRow[]): OwnerDevice {
  const discoveredChats = chats.map((chat) => ({
    id: chat.chat_id,
    service: chat.service,
    displayName: chat.display_name ?? undefined,
    address: chat.address ?? undefined,
    isGroup: chat.is_group,
  }));
  const authorizedChat = chats.find((chat) => chat.is_authorized);
  return {
    id: row.id,
    ownerId: row.owner_id,
    type: row.type,
    name: row.name,
    status: row.status,
    setupStatus: row.setup_status,
    health: row.health,
    messagesIdentity: row.messages_identity,
    assistantChat: authorizedChat ? {
      deviceId: row.id,
      chatId: authorizedChat.chat_id,
      service: authorizedChat.service,
      address: authorizedChat.address ?? undefined,
      displayName: authorizedChat.display_name ?? undefined,
    } : null,
    discoveredChats,
    isPrimary: row.is_primary,
    bridgeVersion: row.bridge_version ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

function hydrateDelivery(row: OwnerMessageDeliveryRow): OwnerMessageDeliveryRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    deviceId: row.device_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    body: row.body,
    correlationKey: row.correlation_key,
    status: row.status,
    providerRequestId: row.provider_request_id ?? undefined,
    observedExternalId: row.observed_external_id ?? undefined,
    repliedExternalId: row.replied_external_id ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    observedAt: row.observed_at ? new Date(row.observed_at) : undefined,
    repliedAt: row.replied_at ? new Date(row.replied_at) : undefined,
    failedAt: row.failed_at ? new Date(row.failed_at) : undefined,
    error: row.error ?? undefined,
  };
}

export class PostgresOwnerDeviceStore implements OwnerDeviceStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS owner_devices (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        setup_status TEXT NOT NULL,
        health JSONB NOT NULL,
        messages_identity JSONB,
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        bridge_version TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS owner_messages_chats (
        device_id TEXT NOT NULL REFERENCES owner_devices(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        service TEXT NOT NULL,
        display_name TEXT,
        address TEXT,
        is_group BOOLEAN NOT NULL DEFAULT FALSE,
        is_authorized BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (device_id, chat_id, service)
      )
    `);
  }

  async save(device: OwnerDevice): Promise<void> {
    await this.pool.query('BEGIN');
    try {
      await this.pool.query(
        `
          INSERT INTO owner_devices (
            id, owner_id, type, name, status, setup_status, health,
            messages_identity, is_primary, bridge_version,
            created_at, updated_at, last_seen_at, revoked_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10,
            $11, $12, $13, $14
          )
          ON CONFLICT (id) DO UPDATE SET
            owner_id = EXCLUDED.owner_id,
            type = EXCLUDED.type,
            name = EXCLUDED.name,
            status = EXCLUDED.status,
            setup_status = EXCLUDED.setup_status,
            health = EXCLUDED.health,
            messages_identity = EXCLUDED.messages_identity,
            is_primary = EXCLUDED.is_primary,
            bridge_version = EXCLUDED.bridge_version,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            last_seen_at = EXCLUDED.last_seen_at,
            revoked_at = EXCLUDED.revoked_at
        `,
        [
          device.id,
          device.ownerId,
          device.type,
          device.name,
          device.status,
          device.setupStatus,
          JSON.stringify(device.health),
          device.messagesIdentity ? JSON.stringify(device.messagesIdentity) : null,
          device.isPrimary,
          device.bridgeVersion ?? null,
          device.createdAt,
          device.updatedAt,
          device.lastSeenAt,
          device.revokedAt,
        ],
      );
      await this.pool.query('DELETE FROM owner_messages_chats WHERE device_id = $1', [device.id]);
      for (const chat of device.discoveredChats) {
        const isAuthorized = device.assistantChat?.chatId === chat.id && device.assistantChat.service === chat.service;
        await this.pool.query(
          `
            INSERT INTO owner_messages_chats (
              device_id, chat_id, service, display_name, address, is_group, is_authorized
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [
            device.id,
            chat.id,
            chat.service,
            chat.displayName ?? null,
            chat.address ?? null,
            chat.isGroup ?? false,
            isAuthorized,
          ],
        );
      }
      if (device.assistantChat && !device.discoveredChats.some((chat) =>
        chat.id === device.assistantChat!.chatId && chat.service === device.assistantChat!.service,
      )) {
        await this.pool.query(
          `
            INSERT INTO owner_messages_chats (
              device_id, chat_id, service, display_name, address, is_group, is_authorized
            ) VALUES ($1, $2, $3, $4, $5, FALSE, TRUE)
          `,
          [
            device.id,
            device.assistantChat.chatId,
            device.assistantChat.service,
            device.assistantChat.displayName ?? null,
            device.assistantChat.address ?? null,
          ],
        );
      }
      await this.pool.query('COMMIT');
    } catch (error) {
      await this.pool.query('ROLLBACK');
      throw error;
    }
  }

  async get(id: string): Promise<OwnerDevice | null> {
    const deviceResult = await this.pool.query<OwnerDeviceRow>('SELECT * FROM owner_devices WHERE id = $1', [id]);
    const row = deviceResult.rows[0];
    if (!row) return null;
    const chatsResult = await this.pool.query<OwnerMessageChatRow>(
      'SELECT * FROM owner_messages_chats WHERE device_id = $1 ORDER BY chat_id ASC',
      [id],
    );
    return hydrateDevice(row, chatsResult.rows);
  }

  async list(ownerId: string): Promise<OwnerDevice[]> {
    const deviceResult = await this.pool.query<OwnerDeviceRow>(
      'SELECT * FROM owner_devices WHERE owner_id = $1 ORDER BY created_at ASC',
      [ownerId],
    );
    const chatResult = await this.pool.query<OwnerMessageChatRow>(
      `SELECT chats.*
         FROM owner_messages_chats chats
         JOIN owner_devices devices ON devices.id = chats.device_id
        WHERE devices.owner_id = $1`,
      [ownerId],
    );
    return deviceResult.rows.map((row) => hydrateDevice(row, chatResult.rows.filter((chat) => chat.device_id === row.id)));
  }
}

export class PostgresOwnerPairingCredentialStore implements OwnerPairingCredentialStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS owner_pairing_credentials (
        device_id TEXT PRIMARY KEY REFERENCES owner_devices(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        credential TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async save(record: OwnerPairingCredentialRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO owner_pairing_credentials (device_id, owner_id, credential, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (device_id) DO UPDATE SET
          owner_id = EXCLUDED.owner_id,
          credential = EXCLUDED.credential,
          expires_at = EXCLUDED.expires_at
      `,
      [record.deviceId, record.ownerId, record.code, new Date(record.expiresAt)],
    );
  }

  async getByDeviceId(deviceId: string): Promise<OwnerPairingCredentialRecord | null> {
    const result = await this.pool.query<OwnerPairingRow>(
      'SELECT device_id, owner_id, credential, expires_at FROM owner_pairing_credentials WHERE device_id = $1',
      [deviceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { deviceId: row.device_id, ownerId: row.owner_id, code: row.credential, expiresAt: new Date(row.expires_at).getTime() };
  }

  async getByCode(code: string): Promise<OwnerPairingCredentialRecord | null> {
    const result = await this.pool.query<OwnerPairingRow>(
      'SELECT device_id, owner_id, credential, expires_at FROM owner_pairing_credentials WHERE credential = $1',
      [code],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { deviceId: row.device_id, ownerId: row.owner_id, code: row.credential, expiresAt: new Date(row.expires_at).getTime() };
  }

  async delete(deviceId: string): Promise<void> {
    await this.pool.query('DELETE FROM owner_pairing_credentials WHERE device_id = $1', [deviceId]);
  }
}

export class PostgresOwnerDeviceSessionStore implements OwnerDeviceSessionStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS owner_device_sessions (
        token TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES owner_devices(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL
      )
    `);
  }

  async save(record: OwnerDeviceSessionRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO owner_device_sessions (token, device_id, owner_id, created_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (token) DO UPDATE SET
          device_id = EXCLUDED.device_id,
          owner_id = EXCLUDED.owner_id,
          created_at = EXCLUDED.created_at,
          last_seen_at = EXCLUDED.last_seen_at
      `,
      [record.token, record.deviceId, record.ownerId, new Date(record.createdAt), new Date(record.lastSeenAt)],
    );
  }

  async get(token: string): Promise<OwnerDeviceSessionRecord | null> {
    const result = await this.pool.query<OwnerSessionRow>('SELECT * FROM owner_device_sessions WHERE token = $1', [token]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      token: row.token,
      deviceId: row.device_id,
      ownerId: row.owner_id,
      createdAt: new Date(row.created_at).getTime(),
      lastSeenAt: new Date(row.last_seen_at).getTime(),
    };
  }

  async delete(token: string): Promise<void> {
    await this.pool.query('DELETE FROM owner_device_sessions WHERE token = $1', [token]);
  }

  async deleteByDeviceId(deviceId: string): Promise<void> {
    await this.pool.query('DELETE FROM owner_device_sessions WHERE device_id = $1', [deviceId]);
  }

  async touch(token: string, lastSeenAt: number): Promise<void> {
    await this.pool.query('UPDATE owner_device_sessions SET last_seen_at = $2 WHERE token = $1', [token, new Date(lastSeenAt)]);
  }
}

export class PostgresOwnerConfigurationStore implements OwnerConfigurationStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS owner_configurations (
        owner_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        assistant JSONB NOT NULL,
        calls JSONB NOT NULL,
        messages JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS owner_configuration_revisions (
        owner_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        assistant JSONB NOT NULL,
        calls JSONB NOT NULL,
        messages JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (owner_id, revision)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS owner_configuration_audit (
        owner_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL
      )
    `);
  }

  async get(ownerId: string): Promise<OwnerConfiguration | null> {
    const result = await this.pool.query<OwnerConfigurationRow>(
      'SELECT owner_id, revision, assistant, calls, messages FROM owner_configurations WHERE owner_id = $1',
      [ownerId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ownerId: row.owner_id,
      revision: row.revision,
      assistant: row.assistant,
      calls: row.calls,
      messages: row.messages,
    };
  }

  async create(configuration: OwnerConfiguration, event: OwnerConfigurationAuditEvent): Promise<void> {
    await this.pool.query('BEGIN');
    try {
      await this.pool.query(
        `
          INSERT INTO owner_configurations (owner_id, revision, assistant, calls, messages, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (owner_id) DO NOTHING
        `,
        [
          configuration.ownerId,
          configuration.revision,
          JSON.stringify(configuration.assistant),
          JSON.stringify(configuration.calls),
          JSON.stringify(configuration.messages),
        ],
      );
      await this.pool.query(
        `
          INSERT INTO owner_configuration_revisions (owner_id, revision, assistant, calls, messages)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (owner_id, revision) DO NOTHING
        `,
        [
          configuration.ownerId,
          configuration.revision,
          JSON.stringify(configuration.assistant),
          JSON.stringify(configuration.calls),
          JSON.stringify(configuration.messages),
        ],
      );
      await this.pool.query(
        'INSERT INTO owner_configuration_audit (owner_id, revision, type, source, occurred_at) VALUES ($1, $2, $3, $4, $5)',
        [event.ownerId, event.revision, event.type, event.source, event.occurredAt],
      );
      await this.pool.query('COMMIT');
    } catch (error) {
      await this.pool.query('ROLLBACK');
      throw error;
    }
  }

  async update(configuration: OwnerConfiguration, previousRevision: number, event: OwnerConfigurationAuditEvent): Promise<void> {
    await this.pool.query('BEGIN');
    try {
      const current = await this.pool.query(
        `
          UPDATE owner_configurations
             SET revision = $2,
                 assistant = $3,
                 calls = $4,
                 messages = $5,
                 updated_at = NOW()
           WHERE owner_id = $1 AND revision = $6
        `,
        [
          configuration.ownerId,
          configuration.revision,
          JSON.stringify(configuration.assistant),
          JSON.stringify(configuration.calls),
          JSON.stringify(configuration.messages),
          previousRevision,
        ],
      );
      if (current.rowCount !== 1) {
        throw new Error('Owner configuration update conflict');
      }
      await this.pool.query(
        `
          INSERT INTO owner_configuration_revisions (owner_id, revision, assistant, calls, messages)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [
          configuration.ownerId,
          configuration.revision,
          JSON.stringify(configuration.assistant),
          JSON.stringify(configuration.calls),
          JSON.stringify(configuration.messages),
        ],
      );
      await this.pool.query(
        'INSERT INTO owner_configuration_audit (owner_id, revision, type, source, occurred_at) VALUES ($1, $2, $3, $4, $5)',
        [event.ownerId, event.revision, event.type, event.source, event.occurredAt],
      );
      await this.pool.query('COMMIT');
    } catch (error) {
      await this.pool.query('ROLLBACK');
      throw error;
    }
  }

  async events(ownerId: string): Promise<OwnerConfigurationAuditEvent[]> {
    const result = await this.pool.query<OwnerAuditRow>(
      'SELECT owner_id, revision, type, source, occurred_at FROM owner_configuration_audit WHERE owner_id = $1 ORDER BY revision ASC, occurred_at ASC',
      [ownerId],
    );
    return result.rows.map((row) => ({
      ownerId: row.owner_id,
      revision: row.revision,
      type: row.type,
      source: row.source,
      occurredAt: new Date(row.occurred_at),
    }));
  }
}

export class PostgresOwnerMessageDeliveryStore implements OwnerMessageDeliveryStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS owner_message_deliveries (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        device_id TEXT NOT NULL REFERENCES owner_devices(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        body TEXT NOT NULL,
        correlation_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        provider_request_id TEXT,
        observed_external_id TEXT,
        replied_external_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        observed_at TIMESTAMPTZ,
        replied_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        error TEXT
      )
    `);
  }

  async create(input: Omit<OwnerMessageDeliveryRecord, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'correlationKey'> & {
    correlationKey?: string;
  }): Promise<OwnerMessageDeliveryRecord> {
    const record = await this.pool.query<OwnerMessageDeliveryRow>(
      `
        INSERT INTO owner_message_deliveries (
          id, owner_id, device_id, conversation_id, message_id, body,
          correlation_key, status, provider_request_id, observed_external_id,
          replied_external_id, created_at, updated_at, observed_at, replied_at, failed_at, error
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, 'pending', $8, $9,
          $10, NOW(), NOW(), $11, $12, $13, $14
        )
        RETURNING *
      `,
      [
        randomUUID(),
        input.ownerId,
        input.deviceId,
        input.conversationId,
        input.messageId,
        input.body,
        input.correlationKey ?? randomUUID(),
        input.providerRequestId ?? null,
        input.observedExternalId ?? null,
        input.repliedExternalId ?? null,
        input.observedAt ?? null,
        input.repliedAt ?? null,
        input.failedAt ?? null,
        input.error ?? null,
      ],
    );
    return hydrateDelivery(record.rows[0]);
  }

  async listPending(deviceId: string): Promise<OwnerMessageDeliveryRecord[]> {
    const result = await this.pool.query<OwnerMessageDeliveryRow>(
      `SELECT * FROM owner_message_deliveries
        WHERE device_id = $1 AND status = 'pending'
        ORDER BY created_at ASC`,
      [deviceId],
    );
    return result.rows.map(hydrateDelivery);
  }

  async markSent(deviceId: string, deliveryId: string, providerRequestId: string): Promise<OwnerMessageDeliveryRecord | null> {
    const result = await this.pool.query<OwnerMessageDeliveryRow>(
      `
        UPDATE owner_message_deliveries
           SET status = 'sent', provider_request_id = $3, updated_at = NOW()
         WHERE id = $1 AND device_id = $2
         RETURNING *
      `,
      [deliveryId, deviceId, providerRequestId],
    );
    return result.rows[0] ? hydrateDelivery(result.rows[0]) : null;
  }

  async markObserved(deviceId: string, deliveryId: string, observedExternalId: string): Promise<OwnerMessageDeliveryRecord | null> {
    const result = await this.pool.query<OwnerMessageDeliveryRow>(
      `
        UPDATE owner_message_deliveries
           SET status = 'observed', observed_external_id = $3, observed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND device_id = $2
         RETURNING *
      `,
      [deliveryId, deviceId, observedExternalId],
    );
    return result.rows[0] ? hydrateDelivery(result.rows[0]) : null;
  }

  async markFailed(deviceId: string, deliveryId: string, error: string): Promise<OwnerMessageDeliveryRecord | null> {
    const result = await this.pool.query<OwnerMessageDeliveryRow>(
      `
        UPDATE owner_message_deliveries
           SET status = 'failed', error = $3, failed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND device_id = $2
         RETURNING *
      `,
      [deliveryId, deviceId, error],
    );
    return result.rows[0] ? hydrateDelivery(result.rows[0]) : null;
  }

  async claimReplyTarget(deviceId: string, externalId: string, deliveryId?: string): Promise<OwnerMessageDeliveryRecord | null> {
    const result = await this.pool.query<OwnerMessageDeliveryRow>(
      `
        WITH target AS (
          SELECT id
            FROM owner_message_deliveries
           WHERE device_id = $1
             AND status IN ('sent', 'observed')
             AND ($3::text IS NULL OR id = $3)
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
        UPDATE owner_message_deliveries deliveries
           SET status = 'replied', replied_external_id = $2, replied_at = NOW(), updated_at = NOW()
          FROM target
         WHERE deliveries.id = target.id
         RETURNING deliveries.*
      `,
      [deviceId, externalId, deliveryId ?? null],
    );
    return result.rows[0] ? hydrateDelivery(result.rows[0]) : null;
  }
}
