import type { AppPortApplication } from '@appport/core';
import { AppPortError, createRequest, newRequestId, type JsonValue, type Session } from '@appport/protocol';

import type { CallDirection, CallSessionStatus, CallSessionView } from '../calls/model.js';

/** Request metadata, the AppPort way: it rides the envelope, not the capability input. */
export interface CallRequestMeta {
  idempotencyKey?: string;
  timeoutMs?: number;
  traceId?: string;
}

export interface CallPage {
  items: CallSessionView[];
  nextCursor: string | null;
}

/**
 * Typed, in-process access to the call capabilities: no HTTP round trip, same validation and
 * authorization as any other caller. The voice runtime and the control plane use this; it is the
 * same dispatch path the MCP projection reaches.
 */
export class CallCapabilityClient {
  constructor(private readonly application: AppPortApplication, private readonly session: Session) {}

  private async call<Output>(name: string, input: Record<string, JsonValue | undefined>, meta: CallRequestMeta = {}): Promise<Output> {
    const response = await this.application.handleRequest(
      createRequest({
        requestId: newRequestId(),
        capability: { name, version: 1 },
        input: Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
        ...(meta.idempotencyKey ? { idempotencyKey: meta.idempotencyKey } : {}),
        ...(meta.timeoutMs ? { timeoutMs: meta.timeoutMs } : {}),
        ...(meta.traceId ? { traceId: meta.traceId } : {}),
        metadata: { transport: 'in-process' },
      }),
      { session: this.session, transport: 'in-process' },
    );
    if (!response.ok) throw new AppPortError(response.error.code, response.error.message);
    return response.output as Output;
  }

  create(
    input: { direction: CallDirection; from?: string; to?: string; providerCallId?: string; conversationId?: string },
    meta?: CallRequestMeta,
  ): Promise<{ callId: string; status: CallSessionStatus }> {
    return this.call('call.create', input, meta);
  }

  get(input: { callId: string; waitSeconds?: number; sinceVersion?: number }, meta?: CallRequestMeta): Promise<CallSessionView> {
    return this.call('call.get', input, meta);
  }

  list(
    input: { status?: CallSessionStatus[]; direction?: CallDirection; createdAfter?: string; createdBefore?: string; limit?: number; cursor?: string } = {},
    meta?: CallRequestMeta,
  ): Promise<CallPage> {
    return this.call('call.list', input, meta);
  }

  end(input: { callId: string; reason?: string }, meta?: CallRequestMeta): Promise<CallSessionView> {
    return this.call('call.end', input, meta);
  }
}
