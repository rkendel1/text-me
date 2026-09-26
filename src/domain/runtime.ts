export type InteractionState =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'waiting_for_owner'
  | 'paused'
  | 'stopped'
  | 'transferring'
  | 'text_active'
  | 'error';

export type InteractionControl =
  | 'start'
  | 'stop'
  | 'pause'
  | 'resume'
  | 'take_over'
  | 'return_to_assistant';

export type AIInteractionMode = 'automatic' | 'owner_assist' | 'owner_only';
export type AIResponseStyle = 'concise' | 'friendly' | 'professional' | 'custom';
export type AIVerbosity = 'short' | 'normal' | 'detailed';
export type AskOwnerWhen = 'never' | 'uncertain' | 'important' | 'always';

export interface AIInteractionConfig {
  enabled: boolean;
  mode: AIInteractionMode;
  responseStyle: AIResponseStyle;
  verbosity: AIVerbosity;
  askOwnerWhen: AskOwnerWhen;
  allowCommitments: boolean;
  allowScheduling: boolean;
  allowCallerFollowups: boolean;
  customInstructions?: string;
}

export interface ConversationRuntime {
  conversationId: string;
  state: InteractionState;
  assistantEnabled: boolean;
  voiceEnabled: boolean;
  transcriptionEnabled: boolean;
  aiMode: AIInteractionMode;
  responseStyle: AIResponseStyle;
  verbosity: AIVerbosity;
  askOwnerWhen: AskOwnerWhen;
  allowCommitments: boolean;
  allowScheduling: boolean;
  allowCallerFollowups: boolean;
  customInstructions?: string;
  smsTransitionEnabled: boolean;
  startedAt?: Date;
  pausedAt?: Date;
  stoppedAt?: Date;
  currentTurnId?: string;
  currentActivity?: string;
  configurationRevision: number;
  appliedRevision: number;
  /** Fields currently overridden for this conversation only (not persisted; derived on read). */
  overriddenFields?: RuntimeOverrideField[];
  updatedAt: Date;
}

export type RuntimeOverrideField =
  | 'assistantEnabled'
  | 'aiMode'
  | 'responseStyle'
  | 'verbosity'
  | 'askOwnerWhen'
  | 'allowCommitments'
  | 'allowScheduling'
  | 'allowCallerFollowups'
  | 'customInstructions'
  | 'voiceEnabled'
  | 'transcriptionEnabled'
  | 'smsTransitionEnabled';

export interface RuntimeOverride {
  conversationId: string;
  field: RuntimeOverrideField;
  value: unknown;
  createdAt: Date;
  expiresAt?: Date;
}

export type ConversationRuntimeEventType =
  | 'runtime.started'
  | 'runtime.stopped'
  | 'runtime.paused'
  | 'runtime.resumed'
  | 'runtime.takeover'
  | 'runtime.returned_to_assistant'
  | 'runtime.interrupted'
  | 'runtime.configuration_changed'
  | 'runtime.sms_transition_requested'
  | 'runtime.command_failed'
  | 'runtime.state_changed'
  | 'runtime.transcript_partial'
  | 'runtime.transcript_final'
  | 'runtime.ai_started'
  | 'runtime.ai_completed'
  | 'runtime.voice_started'
  | 'runtime.voice_stopped'
  | 'runtime.owner_needed'
  | 'runtime.owner_speech'
  | 'runtime.attention'
  | 'runtime.error';

export interface ConversationRuntimeEvent {
  id: string;
  conversationId: string;
  type: ConversationRuntimeEventType;
  payload: Record<string, unknown>;
  occurredAt: Date;
  durable: boolean;
}

export type RuntimeCommandInput = {
  commandId?: string;
  expectedRevision?: number;
};
