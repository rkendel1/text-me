import twilio from 'twilio';
import type { MessagingInput, MessagingProvider, VerificationMessagingProvider } from './provider.js';

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

/** Sends onboarding verification through one A2P-registered Messaging Service sender pool. */
export class TwilioMessagingServiceProvider implements VerificationMessagingProvider {
  private readonly client: ReturnType<typeof twilio>;

  constructor(accountSid: string, authToken: string, private readonly messagingServiceSid: string) {
    this.client = twilio(accountSid, authToken);
  }

  async sendVerification(input: Omit<MessagingInput, 'from'>): Promise<{ providerMessageId: string }> {
    const message = await this.client.messages.create({
      to: input.to, messagingServiceSid: this.messagingServiceSid, body: input.body,
    });
    return { providerMessageId: message.sid };
  }
}
