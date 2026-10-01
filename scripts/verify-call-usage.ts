/**
 * Read-only probe for verifying Twilio's per-call usage behavior against a real account.
 *
 *   TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=... npx tsx scripts/verify-call-usage.ts CA... [CA...]
 *
 * For each call SID it prints what `TwilioCallProvider.getCallUsage` would report, next to the raw fields it was
 * built from, and the age of the call, so that "when does `price` appear" and "can it change" can be observed by
 * running it repeatedly (it never places, changes or ends a call, and never prints credentials). Nothing here is
 * evidence until it has actually been run; see docs/call-cost-ledger.md for what has and has not been verified.
 */
import twilio from 'twilio';

import { TwilioCallProvider } from '../src/telephony/twilio-call-provider.js';

const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = process.env;
const calls = process.argv.slice(2);
if (!sid || !token || calls.length === 0) {
  console.error('Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN, and pass one or more call SIDs.');
  process.exit(2);
}

const client = twilio(sid, token);
const provider = new TwilioCallProvider(sid, token, { client });
for (const callSid of calls) {
  const call = await client.calls(callSid).fetch();
  const recordings = await client.calls(callSid).recordings.list({ limit: 50 });
  const ended = call.endTime ? Math.round((Date.now() - call.endTime.getTime()) / 60_000) : null;
  console.log(JSON.stringify({
    observedAt: new Date().toISOString(),
    callSid, status: call.status, direction: call.direction, minutesSinceEnd: ended,
    raw: { duration: call.duration, price: call.price, priceUnit: call.priceUnit, startTime: call.startTime, endTime: call.endTime },
    recordings: recordings.map((recording) => ({ sid: recording.sid, status: recording.status, duration: recording.duration, price: recording.price, priceUnit: recording.priceUnit })),
    normalized: await provider.getCallUsage(callSid),
  }, null, 2));
}
