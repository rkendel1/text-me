import {
  CallProviderRejectedError, CallProviderUnconfirmedError,
  type CallProvider, type CallProviderCreateInput, type ProviderCallLookup, type ProviderCallLookupInput, type ProviderUsageReport,
} from '../calls/provider.js';

/**
 * The only place the application places or ends Telnyx calls
 * (`POST /v2/calls`, `POST /v2/calls/:call_control_id/actions/*`).
 * The CallSession domain depends on `CallProvider`, never on Telnyx's API.
 *
 * Transport: dependency-free `fetch` against the documented Telnyx Voice API
 * (verified 2026-10: `POST /v2/calls` dial with `connection_id`/`to`/`from`;
 * `POST /v2/calls/:call_control_id/actions/{answer,hangup}`). No Telnyx SDK
 * is installed: the `telnyx` npm package could not be verified from the
 * network available to this PR, and the adapter needs only documented
 * endpoints, so a small auditable HTTP client is used instead. Switching to
 * the SDK later changes only this file (and its webhook sibling).
 *
 * Identifier mapping (Telnyx documents all three as distinct):
 * - `providerCallId` IS the `call_control_id`. It is the only id that can
 *   issue call-control commands, so it is authoritative for answer/hangup.
 * - `call_leg_id` and `call_session_id` arrive on webhooks and are preserved
 *   in the webhook payload, but are NOT stored as separate columns:
 *   `CallSession` is not expanded for Telnyx.
 * - `connection_id` is configuration (which Voice API application owns the
 *   call), never per-call state.
 */

export interface TelnyxCallProviderOptions {
  connectionId: string;
  /** Bearer API key (`TELNYX_API_KEY`). */
  apiKey: string;
  /** Per-call webhook override; defaults to the Voice API app's configured URL. */
  webhookUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface TelnyxApiError extends Error {
  status?: number;
  code?: string | number;
}

export class TelnyxCallProvider implements CallProvider {
  readonly name = 'telnyx';
  /**
   * No category: Telnyx cost/usage could not be verified against a live
   * account in this PR (no per-call settled-usage endpoint was confirmed in
   * the docs reachable here), so the adapter reports nothing as `final` and
   * the ledger keeps such calls `estimated` rather than presenting a guessed
   * charge as authoritative.
   */
  readonly authoritativeUsage = [] as const;
  private readonly connectionId: string;
  private readonly apiKey: string;
  private readonly webhookUrl?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelnyxCallProviderOptions) {
    if (!options.connectionId) throw new Error('TelnyxCallProvider needs a connectionId.');
    if (!options.apiKey) throw new Error('TelnyxCallProvider needs an apiKey.');
    this.connectionId = options.connectionId;
    this.apiKey = options.apiKey;
    this.webhookUrl = options.webhookUrl;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** `POST /v2/calls` (`connection_id`, `to`, `from`, webhook + client state). */
  async createCall(input: CallProviderCreateInput): Promise<{ providerCallId: string }> {
    const body: Record<string, unknown> = {
      connection_id: this.connectionId,
      to: input.to,
      from: input.from,
      ...(this.webhookUrl ?? input.statusUrl ? { webhook_url: this.webhookUrl ?? input.statusUrl } : {}),
      ...(input.statusUrl ? { webhook_url_method: 'POST' } : {}),
      client_state: Buffer.from('jtm', 'utf8').toString('base64'),
    };
    try {
      const data = await this.request<{ data?: { call_control_id?: unknown } }>('POST', '/v2/calls', body);
      const callControlId = data.data?.call_control_id;
      if (typeof callControlId !== 'string' || !callControlId) {
        throw new CallProviderUnconfirmedError('Telnyx accepted the dial but returned no call_control_id.');
      }
      return { providerCallId: callControlId };
    } catch (error) {
      if (error instanceof CallProviderRejectedError || error instanceof CallProviderUnconfirmedError) throw error;
      throw classifyCreateFailure(error);
    }
  }

  /**
   * Telnyx documents no "list calls by from/to/window" Voice API endpoint
   * reachable from this PR, so unlike Twilio (which lists by from/to at the
   * API) this implementation cannot query the provider by counterpart pair.
   * It returns `not_found` with `conclusive: false`: absence never proves
   * anything, and no ambiguous provider call is ever attached. Reconciliation
   * stays unconfirmed rather than guessing.
   */
  async findDialedCalls(_input: ProviderCallLookupInput): Promise<ProviderCallLookup> {
    return { outcome: 'not_found', conclusive: false };
  }

  /**
   * Usage: not authoritative in this PR (see `authoritativeUsage`). No
   * per-call settled usage endpoint was verified, so this returns `null`
   * ("nothing to report yet") and the ledger keeps the call estimated.
   */
  async getCallUsage(_providerCallId: string): Promise<ProviderUsageReport | null> {
    return null;
  }

  /**
   * Answers an inbound (parked) call: `POST
   * /v2/calls/:call_control_id/actions/answer`. Not part of the
   * provider-neutral `CallProvider` contract (Twilio answers inline in the
   * webhook response); the Telnyx webhook route calls this after it has
   * recorded the CallSession. Optionally speaks a greeting via a follow-up
   * `speak` command; a speak failure never fails the answer.
   */
  async answerCallControl(providerCallId: string, options: { speak?: string } = {}): Promise<void> {
    await this.request('POST', `/v2/calls/${encodeURIComponent(providerCallId)}/actions/answer`, {});
    if (options.speak) {
      try {
        await this.request('POST', `/v2/calls/${encodeURIComponent(providerCallId)}/actions/speak`, {
          payload: options.speak.slice(0, 500),
          voice: 'female',
        });
      } catch (error) {
        console.warn('[call]', JSON.stringify({ event: 'call.telnyx.speak_failed', providerCallId, error: (error as Error).message?.slice(0, 200) }));
      }
    }
  }

  /**
   * `POST /v2/calls/:call_control_id/actions/hangup` (mode is accepted for
   * interface parity; Telnyx hangup takes no mode — `cancel` and `complete`
   * send the same command).
   */
  async endCall(providerCallId: string, _options: { mode: 'cancel' | 'complete' }): Promise<void> {
    await this.request('POST', `/v2/calls/${encodeURIComponent(providerCallId)}/actions/hangup`, {
      command_id: `jtm-end-${Date.now()}`,
    });
  }

  private async request<T>(method: 'POST' | 'GET', path: string, body?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`https://api.telnyx.com${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as {
        errors?: Array<{ code?: string | number; title?: string; detail?: string }>;
      } | null;
      if (!response.ok) {
        const first = payload?.errors?.[0];
        const error = new Error(first?.detail ?? first?.title ?? `Telnyx request failed (${response.status}).`) as TelnyxApiError;
        error.status = response.status;
        if (first?.code !== undefined) error.code = first.code;
        throw error;
      }
      return payload as T;
    } catch (error) {
      if (error instanceof CallProviderRejectedError || error instanceof CallProviderUnconfirmedError) throw error;
      if ((error as { name?: string }).name === 'AbortError') {
        throw new CallProviderUnconfirmedError('The Telnyx request timed out; a call may or may not exist.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Telnyx answered with an HTTP 4xx: it looked at the request and refused it,
 * so no call exists (bad number, bad connection id, authentication problem,
 * rate limit). Anything else (timeout/abort, dropped connection, 5xx) says
 * nothing about whether the call was created → unconfirmed, never re-dialed.
 * (408 is a timeout, not a verdict.)
 */
export function classifyTelnyxCreateFailure(error: unknown): Error {
  const { status, code, message } = (error ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  const text = typeof message === 'string' ? message : 'The call could not be created.';
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
    return new CallProviderRejectedError(text, typeof code === 'string' || typeof code === 'number' ? code : status);
  }
  return new CallProviderUnconfirmedError(text, { cause: error });
}

const classifyCreateFailure = classifyTelnyxCreateFailure;
