import type { UsageMetric } from '../../calls/cost/model.js';

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

/**
 * Token usage a realtime model reported on a finished response, taken from the event's raw payload
 * (`response.usage`, the shape OpenAI's Realtime API documents for `response.done`). Only what is present is
 * returned: a payload without usage yields nothing, and nothing is ever estimated here. Whether the AI Gateway
 * passes the vendor's usage through unchanged has not been verified against the live Gateway.
 */
export function extractRealtimeUsage(raw: unknown): Partial<Record<UsageMetric, number>> {
  const payload = record(raw);
  const usage = record(record(payload?.response)?.usage) ?? record(payload?.usage);
  if (!usage) return {};
  const inputDetails = record(usage.input_token_details);
  const outputDetails = record(usage.output_token_details);
  const metrics: Partial<Record<UsageMetric, number>> = {};
  const set = (metric: UsageMetric, value: unknown) => { const n = count(value); if (n !== undefined) metrics[metric] = n; };
  if (inputDetails && (count(inputDetails.audio_tokens) !== undefined || count(inputDetails.text_tokens) !== undefined)) {
    set('audio_input_tokens', inputDetails.audio_tokens);
    set('text_input_tokens', inputDetails.text_tokens);
  } else set('input_tokens', usage.input_tokens);
  set('cached_input_tokens', inputDetails?.cached_tokens);
  if (outputDetails && (count(outputDetails.audio_tokens) !== undefined || count(outputDetails.text_tokens) !== undefined)) {
    set('audio_output_tokens', outputDetails.audio_tokens);
    set('text_output_tokens', outputDetails.text_tokens);
  } else set('output_tokens', usage.output_tokens);
  return metrics;
}
