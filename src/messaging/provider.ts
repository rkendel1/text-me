export interface MessagingInput {
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
