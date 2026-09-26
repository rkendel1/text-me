import type { Pool } from 'pg';

import type {
  Conversation,
  ConversationEvent,
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
        )
        VALUES ($1, $2, $3, $4, $5, $6)
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
        ORDER BY started_at DESC
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
    patch: { endedAt?: Date | null; durationSeconds?: number | null },
  ): Promise<void> {
    await this.pool.query(
      `
        UPDATE conversations
        SET
          status = $2,
          ended_at = COALESCE($3, ended_at),
          duration_seconds = COALESCE($4, duration_seconds)
        WHERE id = $1
      `,
      [
        conversationId,
        status,
        patch.endedAt ?? null,
        patch.durationSeconds ?? null,
      ],
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
          ORDER BY occurred_at ASC
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
