import type { Pool } from 'pg';

import type {
  ConversationRuntime,
  ConversationRuntimeEvent,
  RuntimeOverride,
} from '../domain/runtime.js';
import type {
  ConversationRuntimeEventStore,
  ConversationRuntimeStore,
  RuntimeOverrideStore,
} from '../runtime/store.js';
import type { RuntimeCommand, RuntimeCommandStore } from '../runtime/commands.js';

interface ConversationRuntimeRow {
  conversation_id: string;
  state: ConversationRuntime['state'];
  assistant_enabled: boolean;
  voice_enabled: boolean;
  transcription_enabled: boolean;
  ai_mode: ConversationRuntime['aiMode'];
  response_style: ConversationRuntime['responseStyle'];
  verbosity: ConversationRuntime['verbosity'];
  ask_owner_when: ConversationRuntime['askOwnerWhen'];
  allow_commitments: boolean;
  allow_scheduling: boolean;
  allow_caller_followups: boolean;
  custom_instructions: string | null;
  sms_transition_enabled: boolean;
  started_at: Date | null;
  paused_at: Date | null;
  stopped_at: Date | null;
  current_turn_id: string | null;
  current_activity: string | null;
  configuration_revision: number;
  applied_revision: number;
  updated_at: Date;
}

interface ConversationRuntimeEventRow {
  id: string;
  conversation_id: string;
  type: ConversationRuntimeEvent['type'];
  payload: Record<string, unknown>;
  occurred_at: Date;
  durable: boolean;
}

interface RuntimeOverrideRow {
  conversation_id: string;
  field: RuntimeOverride['field'];
  value: unknown;
  created_at: Date;
  expires_at: Date | null;
}

function hydrateRuntime(row: ConversationRuntimeRow): ConversationRuntime {
  return {
    conversationId: row.conversation_id,
    state: row.state,
    assistantEnabled: row.assistant_enabled,
    voiceEnabled: row.voice_enabled,
    transcriptionEnabled: row.transcription_enabled,
    aiMode: row.ai_mode,
    responseStyle: row.response_style,
    verbosity: row.verbosity,
    askOwnerWhen: row.ask_owner_when,
    allowCommitments: row.allow_commitments,
    allowScheduling: row.allow_scheduling,
    allowCallerFollowups: row.allow_caller_followups,
    customInstructions: row.custom_instructions ?? undefined,
    smsTransitionEnabled: row.sms_transition_enabled,
    startedAt: row.started_at ?? undefined,
    pausedAt: row.paused_at ?? undefined,
    stoppedAt: row.stopped_at ?? undefined,
    currentTurnId: row.current_turn_id ?? undefined,
    currentActivity: row.current_activity ?? undefined,
    configurationRevision: row.configuration_revision,
    appliedRevision: row.applied_revision,
    updatedAt: row.updated_at,
  };
}

export class PostgresConversationRuntimeStore implements ConversationRuntimeStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_runtimes (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        assistant_enabled BOOLEAN NOT NULL,
        voice_enabled BOOLEAN NOT NULL,
        transcription_enabled BOOLEAN NOT NULL,
        ai_mode TEXT NOT NULL,
        response_style TEXT NOT NULL,
        verbosity TEXT NOT NULL,
        ask_owner_when TEXT NOT NULL,
        allow_commitments BOOLEAN NOT NULL,
        allow_scheduling BOOLEAN NOT NULL,
        allow_caller_followups BOOLEAN NOT NULL,
        custom_instructions TEXT,
        sms_transition_enabled BOOLEAN NOT NULL,
        started_at TIMESTAMPTZ,
        paused_at TIMESTAMPTZ,
        stopped_at TIMESTAMPTZ,
        current_turn_id TEXT,
        current_activity TEXT,
        configuration_revision INTEGER NOT NULL,
        applied_revision INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);
  }

  async get(conversationId: string): Promise<ConversationRuntime | null> {
    const result = await this.pool.query<ConversationRuntimeRow>(
      'SELECT * FROM conversation_runtimes WHERE conversation_id = $1',
      [conversationId],
    );
    return result.rows[0] ? hydrateRuntime(result.rows[0]) : null;
  }

  async save(runtime: ConversationRuntime): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO conversation_runtimes (
          conversation_id, state, assistant_enabled, voice_enabled, transcription_enabled,
          ai_mode, response_style, verbosity, ask_owner_when,
          allow_commitments, allow_scheduling, allow_caller_followups,
          custom_instructions, sms_transition_enabled,
          started_at, paused_at, stopped_at, current_turn_id, current_activity,
          configuration_revision, applied_revision, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12,
          $13, $14,
          $15, $16, $17, $18, $19,
          $20, $21, $22
        )
        ON CONFLICT (conversation_id) DO UPDATE SET
          state = EXCLUDED.state,
          assistant_enabled = EXCLUDED.assistant_enabled,
          voice_enabled = EXCLUDED.voice_enabled,
          transcription_enabled = EXCLUDED.transcription_enabled,
          ai_mode = EXCLUDED.ai_mode,
          response_style = EXCLUDED.response_style,
          verbosity = EXCLUDED.verbosity,
          ask_owner_when = EXCLUDED.ask_owner_when,
          allow_commitments = EXCLUDED.allow_commitments,
          allow_scheduling = EXCLUDED.allow_scheduling,
          allow_caller_followups = EXCLUDED.allow_caller_followups,
          custom_instructions = EXCLUDED.custom_instructions,
          sms_transition_enabled = EXCLUDED.sms_transition_enabled,
          started_at = EXCLUDED.started_at,
          paused_at = EXCLUDED.paused_at,
          stopped_at = EXCLUDED.stopped_at,
          current_turn_id = EXCLUDED.current_turn_id,
          current_activity = EXCLUDED.current_activity,
          configuration_revision = EXCLUDED.configuration_revision,
          applied_revision = EXCLUDED.applied_revision,
          updated_at = EXCLUDED.updated_at
      `,
      [
        runtime.conversationId,
        runtime.state,
        runtime.assistantEnabled,
        runtime.voiceEnabled,
        runtime.transcriptionEnabled,
        runtime.aiMode,
        runtime.responseStyle,
        runtime.verbosity,
        runtime.askOwnerWhen,
        runtime.allowCommitments,
        runtime.allowScheduling,
        runtime.allowCallerFollowups,
        runtime.customInstructions ?? null,
        runtime.smsTransitionEnabled,
        runtime.startedAt ?? null,
        runtime.pausedAt ?? null,
        runtime.stoppedAt ?? null,
        runtime.currentTurnId ?? null,
        runtime.currentActivity ?? null,
        runtime.configurationRevision,
        runtime.appliedRevision,
        runtime.updatedAt,
      ],
    );
  }

  async list(conversationIds?: string[]): Promise<ConversationRuntime[]> {
    if (conversationIds?.length) {
      const result = await this.pool.query<ConversationRuntimeRow>(
        'SELECT * FROM conversation_runtimes WHERE conversation_id = ANY($1::text[]) ORDER BY updated_at DESC',
        [conversationIds],
      );
      return result.rows.map(hydrateRuntime);
    }
    const result = await this.pool.query<ConversationRuntimeRow>('SELECT * FROM conversation_runtimes ORDER BY updated_at DESC');
    return result.rows.map(hydrateRuntime);
  }
}

export class PostgresConversationRuntimeEventStore implements ConversationRuntimeEventStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_runtime_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        durable BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_conversation_runtime_events_conversation ON conversation_runtime_events (conversation_id, occurred_at DESC)');
  }

  async append(event: ConversationRuntimeEvent): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO conversation_runtime_events (id, conversation_id, type, payload, occurred_at, durable)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [event.id, event.conversationId, event.type, event.payload, event.occurredAt, event.durable],
    );
  }

  async list(conversationId: string): Promise<ConversationRuntimeEvent[]> {
    const result = await this.pool.query<ConversationRuntimeEventRow>(
      'SELECT * FROM conversation_runtime_events WHERE conversation_id = $1 ORDER BY occurred_at ASC, id ASC',
      [conversationId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      type: row.type,
      payload: row.payload,
      occurredAt: row.occurred_at,
      durable: row.durable,
    }));
  }

  async findByCommandId(conversationId: string, commandId: string): Promise<ConversationRuntimeEvent | null> {
    const result = await this.pool.query<ConversationRuntimeEventRow>(
      `
        SELECT *
        FROM conversation_runtime_events
        WHERE conversation_id = $1 AND payload->>'commandId' = $2
        ORDER BY occurred_at DESC
        LIMIT 1
      `,
      [conversationId, commandId],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      conversationId: row.conversation_id,
      type: row.type,
      payload: row.payload,
      occurredAt: row.occurred_at,
      durable: row.durable,
    } : null;
  }
}

export class PostgresRuntimeOverrideStore implements RuntimeOverrideStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_runtime_overrides (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        value JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ,
        PRIMARY KEY (conversation_id, field)
      )
    `);
  }

  async list(conversationId: string): Promise<RuntimeOverride[]> {
    const result = await this.pool.query<RuntimeOverrideRow>(
      'SELECT * FROM conversation_runtime_overrides WHERE conversation_id = $1 ORDER BY created_at ASC',
      [conversationId],
    );
    return result.rows.map((row) => ({
      conversationId: row.conversation_id,
      field: row.field,
      value: row.value,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
    }));
  }

  async save(override: RuntimeOverride): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO conversation_runtime_overrides (conversation_id, field, value, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (conversation_id, field) DO UPDATE SET
          value = EXCLUDED.value,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at
      `,
      [override.conversationId, override.field, JSON.stringify(override.value), override.createdAt, override.expiresAt ?? null],
    );
  }

  async delete(conversationId: string, field: RuntimeOverride['field']): Promise<void> {
    await this.pool.query(
      'DELETE FROM conversation_runtime_overrides WHERE conversation_id = $1 AND field = $2',
      [conversationId, field],
    );
  }

  async clearConversation(conversationId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM conversation_runtime_overrides WHERE conversation_id = $1',
      [conversationId],
    );
  }
}

interface RuntimeCommandRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  type: RuntimeCommand['type'];
  payload: Record<string, unknown>;
  status: RuntimeCommand['status'];
  error: string | null;
  created_at: Date;
  processed_at: Date | null;
  applied_live_at: Date | null;
}

/** Auditable history of every owner command sent to a conversation's runtime. */
export class PostgresRuntimeCommandStore implements RuntimeCommandStore {
  constructor(private readonly pool: Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS runtime_commands (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        applied_live_at TIMESTAMPTZ
      )
    `);
    await this.pool.query('CREATE INDEX IF NOT EXISTS idx_runtime_commands_conversation ON runtime_commands (conversation_id, created_at)');
  }

  async record(command: RuntimeCommand): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO runtime_commands (id, conversation_id, owner_id, type, payload, status, error, created_at, processed_at, applied_live_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO NOTHING
      `,
      [command.id, command.conversationId, command.ownerId, command.type, command.payload, command.status,
        command.error ?? null, command.createdAt, command.processedAt ?? null, command.appliedLiveAt ?? null],
    );
  }

  async update(id: string, patch: Parameters<RuntimeCommandStore['update']>[1]): Promise<void> {
    await this.pool.query(
      `
        UPDATE runtime_commands
           SET status = CASE WHEN status = 'applied_live' AND $2 = 'applied' THEN status ELSE $2 END,
               error = COALESCE($3, error),
               processed_at = COALESCE($4, processed_at),
               applied_live_at = COALESCE($5, applied_live_at)
         WHERE id = $1
      `,
      [id, patch.status, patch.error ?? null, patch.processedAt ?? null, patch.appliedLiveAt ?? null],
    );
  }

  async list(conversationId: string): Promise<RuntimeCommand[]> {
    const result = await this.pool.query<RuntimeCommandRow>(
      'SELECT * FROM runtime_commands WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC',
      [conversationId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      ownerId: row.owner_id,
      type: row.type,
      payload: row.payload,
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at,
      ...(row.processed_at ? { processedAt: row.processed_at } : {}),
      ...(row.applied_live_at ? { appliedLiveAt: row.applied_live_at } : {}),
    }));
  }
}
