import type { ConversationRuntime, ConversationRuntimeEvent } from '../../domain/runtime.js';
import type { OwnerConfigurationService } from '../../owner/configuration.js';
import type { ConversationRepository } from '../../repositories/conversation-repository.js';
import type { RuntimeControlService } from '../../runtime/service.js';
import type { ConversationService } from '../../services/conversation-service.js';
import type {
  RealtimeConnection,
  RealtimeConnector,
  RealtimeServerEvent,
} from './connector.js';
import { buildSessionConfig, type CallToolName } from './session-config.js';

export interface CallBridgeServices {
  repository: ConversationRepository;
  runtime: RuntimeControlService;
  conversations: ConversationService;
  configuration: OwnerConfigurationService;
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
    private readonly options: { voice?: string; onClosed?: (bridge: RealtimeCallBridge) => void } = {},
  ) {}

  async start(streamSid: string): Promise<void> {
    this.streamSid = streamSid;
    const conversation = await this.services.repository.getById(this.conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${this.conversationId}`);
    const runtime = await this.services.runtime.getRuntimeForConversation(conversation);
    const configuration = await this.services.configuration.get(conversation.ownerId ?? 'owner');
    this.runtimeSnapshot = runtime;
    this.paused = runtime.state === 'paused' || runtime.state === 'stopped' || !runtime.assistantEnabled;
    this.sequence = conversation.events.length + 1000;
    this.connection = await this.connector.connect(
      await buildSessionConfig(runtime, configuration, this.options.voice),
      {
        onEvent: (event) => this.onModelEvent(event),
        onClose: (reason) => this.onModelClosed(reason),
      },
    );
    await this.services.repository.appendEvent(this.conversationId, 'voice.started', {
      source: 'realtime',
      model: this.connector.modelId,
      streamSid,
    }, new Date());
    if (!this.paused && runtime.aiMode === 'automatic') {
      await this.requestResponse(`Greet the caller now with: "${configuration.assistant.greeting}"`);
    }
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
    switch (event.type) {
      case 'runtime.paused':
        this.pause();
        return;
      case 'runtime.stopped':
        this.enqueue(() => this.stop());
        return;
      case 'runtime.interrupted':
        this.interrupt();
        return;
      case 'runtime.owner_speech':
        if (typeof event.payload.text === 'string') {
          const text = event.payload.text;
          this.enqueue(() => this.speak(text));
        }
        return;
      case 'runtime.started':
      case 'runtime.resumed':
      case 'runtime.takeover':
      case 'runtime.returned_to_assistant':
      case 'runtime.configuration_changed':
        this.enqueue(() => this.refresh());
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
    const conversation = await this.services.repository.getById(this.conversationId);
    const configuration = await this.services.configuration.get(conversation?.ownerId ?? 'owner');
    await this.connection.send({
      type: 'session-update',
      config: await buildSessionConfig(runtime, configuration, this.options.voice),
    });
  }

  /** Speak the owner's words into the call in the assistant's voice. */
  async speak(text: string): Promise<void> {
    this.silence();
    await this.requestResponse(
      `Say the following to the caller exactly as written, then stop and listen: "${text.replace(/"/g, "'")}"`,
    );
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
    const autonomous = this.runtimeSnapshot?.aiMode === 'automatic' && !this.paused;
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
    if (!text) {
      await this.services.runtime.noteVoiceStopped(this.conversationId, itemId);
      return;
    }
    await this.services.repository.appendEvent(this.conversationId, 'speech.transcript', {
      callbackId: itemId, speaker: 'caller', text, sequence: this.sequence++, source: 'realtime',
    }, new Date());
    await this.services.runtime.noteTranscript(this.conversationId, itemId, text);
    if (this.runtimeSnapshot?.aiMode !== 'automatic') {
      await this.services.runtime.noteOwnerNeeded(this.conversationId, itemId, text);
    }
  }

  private async recordAssistantTurn(itemId: string, responseId: string, transcript: string): Promise<void> {
    const text = transcript.trim();
    if (!text) return;
    await this.services.repository.appendEvent(this.conversationId, 'ai.response', {
      callbackId: itemId, speaker: 'assistant', text, sequence: this.sequence++, source: 'realtime',
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
    let output: Record<string, unknown>;
    let followUp = true;
    try {
      if (name === 'ask_owner') {
        const question = typeof input.question === 'string' ? input.question : 'The caller needs the owner.';
        await this.services.runtime.noteOwnerNeeded(this.conversationId, callId, question);
        output = { status: 'owner_notified', say: 'Let the caller know the owner has been notified and will respond shortly.' };
      } else if (name === 'continue_over_text') {
        output = await this.continueOverText(typeof input.callerName === 'string' ? input.callerName : undefined);
      } else if (name === 'end_call') {
        this.hangupWhenIdle = true;
        this.farewellTimer ??= setTimeout(() => this.hangUp(), FAREWELL_TIMEOUT_MS);
        followUp = false;
        output = { status: 'ending' };
      } else {
        output = { error: `Unknown tool: ${String(name)}` };
      }
    } catch (error) {
      output = { error: error instanceof Error ? error.message : 'Tool failed' };
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
    return { status: 'texting', say: 'Tell the caller they will get a text from this number now, then say goodbye.' };
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
    this.enqueue(async () => {
      await this.services.repository.appendEvent(this.conversationId, 'voice.completed', {
        source: 'realtime', outcome,
      }, new Date());
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
