export interface MessagingInput {
  /** The sending number: always the account's own assistant line, never a deployment-wide sender. */
  from: string;
  to: string;
  body: string;
  idempotencyKey: string;
}

export interface MessagingResult {
  providerMessageId: string;
}

export interface MessagingProvider {
  readonly name: string;
  sendMessage(input: MessagingInput): Promise<MessagingResult>;
}

/** Sends as an account: resolves that account's assistant line for every message. */
export interface AccountMessaging {
  send(accountId: string, input: Omit<MessagingInput, 'from'>): Promise<MessagingResult>;
}

export class AccountMessenger implements AccountMessaging {
  constructor(
    private readonly provider: MessagingProvider,
    private readonly lines: { assistantLine(accountId: string): Promise<string | null> },
  ) {}

  async send(accountId: string, input: Omit<MessagingInput, 'from'>): Promise<MessagingResult> {
    const from = await this.lines.assistantLine(accountId);
    if (!from) throw new Error('This account has no assistant line to text from yet');
    return this.provider.sendMessage({ ...input, from });
  }
}
