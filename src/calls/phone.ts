import { E164 } from '../tenancy/model.js';

/**
 * A destination for an outbound call, in the one format the provider dials: E.164.
 *
 * Only presentation is normalised: spaces, dots, dashes and parentheses are removed. A number is never
 * reinterpreted: one without a leading `+` has no country, so it is rejected rather than guessed into
 * some other destination. (Inbound callers are recorded leniently because a carrier may send anything;
 * that is a different rule for a different direction.)
 */
export function normalizeDialableNumber(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith('+')) return null;
  const stripped = trimmed.replace(/[\s().-]/g, '');
  return E164.test(stripped) ? stripped : null;
}
