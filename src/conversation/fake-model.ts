import type { ConversationModel, ConversationTurn } from './model.js';

export class FakeConversationModel implements ConversationModel {
  readonly name = 'fake';

  constructor(
    private readonly responses: string[] = [
      'Sure. What would you like to change about the meeting?',
      "I'll make sure they get that message. Is there anything else you'd like them to know?",
      "Got it. I'll pass that along. Thanks.",
    ],
  ) {}

  async respond(history: ConversationTurn[]): Promise<string> {
    const callerTurns = history.filter((turn) => turn.speaker === 'caller');
    return (
      this.responses[callerTurns.length - 1] ??
      'Thanks for letting me know. Is there anything else I can help with?'
    );
  }
}
