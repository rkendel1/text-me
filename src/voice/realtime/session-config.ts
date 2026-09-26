import { experimental_getRealtimeToolDefinitions, tool } from 'ai';
import { z } from 'zod';

import type { ConversationRuntime } from '../../domain/runtime.js';
import type { OwnerConfiguration } from '../../owner/configuration.js';
import type { RealtimeSessionConfig } from './connector.js';

/**
 * Tools the voice agent can call. Execution happens in the call bridge (the
 * realtime tool loop is client-driven), so these carry schemas only.
 */
export const callTools = {
  ask_owner: tool({
    description: 'Flag the owner because the caller needs a decision or information only the owner can give. ' +
      'The owner is notified immediately in their control app.',
    inputSchema: z.object({
      question: z.string().describe('What the owner needs to decide or answer, in one sentence.'),
    }),
  }),
  continue_over_text: tool({
    description: 'Move this conversation to text messages after the caller has clearly agreed to be texted ' +
      'at the number they are calling from.',
    inputSchema: z.object({
      callerName: z.string().optional().describe("The caller's first name, if they shared it."),
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
  friendly: 'Be warm, upbeat and personable.',
  professional: 'Be polished, courteous and professional.',
  custom: 'Follow the custom instructions for tone.',
};

const verbosityGuidance: Record<ConversationRuntime['verbosity'], string> = {
  short: 'Keep every reply to one or two short sentences.',
  normal: 'Keep replies to a few sentences.',
  detailed: 'Give complete, detailed answers when helpful.',
};

const askOwnerGuidance: Record<ConversationRuntime['askOwnerWhen'], string> = {
  never: 'Handle the call yourself; do not use ask_owner.',
  uncertain: 'Use ask_owner whenever you are unsure how the owner would want something handled.',
  important: 'Use ask_owner for anything important: money, commitments, schedule changes, or urgent matters.',
  always: 'Use ask_owner for every substantive request before answering it.',
};

export function buildInstructions(runtime: ConversationRuntime, configuration: OwnerConfiguration): string {
  const { assistant } = configuration;
  const lines = [
    `You are ${assistant.assistantName}, answering a phone call on the owner's behalf.`,
    assistant.ownerIntroduction,
    `Open the call with: "${assistant.greeting}"`,
    'This is a live phone call: speak naturally, never use lists, markdown or emoji, and let the caller finish.',
    'Find out who is calling and why, then help or take a clear message.',
    styleGuidance[runtime.responseStyle],
    verbosityGuidance[runtime.verbosity],
    askOwnerGuidance[runtime.askOwnerWhen],
    runtime.allowCommitments ? '' : 'Never promise or commit to anything on the owner\'s behalf.',
    runtime.allowScheduling ? '' : 'Do not book, move or confirm any appointments; offer to pass the request along instead.',
    runtime.allowCallerFollowups ? '' : 'Do not promise that anyone will follow up.',
    runtime.smsTransitionEnabled
      ? 'The owner prefers text. When it fits, offer to continue by text at the number they are calling from; ' +
        'only after they agree, call continue_over_text and then say goodbye.'
      : 'Do not offer to continue over text.',
    runtime.customInstructions ? `Additional instructions from the owner: ${runtime.customInstructions}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function buildSessionConfig(
  runtime: ConversationRuntime,
  configuration: OwnerConfiguration,
  voice?: string,
): Promise<RealtimeSessionConfig> {
  // Twilio Media Streams carry 8 kHz G.711 mu-law both ways, so no resampling is needed.
  const telephonyAudio = { type: 'audio/pcmu', rate: 8000 };
  return {
    instructions: buildInstructions(runtime, configuration),
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
