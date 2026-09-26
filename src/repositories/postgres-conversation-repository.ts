import type { Pool } from 'pg';

import type {
  Conversation,
  ConversationChannel,
  ConversationEvent,
  ConversationParticipant,
  ConversationState,
  ConversationStatus,
} from '../domain/conversation.js';
import { createConversationId, createEventId } from '../lib/ids.js';
import type {
  ConversationRepository,
  CreateConversationInput,
} from './conversation-repository.js';

interface ConversationRow {
  id: string;
  provider: string;
  provider_call_id: string;
  caller_phone: string;
  status: ConversationStatus;
  started_at: Date;
  ended_at: Date | null;
  duration_seconds: number | null;
  state: ConversationState | null;
  channels: ConversationChannel[] | null;
  primary_channel: ConversationChannel | null;
  participants: ConversationParticipant[] | null;
  owner_id: string | null;
  last_owner_read_at: Date | null;
}

interface EventRow {
  id: string;
  conversation_id: string;
  type: ConversationEvent['type'];
  payload: Record<string, unknown>;
  occurred_at: Date;
}

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_call_id TEXT NOT NULL,
        caller_phone TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        state TEXT NOT NULL DEFAULT 'voice_active',
        channels JSONB NOT NULL DEFAULT '["voice"]',
        primary_channel TEXT NOT NULL DEFAULT 'voice',
        participants JSONB NOT NULL DEFAULT '[]',
        owner_id TEXT,
        last_owner_read_at TIMESTAMPTZ,
        UNIQUE (provider, provider_call_id)
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL
      );
    `);
    await this.pool.query(`
      ALTER TABLE conversations
        ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'voice_active',
        ADD COLUMN IF NOT EXISTS channels JSONB NOT NULL DEFAULT '["voice"]',
        ADD COLUMN IF NOT EXISTS primary_channel TEXT NOT NULL DEFAULT 'voice',
        ADD COLUMN IF NOT EXISTS participants JSONB NOT NULL DEFAULT '[]',
          ADD COLUMN IF NOT EXISTS owner_id TEXT,
          ADD COLUMN IF NOT EXISTS last_owner_read_at TIMESTAMPTZ;
    `);
  }

  async createIfAbsent(
    input: CreateConversationInput,
  ): Promise<{ conversation: Conversation; created: boolean }> {
    const id = createConversationId();
    const result = await this.pool.query<ConversationRow>(
      `
        INSERT INTO conversations (
          id,
          provider,
          provider_call_id,
          caller_phone,
          status,
          started_at
          , owner_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (provider, provider_call_id) DO NOTHING
        RETURNING *
      `,
      [
        id,
        input.provider,
        input.providerCallId,
        input.callerPhone,
        input.status,
        input.startedAt,
        input.ownerId ?? null,
      ],
    );

    if (result.rowCount && result.rows[0]) {
      const conversation = await this.getConversationWithEvents(result.rows[0].id);
      if (!conversation) {
        throw new Error('Conversation insert succeeded but could not be reloaded');
      }

      return {
        conversation,
        created: true,
      };
    }

    const existing = await this.getByProviderCallId(
      input.provider,
      input.providerCallId,
    );

    if (!existing) {
      throw new Error('Conversation disappeared after insert conflict');
    }

    return { conversation: existing, created: false };
  }

  async getById(id: string): Promise<Conversation | null> {
    return this.getConversationWithEvents(id);
  }

  async getByProviderCallId(
    provider: string,
    providerCallId: string,
  ): Promise<Conversation | null> {
    const result = await this.pool.query<ConversationRow>(
      `
        SELECT *
        FROM conversations
        WHERE provider = $1 AND provider_call_id = $2
      `,
      [provider, providerCallId],
    );

    const row = result.rows[0];
    return row ? this.getConversationWithEvents(row.id) : null;
  }

  async list(): Promise<Conversation[]> {
    const result = await this.pool.query<ConversationRow>(
      `
        SELECT *
        FROM conversations
        ORDER BY GREATEST(started_at, COALESCE((SELECT MAX(occurred_at) FROM conversation_events e WHERE e.conversation_id = conversations.id), started_at)) DESC
      `,
    );

    const conversations = await Promise.all(
      result.rows.map((row) => this.getConversationWithEvents(row.id)),
    );

    return conversations.filter((conversation): conversation is Conversation =>
      Boolean(conversation),
    );
  }

  async appendEvent(
    conversationId: string,
    type: ConversationEvent['type'],
    payload: Record<string, unknown>,
    occurredAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO conversation_events (
          id,
          conversation_id,
          type,
          payload,
          occurred_at
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [createEventId(), conversationId, type, payload, occurredAt],
    );
  }

  async updateStatus(
    conversationId: string,
    status: ConversationStatus,
    patch: {
      endedAt?: Date | null;
      durationSeconds?: number | null;
      state?: ConversationState;
    },
  ): Promise<void> {
    await this.pool.query(
      `
        UPDATE conversations
        SET
          status = $2,
          ended_at = COALESCE($3, ended_at),
          duration_seconds = COALESCE($4, duration_seconds),
          state = COALESCE($5, state)
        WHERE id = $1
      `,
      [
        conversationId,
        status,
        patch.endedAt ?? null,
        patch.durationSeconds ?? null,
        patch.state ?? null,
      ],
    );
  }

  async markOwnerRead(conversationId: string, ownerId: string, readAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE conversations SET last_owner_read_at = $3 WHERE id = $1 AND owner_id = $2`,
      [conversationId, ownerId, readAt],
    );
  }

  private async getConversationWithEvents(id: string): Promise<Conversation | null> {
    const [conversationResult, eventsResult] = await Promise.all([
      this.pool.query<ConversationRow>(
        `
          SELECT *
          FROM conversations
          WHERE id = $1
        `,
        [id],
      ),
      this.pool.query<EventRow>(
        `
          SELECT *
          FROM conversation_events
          WHERE conversation_id = $1
          ORDER BY occurred_at ASC, id ASC
        `,
        [id],
      ),
    ]);

    const row = conversationResult.rows[0];

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      provider: row.provider,
      providerCallId: row.provider_call_id,
      callerPhone: row.caller_phone,
      status: row.status,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : null,
      durationSeconds: row.duration_seconds,
      state: row.state ?? 'voice_active',
      channels: row.channels ?? ['voice'],
      primaryChannel: row.primary_channel ?? 'voice',
      participants: row.participants ?? [],
      ownerId: row.owner_id ?? undefined,
      lastOwnerReadAt: row.last_owner_read_at ? new Date(row.last_owner_read_at) : null,
      events: eventsResult.rows.map((event) => ({
        id: event.id,
        conversationId: event.conversation_id,
        type: event.type,
        payload: event.payload,
        occurredAt: new Date(event.occurred_at),
      })),
    };
  }
}
