import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TelnyxCallProvider } from '../src/telephony/telnyx-call-provider.js';
import { TelnyxProvider } from '../src/telephony/telnyx-provider.js';
import {
  TELNYX_REPLAY_TOLERANCE_MS,
  telnyxSignatureValid,
  verifyTelnyxWebhook,
} from '../src/telephony/telnyx-verification.js';
import { mapTelnyxDirection, mapTelnyxEventToStatus } from '../src/calls/provider-status.js';
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

describe('telnyx provider-neutral mapping', () => {
  test('lifecycle events map; observations do not move the domain', () => {
    assert.equal(mapTelnyxEventToStatus('call.initiated'), 'ringing');
    assert.equal(mapTelnyxEventToStatus('call.ringing'), 'ringing');
    assert.equal(mapTelnyxEventToStatus('call.answered'), 'answered');
    assert.equal(mapTelnyxEventToStatus('call.bridged'), 'answered');
    assert.equal(mapTelnyxEventToStatus('call.hangup'), 'completed');
    for (const observation of [
      'call.recording.saved', 'streaming.started', 'streaming.stopped', 'streaming.failed',
      'call.machine.detection.ended', 'call.transcription', 'call.gather.ended',
    ]) {
      assert.equal(mapTelnyxEventToStatus(observation), null, observation);
    }
  });

  test('direction: outgoing is outbound, everything else is inbound', () => {
    assert.equal(mapTelnyxDirection('outgoing'), 'outbound');
    assert.equal(mapTelnyxDirection('incoming'), 'inbound');
    assert.equal(mapTelnyxDirection(undefined), 'inbound');
  });

  test('parseIncomingCall honors call.initiated only and keeps leg/session ids', () => {
    const provider = new TelnyxProvider();
    const call = provider.parseIncomingCall({
      eventId: 'evt-1', eventType: 'call.initiated', occurredAt: '2026-10-01T12:00:00Z',
      payload: {
        call_control_id: 'cc-1', call_leg_id: 'leg-1', call_session_id: 'sess-1',
        from: '+15553334444', to: '+15550000000', direction: 'incoming',
      },
    });
    assert.equal(call.providerCallId, 'cc-1');
    assert.equal(call.direction, 'inbound');
    assert.equal((call.payload as Record<string, unknown>).call_session_id, 'sess-1');
    assert.throws(
      () => provider.parseIncomingCall({ eventId: 'e', eventType: 'call.answered', occurredAt: null, payload: { call_control_id: 'cc-1' } }),
      /call\.initiated/,
    );
  });

  test('parseStatusUpdate never rejects an unknown event; id is the webhook id', () => {
    const provider = new TelnyxProvider();
    const update = provider.parseStatusUpdate({
      eventId: 'evt-amd', eventType: 'call.machine.detection.ended', occurredAt: '2026-10-01T12:01:00Z',
      payload: { call_control_id: 'cc-1', result: 'human' },
    });
    assert.equal(update.status, null);
    assert.equal(update.eventId, 'evt-amd');
    const hangup = provider.parseStatusUpdate({
      eventId: 'evt-h', eventType: 'call.hangup', occurredAt: null,
      payload: { call_control_id: 'cc-1' },
    });
    assert.equal(hangup.status, 'completed');
  });
});
