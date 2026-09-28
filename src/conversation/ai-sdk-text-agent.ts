import { generateText, isStepCount, tool, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';

import type { ConversationModel, ConversationModelContext, ConversationTurn } from './model.js';

const labels: Record<ConversationTurn['speaker'], string> = {
  caller: 'Caller',
  assistant: 'Assistant (you)',
  owner: 'Owner',
};

/**
 * The text side of the assistant, on AI SDK `generateText` through AI Gateway.
 *
 * It writes caller-facing SMS replies, relays the owner's answers in its own
 * words, and can escalate to the owner with the same tools as the voice agent.
 */
export class AiSdkTextAgent implements ConversationModel {
  readonly name = 'ai-sdk';

  constructor(private readonly model: LanguageModel) {}

  async respond(history: ConversationTurn[], context: ConversationModelContext = {}): Promise<string> {
    const owner = context.ownerName || 'the owner';
    const last = history[history.length - 1];
    const task = last?.speaker === 'owner'
      ? `${owner} just replied (the last "Owner" line). Relay that to the caller as a text message in your own words, ` +
        `e.g. "${owner} says…". Do not add anything ${owner} did not say.`
      : 'Write your next reply to the caller.';
    const transcript = history.map((turn) => `${labels[turn.speaker]}: ${turn.text}`).join('\n');

    const tools: ToolSet = {};
    if (context.tools?.askOwner && last?.speaker !== 'owner') {
      const askOwner = context.tools.askOwner;
      tools.ask_owner = tool({
        description: `Ask ${owner} to decide something only they can decide. Then tell the caller you are checking.`,
        inputSchema: z.object({
          question: z.string().describe(`What ${owner} needs to decide, in one short sentence.`),
          suggestedReplies: z.array(z.string()).max(3).optional().describe(`Short answers ${owner} is likely to give.`),
        }),
        execute: async ({ question, suggestedReplies }) => {
          await askOwner(question, suggestedReplies ?? []);
          return { status: 'owner_notified' };
        },
      });
    }
    if (context.tools?.noteCaller) {
      const noteCaller = context.tools.noteCaller;
      tools.note_caller = tool({
        description: "Record the caller's name and reason for contacting the owner.",
        inputSchema: z.object({ name: z.string().optional(), reason: z.string().optional() }),
        execute: async ({ name, reason }) => {
          await noteCaller(name, reason);
          return { status: 'noted' };
        },
      });
    }

    const { text } = await generateText({
      model: this.model,
      system: context.instructions ?? `You are ${owner}'s assistant, texting with a caller. Be brief and friendly.`,
      prompt: `Conversation so far:\n${transcript || '(nothing yet)'}\n\n${task}\nReply with only the message text.`,
      tools,
      stopWhen: isStepCount(4),
      maxOutputTokens: 400,
    });
    return text.trim() || `Let me check with ${owner} and get right back to you.`;
  }
}
