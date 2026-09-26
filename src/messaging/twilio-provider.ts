import twilio from 'twilio';
import type { MessagingInput, MessagingProvider } from './provider.js';

export class TwilioMessagingProvider implements MessagingProvider {
  readonly name = 'twilio';
  private readonly client: ReturnType<typeof twilio>;

  constructor(
    accountSid: string,
    authToken: string,
    /** The assistant line; resolved lazily when it isn't configured. */
    private readonly from: string | (() => Promise<string>),
  ) {
    this.client = twilio(accountSid, authToken);
  }

  async sendMessage(input: MessagingInput): Promise<{ providerMessageId: string }> {
    const message = await this.client.messages.create({
      to: input.to,
      from: typeof this.from === 'string' ? this.from : await this.from(),
      body: input.body,
    });
    return { providerMessageId: message.sid };
  }
}
