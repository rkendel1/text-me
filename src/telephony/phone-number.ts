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

/**
 * The owner's phone number. "Connect" points the number at this deployment so
 * nobody has to paste webhook URLs into a provider console.
 */
export class PhoneNumberService {
  constructor(
    private readonly client: PhoneNumberClient,
    private readonly phoneNumber: string,
    private readonly publicBaseUrl: string,
  ) {}

  private urls() {
    return {
      voiceUrl: `${this.publicBaseUrl}/webhooks/twilio/voice`,
      smsUrl: `${this.publicBaseUrl}/webhooks/twilio/sms`,
      statusCallback: `${this.publicBaseUrl}/webhooks/twilio/status`,
    };
  }

  async status(): Promise<{ phoneNumber: string; found: boolean; connected: boolean }> {
    const number = await this.client.find(this.phoneNumber);
    const urls = this.urls();
    return {
      phoneNumber: this.phoneNumber,
      found: Boolean(number),
      connected: Boolean(number && number.voiceUrl === urls.voiceUrl && number.smsUrl === urls.smsUrl),
    };
  }

  async connect(): Promise<{ phoneNumber: string; connected: boolean }> {
    const number = await this.client.find(this.phoneNumber);
    if (!number) throw new Error(`${this.phoneNumber} isn't in this Twilio account`);
    await this.client.update(number.sid, this.urls());
    return { phoneNumber: this.phoneNumber, connected: true };
  }
}
