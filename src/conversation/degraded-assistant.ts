import type { ConversationModelContext, ConversationTurn } from './model.js';

const APPOINTMENT = /\b(appointment|book|booking|schedule|reschedule|meeting|consultation)\b/i;
const CALLBACK = /\b(call me|call back|callback|return my call|reach me)\b/i;

/**
 * Keeps a caller conversation useful when the configured language model is
 * temporarily unavailable. This is deliberately narrow: gather enough detail
 * for the owner instead of inventing an answer or ending the call.
 */
export async function degradedAssistantReply(
  history: ConversationTurn[],
  context: ConversationModelContext = {},
): Promise<string> {
  const owner = context.ownerName?.trim() || 'the account owner';
  const callerTurns = history.filter((turn) => turn.speaker === 'caller');
  const assistantTurns = history.filter((turn) => turn.speaker === 'assistant');
  const callerText = callerTurns.map((turn) => turn.text).join(' ');
  const lastCallerText = callerTurns.at(-1)?.text.trim() || '';
  const fallbackReplies = assistantTurns.filter((turn) =>
    /what (?:is the appointment|day|time)|may i have your name|pass (?:this|those details)|call you back/i.test(turn.text));

  if (APPOINTMENT.test(callerText)) {
    if (!fallbackReplies.some((turn) => /what (?:is the appointment|day|time)/i.test(turn.text))) {
      return 'Absolutely. What is the appointment for, and what day and time work best for you?';
    }
    if (!fallbackReplies.some((turn) => /may i have your name/i.test(turn.text))) {
      return `Thanks. May I have your name and the best number to reach you, so I can pass this to ${owner}?`;
    }
    await context.tools?.askOwner?.(
      `A caller wants an appointment. Their latest details: ${lastCallerText.slice(0, 240)}`,
      ['I’ll call them back', 'Ask for another time'],
    );
    return `Thank you. I have your details and I’m checking with ${owner} before confirming the appointment.`;
  }

  if (CALLBACK.test(callerText)) {
    if (callerTurns.length === 1) {
      return `Of course. What is your name, the best number to call you back, and what is this regarding?`;
    }
    await context.tools?.askOwner?.(
      `Please call this caller back. Their latest details: ${lastCallerText.slice(0, 240)}`,
      ['I’ll call them back'],
    );
    return `Thank you. I’ll make sure ${owner} gets your callback request and the details you provided.`;
  }

  if (callerTurns.length === 1) {
    return `I can take care of getting this to ${owner}. What is your name, and what would you like me to tell them?`;
  }
  await context.tools?.askOwner?.(
    `A caller needs help. Their latest message: ${lastCallerText.slice(0, 240)}`,
    ['I’ll follow up'],
  );
  return `Thank you. I’ve passed that along to ${owner}.`;
}
