import twilio from 'twilio';
import type { MessagingInput, MessagingProvider } from './provider.js';

export class TwilioMessagingProvider implements MessagingProvider {
  readonly name = 'twilio';
  private readonly client: ReturnType<typeof twilio>;

  constructor(
    accountSid: string,
    authToken: string,
    private readonly from: string,
  ) {
    this.client = twilio(accountSid, authToken);
  }

  async sendMessage(input: MessagingInput): Promise<{ providerMessageId: string }> {
    const message = await this.client.messages.create({
      to: input.to,
      from: this.from,
      body: input.body,
    });
    return { providerMessageId: message.sid };
  }
}
