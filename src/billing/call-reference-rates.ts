import type { PriceRate } from '../calls/cost/pricing.js';

/**
 * REFERENCE RATES: configuration data, not logic. Nothing in the call or cost code names a price; these are only
 * what the default price book is loaded with. Change a price by adding a rate with a later `effectiveFrom` and
 * closing the old one with `effectiveTo`, never by editing a number in place (history is priced with the rate that
 * was in force, and is kept).
 *
 * Source: the carriers' published US list prices as given to this project (2026-10-01). They are USD per minute
 * (per call for AMD), unverified against an invoice, and not a statement of what this account is charged.
 * Telnyx is listed so the price book can price its usage the moment an adapter reports it; no Telnyx adapter exists
 * and nothing is routed to it.
 *
 * AI vendors are deliberately absent: no AI rate is configured, so AI usage is recorded and shown as unpriced until
 * one is added with the model it applies to.
 */
const FROM = new Date('2026-10-01T00:00:00Z');
const usd = (provider: string, product: string, rate: number, unit: 'minute' | 'call', note: string): PriceRate => ({
  id: `${provider}.${product}.metric@${FROM.toISOString().slice(0, 10)}`.replace('metric', unit === 'call' ? 'invocation' : 'duration'),
  provider, product, metric: unit === 'call' ? 'invocation' : 'duration', unit, rate, currency: 'USD', effectiveFrom: FROM, note,
});

export const REFERENCE_RATES: readonly PriceRate[] = [
  usd('twilio', 'voice_outbound', 0.014, 'minute', 'US local outbound'),
  usd('twilio', 'voice_inbound', 0.0085, 'minute', 'US local inbound'),
  usd('twilio', 'media_stream', 0.0044, 'minute', 'Media Streams'),
  usd('twilio', 'recording', 0.0025, 'minute', 'Recording'),
  usd('telnyx', 'voice_api', 0.002, 'minute', 'Voice API'),
  usd('telnyx', 'voice_outbound', 0.005, 'minute', 'US outbound network'),
  usd('telnyx', 'voice_inbound', 0.0032, 'minute', 'US inbound network'),
  usd('telnyx', 'media_stream', 0.0035, 'minute', 'Media Streaming WebSockets'),
  usd('telnyx', 'recording', 0.002, 'minute', 'Recording'),
  usd('telnyx', 'amd', 0.002, 'call', 'Standard AMD'),
];
