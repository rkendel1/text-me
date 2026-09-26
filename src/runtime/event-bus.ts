import { EventEmitter } from 'node:events';

import pg from 'pg';

import type { ConversationRuntimeEvent } from '../domain/runtime.js';

export type RuntimeEventListener = (event: ConversationRuntimeEvent) => void;

/**
 * Fans runtime events out to subscribers (SSE streams, live call bridges).
 *
 * On Vercel, the request that changes a call and the function instance that
 * holds the call's WebSocket are usually different, so production uses the
 * Postgres implementation to reach every instance.
 */
export interface RuntimeEventBus {
  publish(event: ConversationRuntimeEvent): Promise<void>;
  subscribe(conversationId: string, listener: RuntimeEventListener): () => void;
  /** Every conversation's events (owner-wide live screens filter by ownership). */
  subscribeAll(listener: RuntimeEventListener): () => void;
}

export class InMemoryRuntimeEventBus implements RuntimeEventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  async publish(event: ConversationRuntimeEvent): Promise<void> {
    this.emitter.emit(`runtime:${event.conversationId}`, event);
    this.emitter.emit('runtime:*', event);
  }

  subscribeAll(listener: RuntimeEventListener): () => void {
    this.emitter.on('runtime:*', listener);
    return () => this.emitter.off('runtime:*', listener);
  }

  subscribe(conversationId: string, listener: RuntimeEventListener): () => void {
    const name = `runtime:${conversationId}`;
    this.emitter.on(name, listener);
    return () => this.emitter.off(name, listener);
  }
}

const CHANNEL = 'conversation_runtime_events';
/** Postgres caps NOTIFY payloads at 8000 bytes; long text is trimmed for the wire (the event store keeps it whole). */
const MAX_TEXT = 2000;

function toWire(event: ConversationRuntimeEvent): string {
  const payload = Object.fromEntries(Object.entries(event.payload).map(([key, value]) =>
    [key, typeof value === 'string' && value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value]));
  return JSON.stringify({ ...event, payload, occurredAt: event.occurredAt.toISOString() });
}

function fromWire(raw: string): ConversationRuntimeEvent | null {
  try {
    const parsed = JSON.parse(raw) as ConversationRuntimeEvent & { occurredAt: string };
    return { ...parsed, occurredAt: new Date(parsed.occurredAt) };
  } catch {
    return null;
  }
}

/**
 * Postgres LISTEN/NOTIFY bus. Publishing goes through the normal (pooled)
 * connection; listening needs one direct session, so on Neon pass
 * DATABASE_URL_UNPOOLED as `listenConnectionString`.
 */
export class PostgresRuntimeEventBus implements RuntimeEventBus {
  private readonly local = new InMemoryRuntimeEventBus();
  private listener?: pg.Client;
  private connecting?: Promise<void>;
  private subscribers = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly listenConnectionString: string,
  ) {}

  async publish(event: ConversationRuntimeEvent): Promise<void> {
    await this.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, toWire(event)]);
  }

  subscribe(conversationId: string, listener: RuntimeEventListener): () => void {
    this.subscribers += 1;
    this.listenInBackground();
    const unsubscribe = this.local.subscribe(conversationId, listener);
    return () => {
      unsubscribe();
      this.subscribers -= 1;
    };
  }

  subscribeAll(listener: RuntimeEventListener): () => void {
    this.subscribers += 1;
    this.listenInBackground();
    const unsubscribe = this.local.subscribeAll(listener);
    return () => {
      unsubscribe();
      this.subscribers -= 1;
    };
  }

  /** Resolves once this instance is receiving notifications. */
  ready(): Promise<void> {
    return this.ensureListening();
  }

  async close(): Promise<void> {
    const client = this.listener;
    this.listener = undefined;
    this.connecting = undefined;
    await client?.end().catch(() => undefined);
  }

  /** A failed LISTEN connection must never take the process down; local delivery keeps working and it retries. */
  private listenInBackground(): void {
    this.ensureListening().catch((error: Error) => {
      console.error('[runtime-bus] couldn’t start listening; retrying in 5s:', error.message);
      setTimeout(() => { if (this.subscribers > 0) this.listenInBackground(); }, 5000).unref();
    });
  }

  private ensureListening(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new pg.Client({ connectionString: this.listenConnectionString });
      client.on('notification', (message) => {
        if (message.channel !== CHANNEL || !message.payload) return;
        const event = fromWire(message.payload);
        if (event) void this.local.publish(event);
      });
      client.on('error', (error) => {
        console.error('[runtime-bus] listener error', error.message);
        this.reconnect(client);
      });
      client.on('end', () => this.reconnect(client));
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.listener = client;
    })().catch((error) => {
      this.connecting = undefined;
      throw error;
    });
    return this.connecting;
  }

  private reconnect(client: pg.Client): void {
    if (this.listener !== client) return;
    this.listener = undefined;
    this.connecting = undefined;
    if (this.subscribers > 0) {
      setTimeout(() => void this.ensureListening().catch((error) =>
        console.error('[runtime-bus] reconnect failed', error.message)), 1000);
    }
  }
}
