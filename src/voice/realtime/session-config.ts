import { experimental_getRealtimeToolDefinitions, tool } from 'ai';
import { z } from 'zod';

import type { ConversationRuntime } from '../../domain/runtime.js';
import type { OwnerConfiguration } from '../../owner/configuration.js';
import type { RealtimeSessionConfig } from './connector.js';

/**
 * The assistant's product tools. The realtime tool loop is client-driven, so
 * these carry schemas only; the call bridge executes them.
 */
export const callTools = {
  note_caller: tool({
    description: "Record the caller's name and the reason for the call as soon as you learn them.",
    inputSchema: z.object({
      name: z.string().optional().describe("The caller's name as they gave it."),
      reason: z.string().optional().describe('Why they are calling, in a few words.'),
    }),
  }),
  get_owner_context: tool({
    description: "Get the owner's current context: how they like calls handled and the current time.",
    inputSchema: z.object({}),
  }),
  lookup_conversation: tool({
    description: 'Look up earlier conversations with this caller, when they refer to something from before.',
    inputSchema: z.object({}),
  }),
  ask_owner: tool({
    description: 'Ask the owner to decide something only they can decide. They answer from their phone, ' +
      'usually within moments; keep the caller company meanwhile and relay the answer when it arrives.',
    inputSchema: z.object({
      question: z.string().describe('What the owner needs to decide, in one short sentence.'),
      suggestedReplies: z.array(z.string()).max(3).optional()
        .describe('Up to three short answers the owner is likely to give, in their voice, e.g. "Friday at 2 works".'),
    }),
  }),
  transition_to_text: tool({
    description: 'Continue this conversation by text message, after the caller has clearly agreed to be texted ' +
      'at the number they are calling from.',
    inputSchema: z.object({
      callerName: z.string().optional().describe("The caller's first name, if known."),
    }),
  }),
  end_call: tool({
    description: 'Hang up after you have said goodbye and the caller has nothing else to add.',
    inputSchema: z.object({
      reason: z.string().describe('Short reason the call is ending.'),
    }),
  }),
};

export type CallToolName = keyof typeof callTools;

const styleGuidance: Record<ConversationRuntime['responseStyle'], string> = {
  concise: 'Be brief and to the point.',
  friendly: 'Be warm and personable.',
  professional: 'Be polished and courteous.',
  custom: 'Follow the owner\'s instructions for tone.',
};

const verbosityGuidance: Record<ConversationRuntime['verbosity'], string> = {
  short: 'Keep every reply to one short sentence where you can.',
  normal: 'Keep replies to a sentence or two.',
  detailed: 'Give fuller answers when they genuinely help the caller.',
};

function escalationGuidance(runtime: ConversationRuntime, owner: string): string {
  if (runtime.aiMode === 'owner_only') {
    return `${owner} has taken over this conversation. Do not answer the caller on your own. ` +
      `Only speak when you are asked to relay ${owner}'s words.`;
  }
  const when: Record<ConversationRuntime['askOwnerWhen'], string> = {
    never: `Handle everything yourself; only use ask_owner if the caller insists on ${owner}.`,
    uncertain: `Use ask_owner whenever you are not sure how ${owner} would want something handled.`,
    important: `Use ask_owner before anything important: money, commitments, schedule changes, or urgent matters.`,
    always: `Use ask_owner for every request that needs an answer from ${owner}.`,
  };
  const askMe = runtime.aiMode === 'owner_assist'
    ? `Ask-me mode is on: keep the conversation going, but check with ${owner} (ask_owner) before any decision or answer on their behalf. `
    : '';
  return askMe + when[runtime.askOwnerWhen];
}

/**
 * Instructions for the assistant: understand, resolve, escalate. The same
 * behavior drives the phone call and the text conversation it may become.
 */
export function buildInstructions(
  runtime: ConversationRuntime,
  configuration: OwnerConfiguration,
  channel: 'voice' | 'text' = 'voice',
): string {
  const { assistant, calls } = configuration;
  const owner = assistant.ownerName || 'the owner';
  const identity = [
    calls.collectCallerName ? 'who you are speaking with ("Who am I speaking with?")' : '',
    calls.collectReason ? 'why they are calling' : '',
  ].filter(Boolean);
  const lines = [
    assistant.assistantName && assistant.assistantName !== 'Assistant' ? `Your name is ${assistant.assistantName}.` : '',
    channel === 'voice'
      ? `You are ${owner}'s assistant, answering ${owner}'s phone. Open with exactly: "${assistant.greeting}" and then listen.`
      : `You are ${owner}'s assistant, continuing a conversation with the caller by text message (SMS).`,
    assistant.ownerIntroduction,
    'Your job is to understand, resolve, and escalate — in that order, in as few turns as possible.',
    identity.length
      ? `Find out ${identity.join(' and ')}, and record it with note_caller.`
      : 'Don\'t ask for the caller\'s name or reason unless they offer it; if they do, record it with note_caller.',
    'If you can handle the request yourself, do it. If the caller refers to an earlier conversation, use lookup_conversation.',
    `For appointment requests, always help: collect the purpose, preferred dates and times, and the caller's name and best callback number. ` +
      `Then check with ${owner} before confirming. Never refuse an appointment request just because you cannot access a calendar.`,
    `When ${owner} needs to decide, say "Let me check with ${owner}" and call ask_owner. ` +
      'Never leave the caller waiting in silence; when the answer comes, relay it naturally.',
    escalationGuidance(runtime, owner),
    styleGuidance[runtime.responseStyle],
    verbosityGuidance[runtime.verbosity],
    runtime.allowCommitments ? '' : `Never commit to anything on ${owner}'s behalf without asking them first.`,
    runtime.allowScheduling ? '' : 'Do not book, move or confirm appointments yourself; ask the owner instead.',
    runtime.allowCallerFollowups ? '' : 'Do not promise that anyone will follow up.',
    channel === 'voice'
      ? 'Speak like a person on the phone: no lists, markdown, disclaimers or menus. Never mention being an AI unless asked, ' +
        'and never mention transcripts, models, tools or system status.'
      : 'Write plain, friendly text messages under 300 characters. No markdown.',
    channel === 'voice' && runtime.smsTransitionEnabled
      ? `${owner} prefers text. When it fits, offer to continue by text at this number; ` +
        (calls.requireSmsConsent
          ? 'only after the caller clearly says yes, '
          : 'if the caller would rather text, ') +
        'call transition_to_text, tell them a text is on its way, and say goodbye.'
      : '',
    runtime.customInstructions ? `Instructions from ${owner} for this conversation: ${runtime.customInstructions}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** The instruction used when the owner answers: the assistant relays it, it does not read it out verbatim. */
export function relayInstructions(ownerName: string, ownerText: string): string {
  const owner = ownerName || 'The owner';
  return `${owner} just replied: "${ownerText.replace(/"/g, "'")}". Relay this to the caller now, briefly and naturally, ` +
    `in your own words (for example "${owner} says…"). Do not add anything ${owner} did not say, then listen.`;
}

export async function buildSessionConfig(
  runtime: ConversationRuntime,
  configuration: OwnerConfiguration,
  voice?: string,
): Promise<RealtimeSessionConfig> {
  // Twilio Media Streams carry 8 kHz G.711 mu-law both ways, so no resampling is needed.
  const telephonyAudio = { type: 'audio/pcmu', rate: 8000 };
  return {
    instructions: buildInstructions(runtime, configuration, 'voice'),
    ...(voice ? { voice } : {}),
    outputModalities: runtime.voiceEnabled ? ['audio'] : ['text'],
    inputAudioFormat: telephonyAudio,
    outputAudioFormat: telephonyAudio,
    ...(runtime.transcriptionEnabled ? { inputAudioTranscription: {} } : {}),
    outputAudioTranscription: {},
    turnDetection: { type: 'server-vad', silenceDurationMs: 600, prefixPaddingMs: 300 },
    tools: await experimental_getRealtimeToolDefinitions({ tools: callTools }),
  };
}
