export type ConversationSpeaker = 'caller' | 'assistant' | 'owner';

export interface ConversationTurn {
  speaker: ConversationSpeaker;
  text: string;
  sequence: number;
}

export interface ConversationModel {
  readonly name: string;
  respond(history: ConversationTurn[]): Promise<string>;
}
