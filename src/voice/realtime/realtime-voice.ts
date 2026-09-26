import type { IncomingMessage, Server } from 'node:http';

import twilio from 'twilio';
import { WebSocketServer, type WebSocket } from 'ws';

import type { Conversation } from '../../domain/conversation.js';
import { RealtimeCallBridge, type CallBridgeServices, type CallOutcome } from './call-bridge.js';
import type { RealtimeConnector } from './connector.js';

export const MEDIA_STREAM_PATH = '/media-stream';

interface TwilioStreamMessage {
  event?: string;
  streamSid?: string;
  start?: { streamSid?: string; callSid?: string; customParameters?: Record<string, string> };
  media?: { payload?: string; track?: string };
  mark?: { name?: string };
}

/** Whether a realtime media stream is connected for this call, from the durable event log. */
export function realtimeVoiceStatus(conversation: Conversation): { live: boolean; outcome?: CallOutcome } {
  const last = [...conversation.events].reverse().find((event) =>
    (event.type === 'voice.started' || event.type === 'voice.completed') && event.payload.source === 'realtime');
  if (!last) return { live: false };
  if (last.type === 'voice.completed') return { live: false, outcome: last.payload.outcome as CallOutcome };
  return { live: conversation.status !== 'completed' };
}

/**
 * Realtime voice for phone calls through the Vercel AI Gateway.
 *
 * Each connected call subscribes to its conversation's runtime events, so the
 * owner's live controls reach the call from whichever instance served them.
 */
export class RealtimeVoiceService {
  private readonly bridges = new Map<string, RealtimeCallBridge>();
  private services?: CallBridgeServices;

  constructor(
    private readonly connector: RealtimeConnector,
    private readonly options: { voice?: string } = {},
  ) {}

  get modelId(): string {
    return this.connector.modelId;
  }

  bind(services: CallBridgeServices): void {
    this.services = services;
  }

  /** Calls connected to this instance (tests and diagnostics). */
  bridge(conversationId: string): RealtimeCallBridge | undefined {
    return this.bridges.get(conversationId);
  }

  /** Accept Twilio media streams on the HTTP server's upgrade path. */
  attach(
    server: Server,
    options: { twilioAuthToken?: string; publicBaseUrl?: string; beforeConnect?: Promise<void> } = {},
  ): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path !== MEDIA_STREAM_PATH) return;
      if (!this.verifyTwilioSignature(request, options)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      void (options.beforeConnect ?? Promise.resolve()).then(
        () => wss.handleUpgrade(request, socket, head, (ws) => this.handleConnection(ws)),
        () => socket.destroy(),
      );
    });
    return wss;
  }

  handleConnection(socket: WebSocket): void {
    let bridge: RealtimeCallBridge | undefined;
    socket.on('message', (data) => {
      let message: TwilioStreamMessage;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.event === 'start') {
        const conversationId = message.start?.customParameters?.conversationId;
        const streamSid = message.start?.streamSid ?? message.streamSid;
        if (!conversationId || !streamSid || !this.services) {
          socket.close();
          return;
        }
        const services = this.services;
        let unsubscribe = () => {};
        const starting = new RealtimeCallBridge(conversationId, this.connector, services, socket, {
          voice: this.options.voice,
          onCommandApplied: (commandId) => services.runtime.markCommandAppliedLive(commandId),
          onClosed: (closed) => {
            unsubscribe();
            if (this.bridges.get(closed.conversationId) === closed) this.bridges.delete(closed.conversationId);
          },
        });
        bridge = starting;
        this.bridges.set(conversationId, starting);
        unsubscribe = services.runtime.subscribe(conversationId, (event) => starting.handleRuntimeEvent(event));
        starting.start(streamSid, message.start?.callSid).catch(async (error) => {
          console.error(`[realtime ${conversationId}] could not start session`, error);
          // Detach first so the stream closing below isn't recorded as a normal hang-up.
          if (bridge === starting) bridge = undefined;
          unsubscribe();
          this.bridges.delete(conversationId);
          await services.repository.appendEvent(conversationId, 'voice.completed', {
            source: 'realtime', outcome: 'failed', error: error instanceof Error ? error.message : 'unknown',
          }, new Date()).catch(() => undefined);
          await services.conversations.raiseAttention(conversationId, {
            type: 'error',
            title: () => 'Your assistant needs attention',
            body: 'A call couldn’t be answered. The caller was asked to text instead.',
            dedupeKey: `error:voice:${conversationId}`,
          });
          socket.close();
        });
      } else if (message.event === 'media' && message.media?.payload && message.media.track !== 'outbound') {
        bridge?.handleCallerAudio(message.media.payload);
      } else if (message.event === 'mark' && message.mark?.name) {
        bridge?.handlePlaybackMark(message.mark.name);
      } else if (message.event === 'stop') {
        bridge?.handleStreamClosed();
      }
    });
    socket.on('close', () => bridge?.handleStreamClosed());
  }

  private verifyTwilioSignature(
    request: IncomingMessage,
    options: { twilioAuthToken?: string; publicBaseUrl?: string },
  ): boolean {
    if (!options.twilioAuthToken || !options.publicBaseUrl) return true;
    const signature = request.headers['x-twilio-signature'];
    if (typeof signature !== 'string') return false;
    const url = new URL(request.url ?? '/', options.publicBaseUrl.replace(/^http/, 'ws')).toString();
    return twilio.validateRequest(options.twilioAuthToken, signature, url, {});
  }
}
