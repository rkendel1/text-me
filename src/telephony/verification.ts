import twilio from 'twilio';

export interface PhoneVerificationProvider {
  start(to: string, channel: 'sms'): Promise<void>;
  check(to: string, code: string): Promise<boolean>;
}

/** Twilio-managed OTP delivery: routing, sender compliance, expiry and abuse controls live in Verify. */
export class TwilioVerifyProvider implements PhoneVerificationProvider {
  private readonly client: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string, private readonly serviceSid: string) {
    this.client = twilio(accountSid, authToken);
  }

  async start(to: string): Promise<void> {
    await this.client.verify.v2.services(this.serviceSid).verifications.create({ to, channel: 'sms' });
  }

  async check(to: string, code: string): Promise<boolean> {
    try {
      const result = await this.client.verify.v2.services(this.serviceSid).verificationChecks.create({ to, code });
      return result.status === 'approved';
    } catch (error) {
      const status = (error as { status?: number }).status;
      const codeValue = (error as { code?: number }).code;
      if (status === 400 || status === 404 || codeValue === 20404) return false;
      throw error;
    }
  }
}

