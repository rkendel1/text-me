import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TelnyxCallProvider } from '../src/telephony/telnyx-call-provider.js';
import {
  TELNYX_REPLAY_TOLERANCE_MS,
  telnyxSignatureValid,
  verifyTelnyxWebhook,
} from '../src/telephony/telnyx-verification.js';
import { CallProviderRejectedError, CallProviderUnconfirmedError } from '../src/calls/provider.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function testKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { publicKey: der.subarray(ED25519_SPKI_PREFIX.length).toString('base64'), privateKey };
}

function sign(privateKey: KeyObject, timestamp: string, rawBody: string): string {
  return cryptoSign(null, Buffer.from(`${timestamp}|${rawBody}`, 'utf8'), privateKey).toString('base64');
}


describe('telnyx webhook signature verification', () => {
  test('valid delivery verifies; tamper/stale/malformed fail', () => {
    const { publicKey, privateKey } = testKeyPair();
    const timestamp = new Date().toISOString();
    const rawBody = JSON.stringify({ data: { record_type: 'event', id: 'evt-9', event_type: 'call.initiated', occurred_at: timestamp, payload: { call_control_id: 'cc-9' } } });
    const signature = sign(privateKey, timestamp, rawBody);
    const verified = verifyTelnyxWebhook({ rawBody, headers: { signature, timestamp }, publicKey });
    assert.equal(verified.eventId, 'evt-9');

    assert.equal(telnyxSignatureValid({ rawBody: `${rawBody} `, timestamp, signature, publicKey }), false);
    const other = testKeyPair();
    assert.equal(telnyxSignatureValid({ rawBody, timestamp, signature, publicKey: other.publicKey }), false);

    const stale = new Date(Date.now() + TELNYX_REPLAY_TOLERANCE_MS + 60_000).toISOString();
    assert.throws(
      () => verifyTelnyxWebhook({ rawBody, headers: { signature: sign(privateKey, stale, rawBody), timestamp: stale }, publicKey }),
      /Invalid webhook signature/,
    );
    assert.throws(() => verifyTelnyxWebhook({ rawBody, headers: {}, publicKey }), /Malformed/);
    assert.throws(() => verifyTelnyxWebhook({ rawBody: '{nope', headers: { signature, timestamp }, publicKey }), /Malformed/);
  });
});

function stubFetch(handler: (url: string, init: { body?: unknown; signal?: AbortSignal }) => Response | Promise<Response>): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => handler(String(url), { body: init?.body, signal: init?.signal ?? undefined })) as typeof fetch;
}

const ok = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const failing = (status: number) => new Response(JSON.stringify({ errors: [{ title: 'refused', detail: 'bad request' }] }), { status });

describe('telnyx CallProvider contract', () => {
  test('creation returns the call_control_id and posts connection/to/from', async () => {
    let seen: { url: string; body: Record<string, unknown> } | null = null;
    const provider = new TelnyxCallProvider({
      connectionId: 'conn-1', apiKey: 'key',
      fetchImpl: stubFetch(async (url, init) => {
        seen = { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
        return ok({ data: { call_control_id: 'cc-new' } });
      }),
    });
    assert.deepEqual(await provider.createCall({ from: '+15550000000', to: '+15551230000', statusUrl: 'https://x.test/telnyx' }), { providerCallId: 'cc-new' });
    assert.equal(seen!.url, 'https://api.telnyx.com/v2/calls');
    assert.equal(seen!.body.connection_id, 'conn-1');
    assert.equal(seen!.body.webhook_url, 'https://x.test/telnyx');
  });

  test('rejection (4xx) vs unconfirmed (5xx/timeout/empty)', async () => {
    const rejected = new TelnyxCallProvider({ connectionId: 'c', apiKey: 'k', fetchImpl: stubFetch(async () => failing(422)) });
    await assert.rejects(rejected.createCall({ from: 'a', to: 'b' }), CallProviderRejectedError);
    const serverError = new TelnyxCallProvider({ connectionId: 'c', apiKey: 'k', fetchImpl: stubFetch(async () => failing(500)) });
    await assert.rejects(serverError.createCall({ from: 'a', to: 'b' }), CallProviderUnconfirmedError);
    const empty = new TelnyxCallProvider({ connectionId: 'c', apiKey: 'k', fetchImpl: stubFetch(async () => ok({ data: {} })) });
    await assert.rejects(empty.createCall({ from: 'a', to: 'b' }), CallProviderUnconfirmedError);
    const hanging = new TelnyxCallProvider({
      connectionId: 'c', apiKey: 'k', timeoutMs: 20,
      fetchImpl: stubFetch(async (_url, init) => {
        await new Promise((_, reject) => init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }));
        throw new Error('unreachable');
      }),
    });
    await assert.rejects(hanging.createCall({ from: 'a', to: 'b' }), CallProviderUnconfirmedError);
  });

  test('hangup/answer hit the call_control_id actions; lookup inconclusive; usage null', async () => {
    const paths: string[] = [];
    const provider = new TelnyxCallProvider({
      connectionId: 'c', apiKey: 'k',
      fetchImpl: stubFetch(async (url) => { paths.push(new URL(url).pathname); return ok({ data: { result: 'ok' } }); }),
    });
    await provider.endCall('cc-1', { mode: 'complete' });
    await provider.answerCallControl('cc-1');
    assert.deepEqual(paths, ['/v2/calls/cc-1/actions/hangup', '/v2/calls/cc-1/actions/answer']);
    assert.deepEqual(
      await provider.findDialedCalls({ from: 'a', to: 'b', createdAfter: new Date(0), createdBefore: new Date() }),
      { outcome: 'not_found', conclusive: false },
    );
    assert.equal(await provider.getCallUsage('cc-1'), null);
    assert.deepEqual([...provider.authoritativeUsage], []);
    assert.equal(provider.name, 'telnyx');
  });
});
