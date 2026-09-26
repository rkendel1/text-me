export type ConversationSpeaker = 'caller' | 'assistant' | 'owner';

export interface ConversationTurn {
  speaker: ConversationSpeaker;
  text: string;
  sequence: number;
}

/** What the assistant knows about this conversation beyond its transcript. */
export interface ConversationModelContext {
  instructions?: string;
  ownerName?: string;
  /** Product tools the model may use while writing its reply. */
  tools?: {
    askOwner?(question: string, suggestedReplies: string[]): Promise<void>;
    noteCaller?(name?: string, reason?: string): Promise<void>;
  };
}

export interface ConversationModel {
  readonly name: string;
  respond(history: ConversationTurn[], context?: ConversationModelContext): Promise<string>;
}
