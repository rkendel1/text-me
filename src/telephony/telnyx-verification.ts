import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

import { HttpError } from '../errors.js';

/**
 * Telnyx webhook authentication: Ed25519.
 *
 * Telnyx signs every webhook delivery. The request carries
 * `telnyx-signature-ed25519` and `telnyx-timestamp` headers; the signature is
 * verified against the account's public key (Mission Control → Settings →
 * Public Keys, `TELNYX_PUBLIC_KEY`, base64). Verification needs the EXACT
 * bytes Telnyx sent, so the route must read the body as raw text before any
 * JSON parsing. `client.webhooks.unwrap()` in the official Node SDK
 * (`telnyx`) does exactly this; this module is the dependency-free equivalent
 * so the provider boundary does not gain an SDK dependency this PR cannot
 * verify. Deliveries older than 5 minutes are rejected (the documented replay
 * window from the SDK's webhook-verification example).
 *
 * This is nothing like Twilio's HMAC scheme (`X-Twilio-Signature` over
 * URL+params with the auth token). The two must never share code.
 */

export const TELNYX_REPLAY_TOLERANCE_MS = 5 * 60_000;

export interface TelnyxWebhookHeaders {
  signature?: string;
  timestamp?: string;
}

export function telnyxHeadersFrom(headers: Record<string, string | string[] | undefined>): TelnyxWebhookHeaders {
  const pick = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;
  return {
    signature: pick(headers['telnyx-signature-ed25519']),
    timestamp: pick(headers['telnyx-timestamp']),
  };
}

/**
 * Verifies a Telnyx webhook delivery. `rawBody` is the exact request bytes
 * (utf8); `now` is injectable for tests. Throws `HttpError(403)` for an
 * invalid signature or a stale timestamp, `HttpError(400)` when the delivery
 * is malformed (missing headers/key/body shape). Returns the parsed envelope
 * on success.
 */
export function verifyTelnyxWebhook(options: {
  rawBody: string;
  headers: TelnyxWebhookHeaders;
  publicKey: string;
  now?: Date;
}): { eventType: string; eventId: string; occurredAt: string | null; payload: Record<string, unknown> } {
  const { rawBody, headers, publicKey } = options;
  const now = options.now ?? new Date();
  if (!headers.signature || !headers.timestamp) throw new HttpError(400, 'Malformed webhook payload');
  if (!publicKey) throw new HttpError(400, 'Malformed webhook payload');
  const timestampMs = Date.parse(headers.timestamp);
  if (!Number.isFinite(timestampMs)) throw new HttpError(400, 'Malformed webhook payload');
  if (Math.abs(now.getTime() - timestampMs) > TELNYX_REPLAY_TOLERANCE_MS) {
    throw new HttpError(403, 'Invalid webhook signature');
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, 'Malformed webhook payload');
  }
  if (!telnyxSignatureValid({ rawBody, timestamp: headers.timestamp, signature: headers.signature, publicKey })) {
    throw new HttpError(403, 'Invalid webhook signature');
  }
  const data = (envelope as { data?: unknown }).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Malformed webhook payload');
  const record = data as Record<string, unknown>;
  if (typeof record.event_type !== 'string' || !record.event_type) throw new HttpError(400, 'Malformed webhook payload');
  if (typeof record.id !== 'string' || !record.id) throw new HttpError(400, 'Malformed webhook payload');
  if (record.payload !== undefined && (typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload))) {
    throw new HttpError(400, 'Malformed webhook payload');
  }
  return {
    eventType: record.event_type,
    eventId: record.id,
    occurredAt: typeof record.occurred_at === 'string' ? record.occurred_at : null,
    payload: (record.payload ?? {}) as Record<string, unknown>,
  };
}

/**
 * The signature check itself. The signed message is
 * `<telnyx-timestamp>|<raw-body>` (timestamp, a pipe, and the exact body
 * bytes), verified with Ed25519 against the base64 public key.
 * `false` on any malformed key/signature (never throws).
 */
export function telnyxSignatureValid(options: { rawBody: string; timestamp: string; signature: string; publicKey: string }): boolean {
  try {
    const key = telnyxPublicKey(options.publicKey);
    const message = Buffer.from(`${options.timestamp}|${options.rawBody}`, 'utf8');
    const signature = Buffer.from(options.signature, 'base64');
    // Ed25519 is a "null-digest" signature scheme: it must be verified with a
    // null algorithm. `createVerify('sha512')` cannot be used here — Node
    // rejects it for Ed25519 keys ("Unsupported crypto operation").
    return verifySignature(null, message, key, signature);
  } catch {
    return false;
  }
}

// The portal shows a raw 32-byte base64 key; Node wants SPKI DER
// (12-byte prefix + key).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function telnyxPublicKey(base64: string) {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length !== 32) throw new Error('bad key length');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Non-secret fingerprint for logs (which key verified this delivery). */
export function telnyxPublicKeyFingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}
