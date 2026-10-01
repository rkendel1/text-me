import type { CallCostLedger, LedgerCall } from '../../calls/cost/ledger.js';
import { extractRealtimeUsage } from './usage.js';
import type { ConversationRuntime, ConversationRuntimeEvent } from '../../domain/runtime.js';
import type { OwnerConfigurationService } from '../../owner/configuration.js';
import { presentConversationSummary } from '../../http/presenters.js';
import type { ConversationRepository } from '../../repositories/conversation-repository.js';
import type { RuntimeControlService } from '../../runtime/service.js';
import type { ConversationService } from '../../services/conversation-service.js';
import type { CallSessionService } from '../../calls/service.js';
import type {
  RealtimeConnection,
  RealtimeConnector,
  RealtimeServerEvent,
} from './connector.js';
import type { OwnerConfiguration } from '../../owner/configuration.js';
import { buildSessionConfig, outboundOpeningInstruction, relayInstructions, type CallContext, type CallToolName } from './session-config.js';

export interface CallBridgeServices {
  repository: ConversationRepository;
  runtime: RuntimeControlService;
  conversations: ConversationService;
  configuration: OwnerConfigurationService;
  /** The durable CallSessions. Optional so a bridge can run without them (and tests that don't need them). */
  calls?: CallSessionService;
  /** The cost ledger. Optional: accounting never gates a call, and a failure to record is logged, not surfaced. */
  usage?: CallCostLedger;
}

/** The server side of a Twilio bidirectional media stream. */
export interface MediaStreamSocket {
  send(data: string): void;
  close(): void;
}

export type CallOutcome = 'active' | 'ended' | 'failed';

const FAREWELL_TIMEOUT_MS = 10_000;

/**
 * Bridges one phone call's Twilio media stream to a realtime voice model.
 *
 * Caller audio (8 kHz mu-law) is forwarded to the model untouched and model
 * audio is streamed straight back. Transcripts and activity are written to the
 * conversation log and runtime, and the owner's live controls (pause, take
 * over, stop, settings) are applied to the running session.
 */
export class RealtimeCallBridge {
  outcome: CallOutcome = 'active';

  private connection?: RealtimeConnection;
  private streamSid?: string;
  private runtimeSnapshot?: ConversationRuntime;
  private configuration?: OwnerConfiguration;
  private accountId?: string;
  /** Set only once the session is confirmed to be this conversation's. The stream never decides lifecycle; it reports it. */
  private callSessionId?: string;
  /** The verified session, for the ledger. */
  private ledgerCall?: LedgerCall;
  private streamStartedAt?: Date;
  /** What the verified CallSession says about this call: outbound calls are told so, and why. */
  private callContext?: CallContext;
  private paused = false;
  private closing = false;
  private hangupWhenIdle = false;
  private farewellTimer?: NodeJS.Timeout;
  /** Responses we asked for (greeting, owner speech, tool follow-ups) that must play even when the AI is not autonomous. */
  private requestedResponses = 0;
  private readonly allowedResponses = new Set<string>();
  private readonly audibleResponses = new Set<string>();
  private readonly transcriptDrafts = new Map<string, string>();
  private readonly toolOutputsPending = new Set<string>();
  private playing = false;
  private sequence = 1000;
  private tasks: Promise<void> = Promise.resolve();

  constructor(
    readonly conversationId: string,
    private readonly connector: RealtimeConnector,
    private readonly services: CallBridgeServices,
    private readonly socket: MediaStreamSocket,
    private readonly options: {
      voice?: string;
      /** The CallSession this media stream belongs to, from the stream's start parameters. Verified before use. */
      callSessionId?: string;
      onClosed?: (bridge: RealtimeCallBridge) => void;
      /** Called once an owner command has actually been applied to this live call. */
      onCommandApplied?: (commandId: string) => void | Promise<void>;
    } = {},
  ) {}

  async start(streamSid: string, callSid?: string): Promise<void> {
    this.streamSid = streamSid;
    this.streamStartedAt = new Date();
    const conversation = await this.services.repository.getById(this.conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${this.conversationId}`);
    if (!conversation.accountId) throw new Error(`Conversation ${this.conversationId} has no account`);
    // The call runs as its conversation's account: its settings, its owner's name, its commands only.
    this.accountId = conversation.accountId;
    await this.attachCallSession(conversation.accountId);
    const runtime = await this.services.runtime.getRuntimeForConversation(conversation);
    const configuration = await this.services.configuration.get(conversation.accountId);
    this.runtimeSnapshot = runtime;
    this.configuration = configuration;
    this.paused = runtime.state === 'paused' || runtime.state === 'stopped' || !runtime.assistantEnabled;
    this.sequence = conversation.events.length + 1000;
    this.connection = await this.connector.connect(
      await buildSessionConfig(runtime, configuration, this.options.voice, this.callContext),
      {
        onEvent: (event) => this.onModelEvent(event),
        onClose: (reason) => this.onModelClosed(reason),
      },
    );
    await this.services.repository.appendEvent(this.conversationId, 'voice.started', {
      source: 'realtime',
      model: this.connector.modelId,
      streamSid,
      ...(callSid ? { callSid } : {}),
    }, new Date());
    if (!this.paused && runtime.aiMode !== 'owner_only') {
      await this.requestResponse(this.callContext?.direction === 'outbound'
        ? outboundOpeningInstruction(configuration.assistant.ownerName)
        : `Greet the caller now with: "${configuration.assistant.greeting}"`);
    }
  }

  /** The stream's callSessionId is a claim: it counts only if that session is this conversation's, in this account. */
  private async attachCallSession(accountId: string): Promise<void> {
    const { calls } = this.services;
    const claimed = this.options.callSessionId;
    if (!calls || !claimed) return;
    const session = await calls.get(accountId, claimed).catch(() => null);
    if (!session || session.conversationId !== this.conversationId) {
      console.error(`[call ${this.conversationId}] ignored a media stream claiming a call session that is not this call's`);
      return;
    }
    this.callSessionId = session.id;
    this.ledgerCall = session;
    this.callContext = { direction: session.direction, objective: session.objective };
    await calls.markInProgress(session.id);
  }

  // ----- Twilio side -----

  handleCallerAudio(payload: string): void {
    if (this.paused || this.closing || !this.connection) return;
    void this.connection.send({ type: 'input-audio-append', audio: payload });
  }

  handlePlaybackMark(name: string): void {
    if (!name.startsWith('response:')) return;
    this.playing = false;
    this.enqueue(() => this.services.runtime.noteVoiceStopped(this.conversationId, name.slice(9)));
    if (this.hangupWhenIdle) this.hangUp();
  }

  handleStreamClosed(): void {
    this.shutdown('ended');
  }

  // ----- Owner controls (runtime events, from any instance) -----

  handleRuntimeEvent(event: ConversationRuntimeEvent): void {
    if (event.conversationId !== this.conversationId) return;
    // A command is a job carrying its account; one for any other account is never applied to this call.
    if (typeof event.payload.accountId === 'string' && event.payload.accountId !== this.accountId) {
      console.error(`[call ${this.conversationId}] ignored a command for another account`);
      return;
    }
    const commandId = typeof event.payload.commandId === 'string' ? event.payload.commandId : undefined;
    const applied = () => {
      if (commandId) this.enqueue(async () => this.options.onCommandApplied?.(commandId));
    };
    switch (event.type) {
      case 'runtime.paused':
        this.pause();
        applied();
        return;
      case 'runtime.stopped':
        this.enqueue(() => this.stop());
        applied();
        return;
      case 'runtime.interrupted':
        this.interrupt();
        applied();
        return;
      case 'runtime.owner_speech':
        if (typeof event.payload.text === 'string') {
          const text = event.payload.text;
          this.enqueue(() => this.speak(text));
          applied();
        }
        return;
      case 'runtime.started':
      case 'runtime.resumed':
      case 'runtime.takeover':
      case 'runtime.returned_to_assistant':
      case 'runtime.configuration_changed':
        this.enqueue(() => this.refresh());
        applied();
        return;
      default:
        return;
    }
  }

  private async refresh(): Promise<void> {
    const conversation = await this.services.repository.getById(this.conversationId);
    if (!conversation || this.closing) return;
    await this.update(await this.services.runtime.getRuntimeForConversation(conversation));
  }

  pause(): void {
    this.paused = true;
    this.silence();
  }

  resume(): void {
    this.paused = false;
  }

  interrupt(): void {
    this.silence();
  }

  /** Owner stopped the assistant: say a short goodbye, then end the call. */
  async stop(): Promise<void> {
    this.silence();
    this.paused = true;
    this.hangupWhenIdle = true;
    await this.requestResponse(
      'The owner has ended this call. In one short sentence, tell the caller the owner will follow up, then say goodbye.',
    );
    this.farewellTimer = setTimeout(() => this.hangUp(), FAREWELL_TIMEOUT_MS);
  }

  async update(runtime: ConversationRuntime): Promise<void> {
    const previous = this.runtimeSnapshot;
    this.runtimeSnapshot = runtime;
    this.paused = runtime.state === 'paused' || runtime.state === 'stopped' || !runtime.assistantEnabled;
    if (runtime.aiMode !== 'automatic' && previous?.aiMode === 'automatic') this.silence();
    if (!this.connection) return;
    if (!this.accountId) return;
    const configuration = await this.services.configuration.get(this.accountId);
    this.configuration = configuration;
    await this.connection.send({
      type: 'session-update',
      config: await buildSessionConfig(runtime, configuration, this.options.voice, this.callContext),
    });
  }

  /** Relay the owner's reply to the caller: the assistant mediates, it does not read it out verbatim. */
  async speak(text: string): Promise<void> {
    this.silence();
    await this.requestResponse(relayInstructions(this.configuration?.assistant.ownerName ?? '', text));
  }

  // ----- Model side -----

  private onModelEvent(event: RealtimeServerEvent): void {
    switch (event.type) {
      case 'speech-started':
        // Barge-in: the caller talking over the assistant cuts playback immediately.
        if (this.playing) this.silence();
        if (!this.paused) {
          this.enqueue(() => this.services.runtime.noteSpeechStarted(this.conversationId, event.itemId ?? 'caller'));
        }
        return;
      case 'input-transcription-completed':
        this.enqueue(() => this.recordCallerTurn(event.itemId, event.transcript));
        return;
      case 'response-created':
        this.onResponseCreated(event.responseId);
        return;
      case 'audio-delta':
        this.playAudio(event.responseId, event.delta);
        return;
      case 'audio-transcript-delta':
      case 'text-delta':
        if (this.allowedResponses.has(event.responseId)) {
          this.transcriptDrafts.set(event.itemId, (this.transcriptDrafts.get(event.itemId) ?? '') + event.delta);
        }
        return;
      case 'audio-transcript-done':
      case 'text-done': {
        if (!this.allowedResponses.has(event.responseId)) return;
        const text = ('transcript' in event ? event.transcript : 'text' in event ? event.text : undefined) ??
          this.transcriptDrafts.get(event.itemId) ?? '';
        this.transcriptDrafts.delete(event.itemId);
        this.enqueue(() => this.recordAssistantTurn(event.itemId, event.responseId, text));
        return;
      }
      case 'response-done':
        this.recordAiUsage(event.responseId, event.raw);
        this.onResponseDone(event.responseId);
        return;
      case 'function-call-arguments-done':
        this.enqueue(() => this.runTool(event.callId, event.name as CallToolName, event.arguments));
        return;
      case 'error':
        console.error(`[realtime ${this.conversationId}] ${event.code ?? 'error'}: ${event.message}`);
        return;
      case 'session-closed':
        this.onModelClosed(event.reason);
        return;
      default:
        return;
    }
  }

  private onResponseCreated(responseId: string): void {
    // "Ask me" mode keeps the assistant talking (it escalates via ask_owner); only takeover silences it.
    const autonomous = this.runtimeSnapshot?.aiMode !== 'owner_only' && !this.paused;
    if (this.requestedResponses > 0) {
      this.requestedResponses -= 1;
    } else if (!autonomous) {
      // The model auto-responds on every caller turn; while the owner is in
      // control (or the call is paused) those replies are cancelled unheard.
      void this.connection?.send({ type: 'response-cancel' });
      return;
    }
    this.allowedResponses.add(responseId);
    this.enqueue(() => this.services.runtime.noteAiStarted(this.conversationId, responseId));
  }

  /** Whatever the model reported for this response, whether or not it was played: the cost was incurred either way. */
  private recordAiUsage(responseId: string, raw: unknown): void {
    const { usage } = this.services;
    const call = this.ledgerCall;
    if (!usage || !call) return;
    const metrics = extractRealtimeUsage(raw);
    if (Object.keys(metrics).length === 0) return;
    this.enqueue(() => usage.recordAiUsage(call, { modelId: this.connector.modelId, responseId, metrics, metadata: { via: 'ai-gateway' } }));
  }

  private onResponseDone(responseId: string): void {
    if (!this.allowedResponses.has(responseId)) return;
    if (this.audibleResponses.has(responseId)) {
      // Twilio echoes this mark once the caller has actually heard the audio.
      this.sendToTwilio({ event: 'mark', streamSid: this.streamSid, mark: { name: `response:${responseId}` } });
    } else {
      this.enqueue(() => this.services.runtime.noteVoiceStopped(this.conversationId, responseId));
      if (this.hangupWhenIdle && this.toolOutputsPending.size === 0) this.hangUp();
    }
  }

  private playAudio(responseId: string, delta: string): void {
    if (!this.allowedResponses.has(responseId) || this.closing) return;
    if (!this.audibleResponses.has(responseId)) {
      this.audibleResponses.add(responseId);
      this.enqueue(() => this.services.runtime.noteVoiceStarted(this.conversationId, responseId, ''));
    }
    this.playing = true;
    this.sendToTwilio({ event: 'media', streamSid: this.streamSid, media: { payload: delta } });
  }

  private async recordCallerTurn(itemId: string, transcript: string): Promise<void> {
    const text = transcript.trim();
    if (!text || this.runtimeSnapshot?.transcriptionEnabled === false) {
      await this.services.runtime.noteVoiceStopped(this.conversationId, itemId);
      return;
    }
    await this.services.repository.appendEvent(this.conversationId, 'speech.transcript', {
      callbackId: itemId, speaker: 'caller', text, sequence: this.sequence++, source: 'realtime',
    }, new Date());
    await this.services.runtime.noteTranscript(this.conversationId, itemId, text);
    if (this.runtimeSnapshot?.aiMode === 'owner_only') {
      await this.services.runtime.noteOwnerNeeded(this.conversationId, itemId, text);
    }
  }

  private async recordAssistantTurn(itemId: string, responseId: string, transcript: string): Promise<void> {
    const text = transcript.trim();
    if (!text) return;
    await this.services.repository.appendEvent(this.conversationId, 'ai.response', {
      callbackId: itemId, responseId, speaker: 'assistant', text, sequence: this.sequence++, source: 'realtime',
    }, new Date());
    await this.services.runtime.noteAiCompleted(this.conversationId, responseId, text);
  }

  private async runTool(callId: string, name: CallToolName, rawArguments: string): Promise<void> {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(rawArguments || '{}');
    } catch {
      // Fall through with empty input; each tool validates what it needs.
    }
    this.toolOutputsPending.add(callId);
    const owner = this.configuration?.assistant.ownerName || 'the owner';
    const text = (key: string) => (typeof input[key] === 'string' && (input[key] as string).trim() ? (input[key] as string).trim() : undefined);
    let output: Record<string, unknown>;
    let activity: string | undefined;
    let followUp = true;
    try {
      if (name === 'note_caller') {
        const details = { ...(text('name') ? { name: text('name') } : {}), ...(text('reason') ? { reason: text('reason') } : {}) };
        await this.services.repository.appendEvent(this.conversationId, 'caller.identified', {
          ...details, callId, source: 'realtime',
        }, new Date());
        activity = ['Noted caller', details.name, details.reason && `— ${details.reason}`].filter(Boolean).join(' ');
        output = { status: 'noted' };
      } else if (name === 'get_owner_context') {
        output = {
          ownerName: owner,
          introduction: this.configuration?.assistant.ownerIntroduction,
          prefersText: this.runtimeSnapshot?.smsTransitionEnabled ?? false,
          currentTime: new Date().toString(),
        };
        activity = `Checked ${owner}'s preferences`;
      } else if (name === 'lookup_conversation') {
        const earlier = await this.services.conversations.priorConversations(this.conversationId);
        output = {
          earlierConversations: earlier.map((conversation) => {
            const summary = presentConversationSummary(conversation);
            return { when: conversation.startedAt.toISOString(), lastMessage: summary.preview, state: summary.state };
          }),
        };
        activity = earlier.length ? `Looked up ${earlier.length} earlier conversation${earlier.length === 1 ? '' : 's'}` : 'Looked for earlier conversations (none)';
      } else if (name === 'ask_owner') {
        const question = text('question') ?? 'The caller needs you.';
        const suggestedReplies = Array.isArray(input.suggestedReplies) ? input.suggestedReplies.map(String) : [];
        await this.services.conversations.requestOwner(this.conversationId, {
          question, suggestedReplies, source: 'realtime', callId,
        });
        await this.services.runtime.noteOwnerNeeded(this.conversationId, callId, question);
        activity = `Asked ${owner}: "${question}"`;
        output = { status: 'owner_notified', say: `Tell the caller you're checking with ${owner}; keep them company until the answer arrives.` };
      } else if (name === 'transition_to_text') {
        output = await this.continueOverText(text('callerName'));
        activity = output.status === 'texting' ? 'Moved the conversation to text' : 'Could not move to text';
      } else if (name === 'end_call') {
        this.hangupWhenIdle = true;
        this.farewellTimer ??= setTimeout(() => this.hangUp(), FAREWELL_TIMEOUT_MS);
        followUp = false;
        activity = 'Ended the call';
        output = { status: 'ending' };
      } else {
        output = { error: `Unknown tool: ${String(name)}` };
      }
    } catch (error) {
      output = { error: error instanceof Error ? error.message : 'Tool failed' };
    }
    if (activity) {
      await this.services.repository.appendEvent(this.conversationId, 'assistant.activity', {
        tool: name, summary: activity, callId, source: 'realtime',
      }, new Date());
    }
    await this.connection?.send({
      type: 'conversation-item-create',
      item: { type: 'function-call-output', callId, name, output: JSON.stringify(output) },
    });
    this.toolOutputsPending.delete(callId);
    if (followUp) {
      await this.requestResponse();
    } else if (!this.playing) {
      this.hangUp();
    }
  }

  private async continueOverText(callerName?: string): Promise<Record<string, unknown>> {
    if (this.runtimeSnapshot && !this.runtimeSnapshot.smsTransitionEnabled) {
      return { status: 'unavailable', say: 'Texting is not available for this call; take a message instead.' };
    }
    const conversation = await this.services.repository.getById(this.conversationId);
    if (!conversation) throw new Error('Conversation not found');
    await this.services.conversations.grantSmsConsent(this.conversationId, conversation.callerPhone, callerName);
    await this.services.conversations.convertToTextConversation(this.conversationId);
    return { status: 'texting', say: 'Tell the caller a text is on its way from this number, then say goodbye.' };
  }

  // ----- Helpers -----

  private async requestResponse(instructions?: string): Promise<void> {
    if (!this.connection) return;
    this.requestedResponses += 1;
    await this.connection.send({ type: 'response-create', ...(instructions ? { options: { instructions } } : {}) });
  }

  /** Stop anything the caller is hearing and cancel the in-flight response. */
  private silence(): void {
    if (this.playing) this.sendToTwilio({ event: 'clear', streamSid: this.streamSid });
    this.playing = false;
    this.allowedResponses.clear();
    void this.connection?.send({ type: 'response-cancel' });
  }

  private sendToTwilio(message: Record<string, unknown>): void {
    if (!this.streamSid) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // The call already hung up.
    }
  }

  private hangUp(): void {
    // Closing the stream makes Twilio continue with the TwiML after <Connect>.
    this.shutdown('ended');
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  private onModelClosed(reason: string): void {
    if (this.closing) return;
    console.error(`[realtime ${this.conversationId}] model session closed: ${reason}`);
    this.shutdown('failed');
    void this.services.conversations.raiseAttention(this.conversationId, {
      type: 'error',
      title: () => 'Your assistant needs attention',
      body: 'A call was cut off. The caller was asked to text instead.',
      dedupeKey: `error:voice:${this.conversationId}`,
    });
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }

  private shutdown(outcome: CallOutcome): void {
    if (this.closing) return;
    this.closing = true;
    this.outcome = outcome;
    clearTimeout(this.farewellTimer);
    this.connection?.close();
    const { usage } = this.services;
    const call = this.ledgerCall;
    const startedAt = this.streamStartedAt;
    const streamSid = this.streamSid;
    if (usage && call && startedAt && streamSid) {
      this.enqueue(() => usage.recordMediaStream(call, { streamSid, startedAt, seconds: (Date.now() - startedAt.getTime()) / 1000 }));
    }
    this.enqueue(async () => {
      await this.services.repository.appendEvent(this.conversationId, 'voice.completed', {
        source: 'realtime', outcome,
      }, new Date());
      // The CallSession records how the runtime's part ended; the provider's final callback completes it.
      if (outcome === 'failed') await this.services.calls?.markFailed(this.callSessionId, 'voice_runtime_failed');
      else await this.services.calls?.markEnding(this.callSessionId, 'media_stream_ended');
    });
    this.options.onClosed?.(this);
  }

  private enqueue(task: () => Promise<unknown>): void {
    this.tasks = this.tasks.then(task).then(() => undefined, (error) => {
      console.error(`[realtime ${this.conversationId}]`, error);
    });
  }

  /** Resolves once every queued transcript/runtime write has landed (used by tests). */
  settled(): Promise<void> {
    return this.tasks;
  }
}
