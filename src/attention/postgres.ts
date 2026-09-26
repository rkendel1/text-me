import type { Pool } from 'pg';

import type { NotificationDelivery, OwnerAttention, OwnerSurfaceDevice } from './model.js';
import type {
  AppSecretStore,
  NotificationDeliveryStore,
  OwnerAttentionStore,
  OwnerSurfaceDeviceStore,
} from './stores.js';

interface AttentionRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  type: OwnerAttention['type'];
  priority: OwnerAttention['priority'];
  title: string;
  body: string;
  actions: OwnerAttention['actions'];
  status: OwnerAttention['status'];
  dedupe_key: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
}

const toAttention = (row: AttentionRow): OwnerAttention => ({
  id: row.id,
  ownerId: row.owner_id,
  conversationId: row.conversation_id,
  type: row.type,
  priority: row.priority,
  title: row.title,
  body: row.body,
  actions: row.actions,
  status: row.status,
  dedupeKey: row.dedupe_key,
  metadata: row.metadata,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
});

export class PostgresOwnerAttentionStore implements OwnerAttentionStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS owner_attention (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        actions JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        resolved_at TIMESTAMPTZ,
        UNIQUE (owner_id, dedupe_key)
      )
    `);
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_owner_attention_owner ON owner_attention (owner_id, created_at DESC)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_owner_attention_conversation ON owner_attention (conversation_id)');
  }

  async create(attention: OwnerAttention): Promise<OwnerAttention> {
    await this.pool.query(
      `
        INSERT INTO owner_attention (id, owner_id, conversation_id, type, priority, title, body, actions, status, dedupe_key, metadata, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (owner_id, dedupe_key) DO NOTHING
      `,
      [attention.id, attention.ownerId, attention.conversationId, attention.type, attention.priority, attention.title,
        attention.body, JSON.stringify(attention.actions), attention.status, attention.dedupeKey, attention.metadata,
        attention.createdAt, attention.updatedAt],
    );
    const result = await this.pool.query<AttentionRow>(
      'SELECT * FROM owner_attention WHERE owner_id = $1 AND dedupe_key = $2',
      [attention.ownerId, attention.dedupeKey],
    );
    return toAttention(result.rows[0]);
  }

  async get(id: string): Promise<OwnerAttention | null> {
    const result = await this.pool.query<AttentionRow>('SELECT * FROM owner_attention WHERE id = $1', [id]);
    return result.rows[0] ? toAttention(result.rows[0]) : null;
  }

  async update(id: string, patch: Parameters<OwnerAttentionStore['update']>[1]): Promise<void> {
    await this.pool.query(
      `
        UPDATE owner_attention
           SET status = $2,
               resolved_at = COALESCE($3, resolved_at),
               metadata = metadata || $4::jsonb,
               updated_at = NOW()
         WHERE id = $1
      `,
      [id, patch.status, patch.resolvedAt ?? null, JSON.stringify(patch.metadata ?? {})],
    );
  }

  async list(ownerId: string, options: Parameters<OwnerAttentionStore['list']>[1] = {}): Promise<OwnerAttention[]> {
    const result = await this.pool.query<AttentionRow>(
      `
        SELECT * FROM owner_attention
         WHERE owner_id = $1
           AND ($2::text IS NULL OR conversation_id = $2)
           AND (NOT $3 OR status IN ('pending', 'delivered', 'opened'))
         ORDER BY created_at DESC
         LIMIT $4
      `,
      [ownerId, options.conversationId ?? null, options.open ?? false, options.limit ?? 100],
    );
    return result.rows.map(toAttention);
  }
}

interface DeliveryRow {
  id: string;
  attention_id: string;
  owner_id: string;
  surface: NotificationDelivery['surface'];
  device_id: string | null;
  status: NotificationDelivery['status'];
  error: string | null;
  provider_id: string | null;
  created_at: Date;
}

const toDelivery = (row: DeliveryRow): NotificationDelivery => ({
  id: row.id,
  attentionId: row.attention_id,
  ownerId: row.owner_id,
  surface: row.surface,
  status: row.status,
  createdAt: row.created_at,
  ...(row.device_id ? { deviceId: row.device_id } : {}),
  ...(row.error ? { error: row.error } : {}),
  ...(row.provider_id ? { providerId: row.provider_id } : {}),
});

export class PostgresNotificationDeliveryStore implements NotificationDeliveryStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id TEXT PRIMARY KEY,
        attention_id TEXT NOT NULL REFERENCES owner_attention(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        surface TEXT NOT NULL,
        device_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        provider_id TEXT,
        created_at TIMESTAMPTZ NOT NULL
      )
    `);
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_notification_deliveries_attention ON notification_deliveries (attention_id)');
  }

  async record(delivery: NotificationDelivery): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO notification_deliveries (id, attention_id, owner_id, surface, device_id, status, error, provider_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING
      `,
      [delivery.id, delivery.attentionId, delivery.ownerId, delivery.surface, delivery.deviceId ?? null, delivery.status,
        delivery.error ?? null, delivery.providerId ?? null, delivery.createdAt],
    );
  }

  async list(attentionId: string): Promise<NotificationDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      'SELECT * FROM notification_deliveries WHERE attention_id = $1 ORDER BY created_at ASC',
      [attentionId],
    );
    return result.rows.map(toDelivery);
  }

  async listForConversation(conversationId: string): Promise<NotificationDelivery[]> {
    const result = await this.pool.query<DeliveryRow>(
      `
        SELECT d.* FROM notification_deliveries d
          JOIN owner_attention a ON a.id = d.attention_id
         WHERE a.conversation_id = $1
         ORDER BY d.created_at ASC
      `,
      [conversationId],
    );
    return result.rows.map(toDelivery);
  }
}

interface SurfaceDeviceRow {
  id: string;
  owner_id: string;
  platform: OwnerSurfaceDevice['platform'];
  device_token: string;
  capabilities: OwnerSurfaceDevice['capabilities'];
  label: string | null;
  status: OwnerSurfaceDevice['status'];
  created_at: Date;
  last_seen_at: Date;
}

const toSurfaceDevice = (row: SurfaceDeviceRow): OwnerSurfaceDevice => ({
  id: row.id,
  ownerId: row.owner_id,
  platform: row.platform,
  deviceToken: row.device_token,
  capabilities: row.capabilities,
  status: row.status,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  ...(row.label ? { label: row.label } : {}),
});

export class PostgresOwnerSurfaceDeviceStore implements OwnerSurfaceDeviceStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS owner_surface_devices (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        device_token TEXT NOT NULL,
        capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
        label TEXT,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        UNIQUE (owner_id, device_token)
      )
    `);
  }

  async upsert(device: OwnerSurfaceDevice): Promise<OwnerSurfaceDevice> {
    const result = await this.pool.query<SurfaceDeviceRow>(
      `
        INSERT INTO owner_surface_devices (id, owner_id, platform, device_token, capabilities, label, status, created_at, last_seen_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
        ON CONFLICT (owner_id, device_token) DO UPDATE
          SET capabilities = EXCLUDED.capabilities,
              label = COALESCE(EXCLUDED.label, owner_surface_devices.label),
              status = 'active',
              last_seen_at = EXCLUDED.last_seen_at
        RETURNING *
      `,
      [device.id, device.ownerId, device.platform, device.deviceToken, JSON.stringify(device.capabilities),
        device.label ?? null, device.createdAt, device.lastSeenAt],
    );
    return toSurfaceDevice(result.rows[0]);
  }

  async list(ownerId: string): Promise<OwnerSurfaceDevice[]> {
    const result = await this.pool.query<SurfaceDeviceRow>(
      'SELECT * FROM owner_surface_devices WHERE owner_id = $1 ORDER BY created_at ASC',
      [ownerId],
    );
    return result.rows.map(toSurfaceDevice);
  }

  async setStatus(id: string, status: OwnerSurfaceDevice['status']): Promise<void> {
    await this.pool.query('UPDATE owner_surface_devices SET status = $2 WHERE id = $1', [id, status]);
  }
}

export class PostgresAppSecretStore implements AppSecretStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS app_secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async getOrCreate(key: string, create: () => string): Promise<string> {
    // Concurrent cold starts race here; the first insert wins and everyone reads it back.
    await this.pool.query('INSERT INTO app_secrets (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, create()]);
    const result = await this.pool.query<{ value: string }>('SELECT value FROM app_secrets WHERE key = $1', [key]);
    return result.rows[0].value;
  }
}
