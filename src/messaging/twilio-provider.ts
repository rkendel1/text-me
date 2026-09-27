import twilio from 'twilio';
import type { MessagingInput, MessagingProvider } from './provider.js';

/** Platform credentials; each message is sent from the sending account's own assistant line. */
export class TwilioMessagingProvider implements MessagingProvider {
  readonly name = 'twilio';
  private readonly client: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string) {
    this.client = twilio(accountSid, authToken);
  }

  async sendMessage(input: MessagingInput): Promise<{ providerMessageId: string }> {
    const message = await this.client.messages.create({ to: input.to, from: input.from, body: input.body });
    return { providerMessageId: message.sid };
  }
}
