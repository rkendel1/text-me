import twilio from 'twilio';

export interface PhoneNumberRecord {
  sid: string;
  phoneNumber: string;
  voiceUrl: string | null;
  smsUrl: string | null;
  statusCallback: string | null;
}

export interface PhoneNumberClient {
  find(phoneNumber: string): Promise<PhoneNumberRecord | null>;
  /** Numbers in the account, so the assistant line needn't be configured. */
  list(): Promise<PhoneNumberRecord[]>;
  update(sid: string, urls: { voiceUrl: string; smsUrl: string; statusCallback: string }): Promise<PhoneNumberRecord>;
}

export class TwilioPhoneNumberClient implements PhoneNumberClient {
  private readonly client: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
  }

  async find(phoneNumber: string): Promise<PhoneNumberRecord | null> {
    const [number] = await this.client.incomingPhoneNumbers.list({ phoneNumber, limit: 1 });
    return number ? {
      sid: number.sid, phoneNumber: number.phoneNumber, voiceUrl: number.voiceUrl ?? null,
      smsUrl: number.smsUrl ?? null, statusCallback: number.statusCallback ?? null,
    } : null;
  }

  async list(): Promise<PhoneNumberRecord[]> {
    const numbers = await this.client.incomingPhoneNumbers.list({ limit: 20 });
    return numbers.map((number) => ({
      sid: number.sid, phoneNumber: number.phoneNumber, voiceUrl: number.voiceUrl ?? null,
      smsUrl: number.smsUrl ?? null, statusCallback: number.statusCallback ?? null,
    }));
  }

  async update(sid: string, urls: { voiceUrl: string; smsUrl: string; statusCallback: string }): Promise<PhoneNumberRecord> {
    const number = await this.client.incomingPhoneNumbers(sid).update({
      voiceUrl: urls.voiceUrl, voiceMethod: 'POST',
      smsUrl: urls.smsUrl, smsMethod: 'POST',
      statusCallback: urls.statusCallback, statusCallbackMethod: 'POST',
    });
    return {
      sid: number.sid, phoneNumber: number.phoneNumber, voiceUrl: number.voiceUrl ?? null,
      smsUrl: number.smsUrl ?? null, statusCallback: number.statusCallback ?? null,
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

/**
 * The phone side. The owner keeps their real number; calls they don't take are
 * forwarded by their carrier to the assistant line, a number in the Twilio
 * account that callers never see. "Connect" points that line at this
 * deployment so nobody pastes webhook URLs into a provider console.
 */
export class PhoneNumberService {
  private resolved?: Promise<PhoneNumberRecord>;

  constructor(
    private readonly client: PhoneNumberClient,
    /** Optional: without it, the account's only number is used. */
    private readonly configuredLine: string | undefined,
    private readonly publicBaseUrl: string,
    /** The owner's real number, which forwards to the assistant line. */
    readonly ownerNumber?: string,
  ) {}

  private urls() {
    return {
      voiceUrl: `${this.publicBaseUrl}/webhooks/twilio/voice`,
      smsUrl: `${this.publicBaseUrl}/webhooks/twilio/sms`,
      statusCallback: `${this.publicBaseUrl}/webhooks/twilio/status`,
    };
  }

  /** Which number is the assistant line; cached. Its settings are always read fresh. */
  private resolve(): Promise<PhoneNumberRecord> {
    this.resolved ??= (async () => {
      if (this.configuredLine) {
        const number = await this.client.find(this.configuredLine);
        if (!number) throw new Error(`${this.configuredLine} isn’t in this Twilio account`);
        return number;
      }
      const numbers = await this.client.list();
      if (numbers.length === 1) return numbers[0];
      if (!numbers.length) {
        throw new Error('Your Twilio account has no phone number yet. Add any local number: it stays behind the scenes as the line your calls forward to.');
      }
      throw new Error(`Your Twilio account has ${numbers.length} numbers. Set TWILIO_PHONE_NUMBER to the one your calls should forward to.`);
    })();
    this.resolved.catch(() => { this.resolved = undefined; });
    return this.resolved;
  }

  private async current(): Promise<PhoneNumberRecord> {
    const line = await this.resolve();
    const fresh = await this.client.find(line.phoneNumber);
    if (!fresh) {
      this.resolved = undefined;
      throw new Error(`${line.phoneNumber} is no longer in this Twilio account`);
    }
    return fresh;
  }

  /** The number outbound texts come from. */
  async assistantLine(): Promise<string> {
    return (await this.resolve()).phoneNumber;
  }

  async status(): Promise<{
    phoneNumber: string | null; assistantLine: string | null; ownerNumber: string | null;
    found: boolean; connected: boolean; error?: string; forwarding: ForwardingCode[];
  }> {
    try {
      const number = await this.current();
      const urls = this.urls();
      return {
        phoneNumber: number.phoneNumber,
        assistantLine: number.phoneNumber,
        ownerNumber: this.ownerNumber ?? null,
        found: true,
        connected: number.voiceUrl === urls.voiceUrl && number.smsUrl === urls.smsUrl,
        forwarding: forwardingCodes(number.phoneNumber),
      };
    } catch (error) {
      return {
        phoneNumber: null, assistantLine: null, ownerNumber: this.ownerNumber ?? null, found: false, connected: false,
        error: error instanceof Error ? error.message : 'Couldn’t find your assistant line', forwarding: [],
      };
    }
  }

  async connect(): Promise<{ phoneNumber: string; connected: boolean }> {
    const number = await this.current();
    await this.client.update(number.sid, this.urls());
    return { phoneNumber: number.phoneNumber, connected: true };
  }
}
