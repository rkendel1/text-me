/**
 * Structured call logging on the repository's existing convention (one JSON line per event,
 * tagged, through `console`). Every line carries the ids needed to correlate a call:
 * `callId`, `providerCallId` and `traceId`. Phone numbers are masked; nothing secret is logged.
 */
export type CallLogLevel = 'info' | 'warn' | 'error';

export interface CallLogger {
  log(level: CallLogLevel, event: string, fields: Record<string, unknown>): void;
}

/** Keeps the country prefix and the last four digits: +1••••••0123. */
export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '••••';
  return `${value.startsWith('+') ? '+' : ''}${digits.slice(0, 1)}${'•'.repeat(Math.max(digits.length - 5, 1))}${digits.slice(-4)}`;
}

export const consoleCallLogger: CallLogger = {
  log(level, event, fields) {
    console[level]('[call]', JSON.stringify({ event, ...fields }));
  },
};

/**
 * An error message that is safe to log: phone numbers masked (a provider's message often repeats the
 * number it was given) and the length bounded. Never includes credentials: only the message text is used.
 */
export function safeError(error: unknown): string {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : 'unknown';
  return message.replace(/\+?\d[\d\s().-]{6,}\d/g, (match) => maskPhone(match) ?? '••••').slice(0, 300);
}
