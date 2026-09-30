import { createHash, randomInt } from 'node:crypto';

import twilio from 'twilio';

import { HttpError } from '../errors.js';
import type { MessagingProvider } from '../messaging/provider.js';
import type { VerificationMessagingProvider } from '../messaging/provider.js';
import type { PhoneVerificationProvider } from './verification.js';
import { createAuditEventId, createPhoneNumberId, E164, type PhoneNumber } from '../tenancy/model.js';
import { PhoneNumberTakenError, type TenancyStore } from '../tenancy/store.js';
import type { CallSessionService } from '../calls/service.js';
import { TwilioCallProvider } from './twilio-call-provider.js';

/** A number held in the platform's provider account (a platform resource until assigned to an account). */
export interface ProviderNumber {
  ref: string;
  phoneNumber: string;
  voiceUrl: string | null;
  smsUrl: string | null;
  statusCallback: string | null;
}

export interface PhoneNumberClient {
  readonly provider: string;
  find(phoneNumber: string): Promise<ProviderNumber | null>;
  /** Numbers in the platform's provider account. */
  list(): Promise<ProviderNumber[]>;
  update(ref: string, urls: { voiceUrl: string; smsUrl: string; statusCallback: string }): Promise<ProviderNumber>;
  /** Buy a new number into the platform account (optional; only when the platform allows it). */
  purchase?(options: { country: string; areaCode?: string }): Promise<ProviderNumber>;
  /** Place an automated verification call when SMS registration is unavailable. */
  callVerificationCode?(options: { from: string; to: string; code: string }): Promise<void>;
  /** Call the owner and connect the answered call to the real assistant webhook. */
  placeTestCall?(options: { from: string; to: string; url: string; statusCallback: string; humanOnly?: boolean }): Promise<{ id: string }>;
}

const fromTwilio = (number: { sid: string; phoneNumber: string; voiceUrl?: string | null; smsUrl?: string | null; statusCallback?: string | null }): ProviderNumber => ({
  ref: number.sid, phoneNumber: number.phoneNumber, voiceUrl: number.voiceUrl ?? null,
  smsUrl: number.smsUrl ?? null, statusCallback: number.statusCallback ?? null,
});

/** Twilio credentials are platform secrets; the numbers they hold are assigned to accounts in our database. */
export class TwilioPhoneNumberClient implements PhoneNumberClient {
  readonly provider = 'twilio';
  private readonly client: ReturnType<typeof twilio>;
  private readonly callProvider: TwilioCallProvider;

  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
    this.callProvider = new TwilioCallProvider(accountSid, authToken);
  }

  async find(phoneNumber: string): Promise<ProviderNumber | null> {
    const [number] = await this.client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
    return number ? fromTwilio(number) : null;
  }

  async list(): Promise<ProviderNumber[]> {
    return (await this.client.incomingPhoneNumbers.list({ limit: 200 })).map(fromTwilio);
  }

  async update(ref: string, urls: { voiceUrl: string; smsUrl: string; statusCallback: string }): Promise<ProviderNumber> {
    return fromTwilio(await this.client.incomingPhoneNumbers(ref).update({
      voiceUrl: urls.voiceUrl, voiceMethod: 'POST',
      smsUrl: urls.smsUrl, smsMethod: 'POST',
      statusCallback: urls.statusCallback, statusCallbackMethod: 'POST',
    }));
  }

  async purchase(options: { country: string; areaCode?: string }): Promise<ProviderNumber> {
    const [available] = await this.client.availablePhoneNumbers(options.country).local.list({
      ...(options.areaCode ? { areaCode: Number(options.areaCode) } : {}), smsEnabled: true, voiceEnabled: true, limit: 1,
    });
    if (!available) throw new Error('No numbers are available to buy right now.');
    return fromTwilio(await this.client.incomingPhoneNumbers.create({ phoneNumber: available.phoneNumber }));
  }

  async callVerificationCode(options: { from: string; to: string; code: string }): Promise<void> {
    const response = new twilio.twiml.VoiceResponse();
    const spoken = options.code.split('').join(', ');
    response.say(`Your Text Me verification code is ${spoken}. Again, ${spoken}.`);
    await this.callProvider.createCall({ from: options.from, to: options.to, inlineInstructions: response.toString() });
  }

  async placeTestCall(options: { from: string; to: string; url: string; statusCallback: string; humanOnly?: boolean }): Promise<{ id: string }> {
    // Human confirmation happens in the test-call TwiML. Twilio's answering-machine detection can
    // misclassify a real iPhone pickup and hang up on the owner before the assistant ever speaks.
    const { providerCallId } = await this.callProvider.createCall({
      from: options.from, to: options.to, answerUrl: options.url, statusUrl: options.statusCallback,
    });
    return { id: providerCallId };
  }
}

/** A provider stand-in for local development and tests: a pool of numbers, plus "buying" new ones. */
export class FakePhoneNumberClient implements PhoneNumberClient {
  readonly provider = 'fake';
  readonly verificationCalls: Array<{ from: string; to: string; code: string }> = [];
  readonly testCalls: Array<{ id: string; from: string; to: string; url: string; statusCallback: string; humanOnly?: boolean }> = [];
  private readonly numbers = new Map<string, ProviderNumber>();

  constructor(pool: string[] = [], private readonly purchasable = true) {
    for (const number of pool) this.add(number);
  }

  add(phoneNumber: string): ProviderNumber {
    const record = { ref: `PN${createHash('sha1').update(phoneNumber).digest('hex').slice(0, 30)}`, phoneNumber, voiceUrl: null, smsUrl: null, statusCallback: null };
    this.numbers.set(phoneNumber, record);
    return structuredClone(record);
  }

  async find(phoneNumber: string): Promise<ProviderNumber | null> {
    return structuredClone(this.numbers.get(phoneNumber) ?? null);
  }

  async list(): Promise<ProviderNumber[]> {
    return [...this.numbers.values()].map((number) => structuredClone(number));
  }

  async update(ref: string, urls: { voiceUrl: string; smsUrl: string; statusCallback: string }): Promise<ProviderNumber> {
    const number = [...this.numbers.values()].find((candidate) => candidate.ref === ref);
    if (!number) throw new Error('Unknown number');
    Object.assign(number, urls);
    return structuredClone(number);
  }

  async callVerificationCode(options: { from: string; to: string; code: string }): Promise<void> {
    this.verificationCalls.push(structuredClone(options));
  }

  async placeTestCall(options: { from: string; to: string; url: string; statusCallback: string; humanOnly?: boolean }): Promise<{ id: string }> {
    const call = { id: `CA${String(this.testCalls.length + 1).padStart(32, '0')}`, ...structuredClone(options) };
    this.testCalls.push(call);
    return { id: call.id };
  }

  get purchase(): PhoneNumberClient['purchase'] {
    if (!this.purchasable) return undefined;
    return async () => {
      // Random 555 numbers: several fake "providers" (instances, test runs) can share one database.
      let candidate: string;
      do { candidate = `+1555${String(randomInt(0, 10_000_000)).padStart(7, '0')}`; } while (this.numbers.has(candidate));
      return this.add(candidate);
    };
  }
}

export interface ForwardingCode {
  carrier: string;
  /** Dial this on the owner's phone to turn forwarding on. */
  enable: string;
  disable: string;
  detail: string;
}

/**
 * Codes that make the owner's own mobile number forward calls they don't take
 * to the assistant line. Callers keep dialing the owner's real number.
 */
export function forwardingCodes(assistantLine: string): ForwardingCode[] {
  const e164 = assistantLine.startsWith('+') ? assistantLine : `+${assistantLine}`;
  const codes: ForwardingCode[] = [{
    carrier: 'AT&T, T-Mobile and most carriers',
    enable: `**004*${e164}#`,
    disable: '##004#',
    detail: 'Forwards calls you don’t answer, decline, or can’t take (busy or no signal).',
  }];
  if (e164.startsWith('+1')) {
    codes.push({
      carrier: 'Verizon',
      enable: `*71${e164.slice(2)}`,
      disable: '*73',
      detail: 'Forwards calls you don’t answer or decline.',
    });
  }
  return codes;
}

export const VERIFICATION_TTL_MS = 10 * 60 * 1000;
export const MAX_VERIFICATION_ATTEMPTS = 5;

const codeHash = (numberId: string, code: string) => createHash('sha256').update(`${numberId}:${code}`).digest('hex');

export interface AccountPhoneStatus {
  assistantLine: PhoneNumber | null;
  personal: PhoneNumber | null;
  /** The assistant line's webhooks point at this deployment. */
  connected: boolean;
  forwarding: ForwardingCode[];
  error?: string;
}

/**
 * Phone numbers are account resources. The provider credentials are platform
 * secrets; which number belongs to which account lives in `phone_numbers`,
 * with a lifecycle of unconfigured → pending_verification → verified → active.
 *
 * - The assistant line is claimed from the platform's provider pool (or bought,
 *   when the platform allows it), verified against the provider, then activated
 *   by pointing its webhooks at this deployment. Calls to it resolve its account.
 * - The personal number (the owner's real mobile) is verified by a code texted
 *   from the account's assistant line, and becomes active once the line is.
 */
export class PhoneNumberService {
  constructor(
    private readonly store: TenancyStore,
    private readonly client: PhoneNumberClient,
    private readonly publicBaseUrl: string,
    private readonly messaging: MessagingProvider | undefined,
    private readonly options: {
      allowPurchase?: boolean; allowSmsVerification?: boolean; country?: string; now?: () => number;
      verificationMessaging?: VerificationMessagingProvider;
      verification?: PhoneVerificationProvider;
    } = {},
  ) {}

  private calls?: CallSessionService;

  /** Gives the owner test call a CallSession lifecycle. Bound after construction: the call service resolves lines through this one. */
  bindCallSessions(calls: CallSessionService): void {
    this.calls = calls;
  }

  verificationChannels(): Array<'call' | 'sms'> {
    return [
      ...(this.client.callVerificationCode ? ['call' as const] : []),
      ...(this.options.verification || ((this.options.verificationMessaging || this.messaging) && this.options.allowSmsVerification !== false)
        ? ['sms' as const] : []),
    ];
  }

  private now(): Date {
    return new Date(this.options.now?.() ?? Date.now());
  }

  private urls() {
    return {
      voiceUrl: `${this.publicBaseUrl}/webhooks/twilio/voice`,
      smsUrl: `${this.publicBaseUrl}/webhooks/twilio/sms`,
      statusCallback: `${this.publicBaseUrl}/webhooks/twilio/status`,
    };
  }

  private async numbers(accountId: string) {
    const all = await this.store.listPhoneNumbers(accountId);
    const personal = all.filter((number) => number.kind === 'personal');
    const pending = personal.filter((number) => number.status === 'pending_verification')
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
    return {
      line: all.find((number) => number.kind === 'assistant_line') ?? null,
      // The number that is the owner's today (verified or active); a pending change doesn't replace it until verified.
      personal: personal.find((number) => number.status === 'verified' || number.status === 'active') ?? pending,
      pending,
    };
  }

  private async audit(accountId: string, type: string, detail: Record<string, unknown>, userId?: string) {
    await this.store.recordAudit({ id: createAuditEventId(), accountId, userId, type, detail, occurredAt: this.now() });
  }

  /** Which account a provider webhook is for. Only verified or active lines route calls. */
  resolveLine(number: string): Promise<PhoneNumber | null> {
    return this.store.findAssistantLine(number);
  }

  /** The number this account's texts come from; null until it has a line. */
  async assistantLine(accountId: string): Promise<string | null> {
    const { line } = await this.numbers(accountId);
    return line && (line.status === 'verified' || line.status === 'active') ? line.number : null;
  }

  /** The owner's verified personal number (their texts are replies; SMS fallback goes here). */
  async personalNumber(accountId: string): Promise<string | null> {
    const { personal } = await this.numbers(accountId);
    return personal && (personal.status === 'verified' || personal.status === 'active') ? personal.number : null;
  }

  async status(accountId: string): Promise<AccountPhoneStatus> {
    const { line, personal } = await this.numbers(accountId);
    if (!line) return { assistantLine: null, personal, connected: false, forwarding: [] };
    try {
      const fresh = await this.client.find(line.number);
      if (!fresh) return { assistantLine: line, personal, connected: false, forwarding: [], error: `${line.number} is no longer held by the provider` };
      const urls = this.urls();
      return {
        assistantLine: line, personal,
        connected: fresh.voiceUrl === urls.voiceUrl && fresh.smsUrl === urls.smsUrl,
        forwarding: forwardingCodes(line.number),
      };
    } catch (error) {
      return { assistantLine: line, personal, connected: false, forwarding: forwardingCodes(line.number), error: error instanceof Error ? error.message : 'Couldn’t reach the phone provider' };
    }
  }

  /**
   * Give the account an assistant line: reuse its own, else claim a free number
   * from the platform pool (the unique index makes two simultaneous claims of
   * one number impossible), else buy one if the platform allows it.
   */
  async claimAssistantLine(accountId: string, maxLines: number, userId?: string): Promise<PhoneNumber> {
    const { line } = await this.numbers(accountId);
    if (line) return line.status === 'active' ? line : this.activateLine(accountId, line);
    if (maxLines < 1) throw new HttpError(403, 'Your plan doesn’t include an assistant line.', 'entitlement');
    const assigned = new Set(await this.store.listAssignedLines());
    const free = (await this.client.list()).filter((number) => !assigned.has(number.phoneNumber));
    for (const candidate of free) {
      const claimed = await this.insertLine(accountId, candidate);
      if (claimed) {
        await this.audit(accountId, 'phone.line_claimed', { phoneNumberId: claimed.id, source: 'pool' }, userId);
        return this.activateLine(accountId, claimed);
      }
    }
    if (this.options.allowPurchase && this.client.purchase) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const bought = await this.client.purchase({ country: this.options.country ?? 'US' });
        const claimed = await this.insertLine(accountId, bought);
        if (!claimed) continue;
        await this.audit(accountId, 'phone.line_claimed', { phoneNumberId: claimed.id, source: 'purchase' }, userId);
        return this.activateLine(accountId, claimed);
      }
      throw new HttpError(409, 'That number was just taken. Try again.');
    }
    throw new HttpError(409, 'No assistant lines are available right now. Please try again later.', 'no_numbers_available');
  }

  /** Assign a specific provider number to an account (the legacy migration uses this for the existing line). */
  async adoptAssistantLine(accountId: string, number: string): Promise<PhoneNumber> {
    const { line } = await this.numbers(accountId);
    if (line && line.number === number) return line.status === 'active' ? line : this.activateLine(accountId, line);
    if (line) throw new HttpError(409, 'This account already has a different assistant line.');
    const found = await this.client.find(number);
    if (!found) throw new HttpError(404, `${number} isn’t held by the platform’s provider account`);
    const claimed = await this.insertLine(accountId, found);
    if (!claimed) throw new PhoneNumberTakenError(number);
    await this.audit(accountId, 'phone.line_claimed', { phoneNumberId: claimed.id, source: 'migration' });
    return this.activateLine(accountId, claimed);
  }

  private async insertLine(accountId: string, candidate: ProviderNumber): Promise<PhoneNumber | null> {
    const now = this.now();
    const record: PhoneNumber = {
      id: createPhoneNumberId(), accountId, kind: 'assistant_line', number: candidate.phoneNumber,
      status: 'pending_verification', provider: this.client.provider, providerRef: candidate.ref,
      verificationStatus: 'unverified', verificationAttempts: 0, createdAt: now, updatedAt: now,
    };
    try {
      await this.store.insertPhoneNumber(record);
      return record;
    } catch (error) {
      if (error instanceof PhoneNumberTakenError) return null;
      throw error;
    }
  }

  /** pending_verification → verified (the provider holds it) → active (it answers for this deployment). */
  private async activateLine(accountId: string, line: PhoneNumber): Promise<PhoneNumber> {
    const found = await this.client.find(line.number);
    if (!found) throw new HttpError(409, `${line.number} is no longer held by the provider`);
    let current = line;
    if (current.status === 'pending_verification') {
      current = (await this.store.updatePhoneNumber(accountId, line.id, {
        status: 'verified', verificationStatus: 'provider_verified', verifiedAt: this.now(), providerRef: found.ref,
      }))!;
    }
    await this.client.update(found.ref, this.urls());
    current = (await this.store.updatePhoneNumber(accountId, line.id, { status: 'active' }))!;
    await this.promotePersonal(accountId);
    return current;
  }

  /** Point the account's line at this deployment again (idempotent). */
  async connect(accountId: string): Promise<{ phoneNumber: string; connected: boolean }> {
    const { line } = await this.numbers(accountId);
    if (!line) throw new HttpError(409, 'This account doesn’t have an assistant line yet', 'no_assistant_line');
    const active = await this.activateLine(accountId, line);
    return { phoneNumber: active.number, connected: true };
  }

  /** Ring the owner's verified phone and run the answered call through the production assistant flow. */
  async placeTestCall(accountId: string, userId?: string): Promise<{ id: string; from: string; to: string }> {
    if (!this.client.placeTestCall) throw new HttpError(503, 'Test calls are not available with this phone provider.', 'test_call_unavailable');
    const { line, personal } = await this.numbers(accountId);
    if (!line || line.status !== 'active') throw new HttpError(409, 'Connect your assistant line before placing a test call.', 'no_assistant_line');
    if (!personal || personal.status !== 'active') throw new HttpError(409, 'Verify your mobile number before placing a test call.', 'no_personal_number');
    const url = new URL('/webhooks/twilio/voice/test', this.publicBaseUrl);
    url.searchParams.set('assistantLine', line.number);
    // The call exists in the domain before anything is dialed, and its lifecycle is tracked from here on.
    const session = await this.calls?.create({ accountId, ...(userId ? { principalId: userId } : {}) }, { direction: 'outbound', from: line.number, to: personal.number });
    if (session) await this.calls!.beginDial(session.id);
    let call: { id: string };
    try {
      call = await this.client.placeTestCall({
        from: line.number,
        to: personal.number,
        url: url.toString(),
        statusCallback: this.urls().statusCallback,
        humanOnly: true,
      });
    } catch (error) {
      if (session) await this.calls!.recordDialFailed(session.id, undefined, error);
      throw error;
    }
    if (session) await this.calls!.recordDialed(session.id, call.id);
    await this.audit(accountId, 'phone.test_call_started', { providerCallId: call.id, ...(session ? { callId: session.id } : {}), from: line.number, to: personal.number }, userId);
    return { id: call.id, from: line.number, to: personal.number };
  }

  /** Text a one-time code to the owner's number from the account's own assistant line. */
  async startPersonalVerification(accountId: string, rawNumber: string, userId?: string, channel: 'sms' | 'call' = 'sms'): Promise<PhoneNumber> {
    const trimmed = rawNumber.trim();
    const number = `${trimmed.startsWith('+') ? '+' : ''}${trimmed.replace(/\D/g, '')}`;
    if (!E164.test(number)) throw new HttpError(400, 'Enter your number in international format, e.g. +15551234567.');
    const from = await this.assistantLine(accountId);
    if (number === from || await this.store.findAssistantLine(number)) throw new HttpError(400, 'That’s an assistant line, not your personal number.');
    if (channel === 'sms' && !this.options.verification &&
        (!(this.options.verificationMessaging || (this.messaging && from)) || this.options.allowSmsVerification === false)) {
      throw new HttpError(503, 'Text verification is not available yet. Choose Call Me With a Code.', 'sms_verification_unavailable');
    }
    if (channel === 'call' && (!from || !this.client.callVerificationCode)) {
      throw new HttpError(503, 'Call verification isn’t available right now.', 'call_verification_unavailable');
    }
    const { personal, pending } = await this.numbers(accountId);
    if (personal && (personal.status === 'verified' || personal.status === 'active') && personal.number === number) return personal;
    const managed = channel === 'sms' ? this.options.verification : undefined;
    const code = managed ? undefined : String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = this.now();
    const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);
    let record: PhoneNumber;
    if (pending) {
      // A resend or a corrected number reuses the pending record; attempts start over with a new code.
      record = (await this.store.updatePhoneNumber(accountId, pending.id, {
        number, verificationStatus: 'code_sent', verificationAttempts: 0,
        verificationCodeHash: code ? codeHash(pending.id, code) : undefined, verificationExpiresAt: expiresAt,
      }))!;
    } else {
      // Changing a verified number: the old one stays the owner's until the new one is verified.
      const id = createPhoneNumberId();
      record = {
        id, accountId, kind: 'personal', number, status: 'pending_verification', provider: 'carrier',
        verificationStatus: 'code_sent', verificationAttempts: 0, ...(code ? { verificationCodeHash: codeHash(id, code) } : {}),
        verificationExpiresAt: expiresAt, createdAt: now, updatedAt: now,
      };
      await this.store.insertPhoneNumber(record);
    }
    if (managed) await managed.start(number, 'sms');
    else if (channel === 'call') await this.client.callVerificationCode!({ from: from!, to: number, code: code! });
    else if (this.options.verificationMessaging) await this.options.verificationMessaging.sendVerification({
      to: number, body: `Your Text Me code is ${code}. It expires in 10 minutes.`, idempotencyKey: `verify:${record.id}:${code}`,
    });
    else await this.messaging!.sendMessage({ from: from!, to: number,
      body: `Your Text Me code is ${code}. It expires in 10 minutes.`, idempotencyKey: `verify:${record.id}:${code}` });
    await this.audit(accountId, 'phone.verification_sent', { phoneNumberId: record.id, channel }, userId);
    return record;
  }

  async confirmPersonalVerification(accountId: string, code: string, userId?: string): Promise<PhoneNumber> {
    const pending = (await this.store.listPhoneNumbers(accountId))
      .filter((number) => number.kind === 'personal' && number.status === 'pending_verification')
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
    if (!pending) throw new HttpError(409, 'Ask for a new code first.', 'no_pending_verification');
    if (pending.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) throw new HttpError(429, 'Too many tries. Ask for a new code.', 'verification_locked');
    if (!pending.verificationExpiresAt || pending.verificationExpiresAt.getTime() <= this.now().getTime()) {
      throw new HttpError(410, 'That code expired. Ask for a new one.', 'verification_expired');
    }
    const supplied = String(code).trim();
    const approved = pending.verificationCodeHash
      ? codeHash(pending.id, supplied) === pending.verificationCodeHash
      : this.options.verification ? await this.options.verification.check(pending.number, supplied) : false;
    if (!approved) {
      await this.store.updatePhoneNumber(accountId, pending.id, { verificationAttempts: pending.verificationAttempts + 1 });
      throw new HttpError(400, 'That code isn’t right.', 'verification_mismatch');
    }
    let verified: PhoneNumber;
    try {
      verified = (await this.store.updatePhoneNumber(accountId, pending.id, {
        status: 'verified', verificationStatus: 'verified', verifiedAt: this.now(), verificationCodeHash: undefined, verificationExpiresAt: undefined,
      }))!;
    } catch (error) {
      if (error instanceof PhoneNumberTakenError) throw new HttpError(409, 'That number is already verified on another account.', 'number_taken');
      throw error;
    }
    // The previous personal number (if any) is released only now.
    for (const other of await this.store.listPhoneNumbers(accountId)) {
      if (other.kind === 'personal' && other.id !== verified.id) await this.store.updatePhoneNumber(accountId, other.id, { status: 'released' });
    }
    await this.audit(accountId, 'phone.verified', { phoneNumberId: verified.id, method: 'sms_code' }, userId);
    return (await this.promotePersonal(accountId)) ?? verified;
  }

  /** The legacy migration attests the previously configured owner number (it was set by the operator). */
  async attestPersonalNumber(accountId: string, number: string): Promise<PhoneNumber> {
    if (!E164.test(number)) throw new HttpError(400, 'The personal number must be E.164');
    const { personal } = await this.numbers(accountId);
    if (personal && personal.number === number && (personal.status === 'verified' || personal.status === 'active')) return personal;
    const now = this.now();
    const record: PhoneNumber = {
      id: createPhoneNumberId(), accountId, kind: 'personal', number, status: 'verified', provider: 'carrier',
      verificationStatus: 'migrated', verificationAttempts: 0, verifiedAt: now, createdAt: now, updatedAt: now,
    };
    await this.store.insertPhoneNumber(record);
    await this.audit(accountId, 'phone.verified', { phoneNumberId: record.id, method: 'legacy_migration' });
    return (await this.promotePersonal(accountId)) ?? record;
  }

  /** A verified personal number becomes active once the account's line is active (forwarding has somewhere to go). */
  private async promotePersonal(accountId: string): Promise<PhoneNumber | null> {
    const { line, personal } = await this.numbers(accountId);
    if (!personal || personal.status !== 'verified' || line?.status !== 'active') return personal;
    return this.store.updatePhoneNumber(accountId, personal.id, { status: 'active' });
  }
}
