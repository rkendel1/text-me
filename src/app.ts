import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { toDataURL } from 'qrcode';

import { HttpError } from './errors.js';
import { presentConversation, presentConversationSummary } from './http/presenters.js';
import type { Conversation } from './domain/conversation.js';
import type { ConversationRepository } from './repositories/conversation-repository.js';
import { ConversationService } from './services/conversation-service.js';
import { FakeTelephonyProvider } from './telephony/fake-provider.js';
import type { TelephonyProvider } from './telephony/provider.js';
import { TwilioProvider } from './telephony/twilio-provider.js';
import { FakeConversationModel } from './conversation/fake-model.js';
import type { ConversationModel } from './conversation/model.js';
import { ConversationEngine } from './services/conversation-engine.js';
import { FakeSpeechProvider } from './speech/fake-provider.js';
import type { SpeechProvider } from './speech/provider.js';
import { FakeVoiceProvider } from './voice/fake-provider.js';
import type { VoiceProvider } from './voice/provider.js';
import type { MessagingProvider } from './messaging/provider.js';
import { FakeMessagingProvider } from './messaging/fake-provider.js';
import type { OwnerChannel } from './owner/channel.js';
import { OwnerDeviceService } from './owner/device.js';
import type { MacMessagesAdapter } from './owner/mac-messages-adapter.js';
import { OwnerConfigurationService, type OwnerConfigurationPatch } from './owner/configuration.js';
import { InMemoryOwnerMessageDeliveryStore, type OwnerMessageDeliveryStore } from './owner/delivery.js';
import { InProcessConversationRuntimeController, type ConversationRuntimeController } from './runtime/controller.js';
import { RuntimeControlService, type RuntimeConfigurationPatch } from './runtime/service.js';
import {
  InMemoryConversationRuntimeEventStore,
  InMemoryConversationRuntimeStore,
  InMemoryRuntimeOverrideStore,
  type ConversationRuntimeEventStore,
  type ConversationRuntimeStore,
  type RuntimeOverrideStore,
} from './runtime/store.js';
import twilio from 'twilio';
import type { RuntimeEventBus } from './runtime/event-bus.js';
import { realtimeVoiceStatus, type RealtimeVoiceService } from './voice/realtime/realtime-voice.js';
import { buildInstructions } from './voice/realtime/session-config.js';
import { OwnerReplyService } from './services/owner-reply.js';

export interface AppOptions {
  repository: ConversationRepository;
  providers?: TelephonyProvider[];
  includeFakeProviderRoutes?: boolean;
  speechProvider?: SpeechProvider;
  conversationModel?: ConversationModel;
  voiceProvider?: VoiceProvider;
  messagingProvider?: MessagingProvider;
  ownerPhone?: string;
  twilioAuthToken?: string;
  ownerId?: string;
  ownerAuthToken?: string;
  ownerChannel?: OwnerChannel;
  ownerDeviceService?: OwnerDeviceService;
  ownerMessagesAdapter?: MacMessagesAdapter;
  ownerConfigurationService?: OwnerConfigurationService;
  ownerDeliveryStore?: OwnerMessageDeliveryStore;
  qrCodeDataUrl?: (content: string) => Promise<string>;
  runtimeStore?: ConversationRuntimeStore;
  runtimeEventStore?: ConversationRuntimeEventStore;
  runtimeOverrideStore?: RuntimeOverrideStore;
  runtimeController?: ConversationRuntimeController;
  runtimeControlService?: RuntimeControlService;
  runtimeEventBus?: RuntimeEventBus;
  /** Answers phone calls with a realtime voice agent through the AI Gateway. */
  realtimeVoice?: RealtimeVoiceService;
  /** Resolved before any request is handled (e.g. lazy database setup on a cold start). */
  beforeRequest?: Promise<void>;
  /** Let the assistant answer caller texts itself (production, with the AI SDK text agent). */
  autoReplyToCallerTexts?: boolean;
}

function createProviderMap(
  providers: TelephonyProvider[],
): Map<string, TelephonyProvider> {
  return new Map(providers.map((provider) => [provider.name, provider]));
}

function registerIncomingCallRoute(
  app: express.Express,
  path: string,
  provider: TelephonyProvider,
  service: ConversationService,
): void {
  app.post(path, async (request, response, next) => {
    try {
      const incomingCall = provider.parseIncomingCall(request.body);
      const conversation = await service.incomingCall(incomingCall);
      const providerResponse = provider.answerCall(conversation);
      await service.answerCall(conversation.id, incomingCall.payload);
      response
        .status(200)
        .type(providerResponse.contentType)
        .send(providerResponse.body);
    } catch (error) {
      next(error);
    }
  });
}

function registerStatusRoute(
  app: express.Express,
  path: string,
  provider: TelephonyProvider,
  service: ConversationService,
): void {
  app.post(path, async (request, response, next) => {
    try {
      const statusUpdate = provider.parseStatusUpdate(request.body);
      const conversation = await service.updateCallStatus(statusUpdate);
      response.status(200).json(presentConversation(conversation));
    } catch (error) {
      next(error);
    }
  });
}

function presentRuntime(runtime: Awaited<ReturnType<RuntimeControlService['getRuntimeForConversation']>>) {
  return {
    ...runtime,
    revision: runtime.configurationRevision,
    startedAt: runtime.startedAt?.toISOString() ?? null,
    pausedAt: runtime.pausedAt?.toISOString() ?? null,
    stoppedAt: runtime.stoppedAt?.toISOString() ?? null,
    updatedAt: runtime.updatedAt.toISOString(),
    interaction: {
      enabled: runtime.assistantEnabled,
      mode: runtime.aiMode,
      responseStyle: runtime.responseStyle,
      verbosity: runtime.verbosity,
      askOwnerWhen: runtime.askOwnerWhen,
      allowCommitments: runtime.allowCommitments,
      allowScheduling: runtime.allowScheduling,
      allowCallerFollowups: runtime.allowCallerFollowups,
      customInstructions: runtime.customInstructions,
    },
  };
}

export function createApp(options: AppOptions): express.Express {
  const app = express();
  const providers = createProviderMap(
    options.providers ?? [new TwilioProvider(), new FakeTelephonyProvider()],
  );
  const messaging = options.messagingProvider ?? new FakeMessagingProvider();
  const ownerId = options.ownerId ?? process.env.OWNER_ID ?? 'owner';
  const ownerDevices = options.ownerDeviceService ?? new OwnerDeviceService();
  const ownerConfiguration = options.ownerConfigurationService ?? new OwnerConfigurationService();
  const ownerDeliveries = options.ownerDeliveryStore ?? new InMemoryOwnerMessageDeliveryStore();
  const runtime = options.runtimeControlService ?? new RuntimeControlService(
    options.repository,
    ownerConfiguration,
    options.runtimeStore ?? new InMemoryConversationRuntimeStore(),
    options.runtimeEventStore ?? new InMemoryConversationRuntimeEventStore(),
    options.runtimeOverrideStore ?? new InMemoryRuntimeOverrideStore(),
    options.runtimeController ?? new InProcessConversationRuntimeController(),
    options.runtimeEventBus,
  );
  const renderQrCode = options.qrCodeDataUrl ?? ((content: string) => toDataURL(content, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 256,
  }));
  const ownerDeviceRateLimit = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const service = new ConversationService(
    options.repository, messaging, options.ownerPhone, ownerId, options.ownerChannel,
  );
  const engine = new ConversationEngine(
    options.repository,
    options.speechProvider ?? new FakeSpeechProvider(),
    options.conversationModel ?? new FakeConversationModel(),
    options.voiceProvider ?? new FakeVoiceProvider(),
    messaging,
    runtime,
    {
      autoReplyToCallerTexts: options.autoReplyToCallerTexts ?? false,
      contextFor: async (conversationId) => {
        const conversation = await service.getConversation(conversationId);
        if (!conversation) return {};
        const configuration = await ownerConfiguration.get(conversation.ownerId ?? ownerId);
        const snapshot = await runtime.getRuntimeForConversation(conversation);
        return {
          instructions: buildInstructions(snapshot, configuration, 'text'),
          ownerName: configuration.assistant.ownerName,
          tools: {
            askOwner: async (question, suggestedReplies) => {
              const requestId = await service.requestOwner(conversationId, { question, suggestedReplies, source: 'sms' });
              await options.repository.appendEvent(conversationId, 'assistant.activity', {
                tool: 'ask_owner', summary: `Asked ${configuration.assistant.ownerName}: "${question}"`, requestId, source: 'sms',
              }, new Date());
              await runtime.noteOwnerNeeded(conversationId, requestId, question);
            },
            noteCaller: async (name, reason) => {
              await options.repository.appendEvent(conversationId, 'caller.identified', {
                ...(name ? { name } : {}), ...(reason ? { reason } : {}), source: 'sms',
              }, new Date());
            },
          },
        };
      },
    },
  );
  const ownerReplies = new OwnerReplyService(options.repository, service, engine, runtime, Boolean(options.realtimeVoice));
  const fakeRoutesEnabled = options.includeFakeProviderRoutes ?? true;
  const realtimeVoice = options.realtimeVoice;
  realtimeVoice?.bind({
    repository: options.repository,
    runtime,
    conversations: service,
    configuration: ownerConfiguration,
  });
  const presentVoice = (conversation: Conversation) => ({
    realtime: Boolean(realtimeVoice),
    model: realtimeVoice?.modelId ?? null,
    ...realtimeVoiceStatus(conversation),
  });

  if (options.beforeRequest) {
    const ready = options.beforeRequest;
    app.use((_request, _response, next) => {
      ready.then(() => next(), next);
    });
  }
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const ownerAuth = (request: Request, _response: Response, next: NextFunction): void => {
    if (!options.ownerAuthToken) {
      (request as Request & { ownerId?: string }).ownerId = ownerId;
      next();
      return;
    }
    const authorization = request.header('Authorization');
    const queryToken = typeof request.query?.token === 'string' ? request.query.token : undefined;
    if (authorization !== 'Bearer ' + options.ownerAuthToken && queryToken !== options.ownerAuthToken) {
      next(new HttpError(401, 'Authentication required'));
      return;
    }
    (request as Request & { ownerId?: string }).ownerId = ownerId;
    next();
  };

  if (options.twilioAuthToken) {
    app.use((request, _response, next) => {
      if (!request.path.startsWith('/webhooks/twilio/')) return next();
      const signature = request.header('X-Twilio-Signature');
      const url = `${request.protocol}://${request.get('host')}${request.originalUrl}`;
      if (!signature || !twilio.validateRequest(options.twilioAuthToken!, signature, url, request.body)) {
        next(new HttpError(403, 'Invalid webhook signature'));
        return;
      }
      next();
    });
  }

  const twilioProvider = providers.get('twilio');
  if (!twilioProvider) {
    throw new Error('Twilio provider is required');
  }

  registerIncomingCallRoute(app, '/webhooks/twilio/voice', twilioProvider, service);
  registerStatusRoute(app, '/webhooks/twilio/status', twilioProvider, service);

  // Twilio continues here once a realtime media stream ends.
  app.post('/webhooks/twilio/voice/continue', async (request, response, next) => {
    try {
      const conversationId = typeof request.query.conversationId === 'string' ? request.query.conversationId : '';
      const conversation = conversationId ? await service.getConversation(conversationId) : null;
      const twiml = new twilio.twiml.VoiceResponse();
      if (!conversation || realtimeVoiceStatus(conversation).outcome === 'failed') {
        twiml.say("Sorry, the assistant can't take your call right now. Please send a text to this number instead.");
      }
      twiml.hangup();
      response.type('text/xml; charset=utf-8').send(twiml.toString());
    } catch (error) {
      next(error);
    }
  });

  app.post('/webhooks/twilio/sms', async (request, response, next) => {
    try {
      if (!twilioProvider.parseIncomingSms) throw new HttpError(501, 'SMS is not supported');
      const message = twilioProvider.parseIncomingSms(request.body);
      if (options.ownerPhone && message.from === options.ownerPhone) {
        // The owner texted back: it answers whichever conversation is waiting on them.
        const target = await service.findConversationForOwnerReply();
        if (!target) throw new HttpError(404, 'No conversation is waiting for you');
        const conversation = await ownerReplies.reply({
          conversationId: target.id, ownerId, body: message.body,
          idempotencyKey: `sms:${message.providerMessageId}`, source: 'sms',
        });
        response.json(presentConversation(conversation));
        return;
      }
      const received = await service.receiveSms(message);
      const conversation = await engine.respondToCallerText(received.id, message.providerMessageId);
      response.json(presentConversation(conversation));
    } catch (error) {
      next(error);
    }
  });

  if (fakeRoutesEnabled) {
    const fake = providers.get('fake');
    if (fake) {
      registerIncomingCallRoute(app, '/webhooks/fake/voice', fake, service);
      registerStatusRoute(app, '/webhooks/fake/status', fake, service);
    }
  }

  app.post('/owner/devices/pair', ownerAuth, async (request, response, next) => {
    try {
      const result = await ownerDevices.pair(
        (request as Request & { ownerId?: string }).ownerId!,
        typeof request.body?.name === 'string' ? request.body.name : 'Mac Messages',
      );
      response.status(201).json({
        pairingUri: result.pairingUri,
        deviceId: result.device.id,
        device: {
          ...result.device,
          createdAt: result.device.createdAt.toISOString(),
          updatedAt: result.device.updatedAt.toISOString(),
        },
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/devices/pair/qr', ownerAuth, async (request, response, next) => {
    try {
      const result = await ownerDevices.pair(
        (request as Request & { ownerId?: string }).ownerId!,
        typeof request.body?.name === 'string' ? request.body.name : 'Mac Messages',
      );
      response.status(201).json({
        deviceId: result.device.id,
        pairingUri: result.pairingUri,
        qrDataUrl: await renderQrCode(result.pairingUri),
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/devices/:id/activate', async (request, response, next) => {
    try {
      const code = typeof request.body?.pairingCredential === 'string'
        ? request.body.pairingCredential.replace(/^attn:\/\/pair\//, '')
        : typeof request.body?.pairingCode === 'string' ? request.body.pairingCode : '';
      const result = await ownerDevices.activate(String(request.params.id), code);
      response.json({
        ...result,
        device: {
          ...result.device,
          createdAt: result.device.createdAt.toISOString(),
          updatedAt: result.device.updatedAt.toISOString(),
          lastSeenAt: result.device.lastSeenAt?.toISOString() ?? null,
        },
      });
    } catch (error) {
      next(new HttpError(401, error instanceof Error ? error.message : 'Pairing failed'));
    }
  });

  app.post('/owner/devices/activate', async (request, response, next) => {
    try {
      const credential = typeof request.body?.pairingCredential === 'string' ? request.body.pairingCredential : '';
      const result = await ownerDevices.activatePairing(credential);
      response.json({
        ...result,
        device: {
          ...result.device,
          createdAt: result.device.createdAt.toISOString(),
          updatedAt: result.device.updatedAt.toISOString(),
          lastSeenAt: result.device.lastSeenAt?.toISOString() ?? null,
        },
      });
    } catch (error) {
      next(new HttpError(401, error instanceof Error ? error.message : 'Pairing failed'));
    }
  });

  const deviceAuth = async (request: Request) => {
    const authorization = request.header('Authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const device = await ownerDevices.authenticate(token);
    if (!device || device.id !== String(request.params.id)) throw new HttpError(401, 'Device authentication required');
    return { device, token };
  };

  app.get('/owner/devices/:id/status', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      response.json({
        id: device.id,
        ownerId: device.ownerId,
        status: device.status,
        setupStatus: device.setupStatus,
        assistantChat: device.assistantChat,
        messagesIdentity: device.messagesIdentity,
        lastSeenAt: device.lastSeenAt,
      });
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, 'Device authentication required'));
    }
  });

  app.post('/owner/devices/:id/heartbeat', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { token } = await deviceAuth(request);
      if (!options.ownerMessagesAdapter?.checkCapabilities) throw new HttpError(501, 'Messages capability checks are unavailable');
      response.json(await ownerDevices.heartbeat(
        token,
        await options.ownerMessagesAdapter.checkCapabilities(),
      ));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, error instanceof Error ? error.message : 'Device authentication required'));
    }
  });

  app.get('/owner/devices/:id/messages/chats', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { token } = await deviceAuth(request);
      if (!options.ownerMessagesAdapter) throw new HttpError(501, 'Messages chat discovery is unavailable');
      const chats = await ownerDevices.discoverChats(token, options.ownerMessagesAdapter);
      response.json(chats.map(({ id, service, displayName, address, isGroup }) => ({ id, service, displayName, address, isGroup })));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, error instanceof Error ? error.message : 'Chat discovery failed'));
    }
  });

  app.post('/owner/devices/:id/messages/chat', ownerDeviceRateLimit, ownerAuth, async (request, response, next) => {
    try {
      const service = request.body?.service;
      const chatId = request.body?.chatId;
      if ((service !== 'imessage' && service !== 'sms') || typeof chatId !== 'string' || !chatId.trim()) {
        throw new HttpError(400, 'chatId and service are required');
      }
      response.json(await ownerDevices.authorizeChat(
        (request as Request & { ownerId?: string }).ownerId!, String(request.params.id), chatId, service,
      ));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Chat authorization failed'));
    }
  });

  app.get('/owner/devices/:id/deliveries', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      response.json(await ownerDeliveries.listPending(device.id));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, 'Device authentication required'));
    }
  });

  app.post('/owner/devices/:id/deliveries/:deliveryId/requested', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      const providerRequestId = typeof request.body?.providerRequestId === 'string' ? request.body.providerRequestId.trim() : '';
      if (!providerRequestId) throw new HttpError(400, 'providerRequestId is required');
      const delivery = await ownerDeliveries.markSent(device.id, String(request.params.deliveryId), providerRequestId);
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      response.json(delivery);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Delivery update failed'));
    }
  });

  app.post('/owner/devices/:id/deliveries/:deliveryId/observed', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      const externalId = typeof request.body?.externalId === 'string' ? request.body.externalId.trim() : '';
      if (!externalId) throw new HttpError(400, 'externalId is required');
      const delivery = await ownerDeliveries.markObserved(device.id, String(request.params.deliveryId), externalId);
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      await options.repository.appendEvent(delivery.conversationId, 'owner.delivery.sent', {
        messageId: delivery.messageId,
        deliveryId: delivery.id,
        externalId,
        providerRequestId: delivery.providerRequestId,
        source: 'macos_messages',
      }, new Date());
      response.json(delivery);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Delivery confirmation failed'));
    }
  });

  app.post('/owner/devices/:id/deliveries/:deliveryId/failed', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      const message = typeof request.body?.error === 'string' && request.body.error.trim()
        ? request.body.error.trim()
        : 'Delivery failed';
      const delivery = await ownerDeliveries.markFailed(device.id, String(request.params.deliveryId), message);
      if (!delivery) throw new HttpError(404, 'Delivery not found');
      await options.repository.appendEvent(delivery.conversationId, 'owner.delivery.failed', {
        messageId: delivery.messageId,
        deliveryId: delivery.id,
        error: message,
        source: 'macos_messages',
      }, new Date());
      response.json(delivery);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Delivery failure could not be recorded'));
    }
  });

  app.post('/owner/devices/:id/messages/replies', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      const externalId = typeof request.body?.externalId === 'string' ? request.body.externalId.trim() : '';
      const body = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
      if (!externalId || !body) throw new HttpError(400, 'externalId and body are required');
      const deliveryId = typeof request.body?.deliveryId === 'string' ? request.body.deliveryId : undefined;
      const replyToExternalId = typeof request.body?.replyToExternalId === 'string' ? request.body.replyToExternalId : undefined;
      const delivery = await ownerDeliveries.claimReplyTarget(device.id, externalId, deliveryId, replyToExternalId);
      if (!delivery) throw new HttpError(409, 'No owner delivery is awaiting a reply');
      await options.repository.appendEvent(delivery.conversationId, 'owner.message.received', {
        deliveryId: delivery.id,
        externalId,
        body,
        source: 'macos_messages',
      }, new Date());
      const conversation = await ownerReplies.reply({
        conversationId: delivery.conversationId,
        ownerId: device.ownerId,
        body,
        idempotencyKey: `macos:${device.id}:${externalId}`,
        source: 'macos_messages',
      });
      response.json(presentConversation(conversation));
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Owner reply failed'));
    }
  });

  app.get('/owner/configuration', ownerAuth, async (request, response) => {
    response.json(await ownerConfiguration.get((request as Request & { ownerId?: string }).ownerId!));
  });

  app.patch('/owner/configuration', ownerAuth, async (request, response, next) => {
    try {
      response.json(await ownerConfiguration.update(
        (request as Request & { ownerId?: string }).ownerId!,
        request.body as OwnerConfigurationPatch,
      ));
    } catch (error) {
      next(new HttpError(400, error instanceof Error ? error.message : 'Invalid configuration'));
    }
  });

  app.get('/owner/devices/:id/configuration', ownerDeviceRateLimit, async (request, response, next) => {
    try {
      const { device } = await deviceAuth(request);
      response.json({
        deviceId: device.id,
        ownerId: device.ownerId,
        configuration: await ownerConfiguration.get(device.ownerId),
      });
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(401, 'Device authentication required'));
    }
  });

  app.get('/owner/devices', ownerAuth, async (request, response, next) => {
    try {
      const devices = await ownerDevices.list((request as Request & { ownerId?: string }).ownerId!);
      response.json(devices);
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/devices/:id/revoke', ownerAuth, async (request, response, next) => {
    try {
      await ownerDevices.revoke(
        (request as Request & { ownerId?: string }).ownerId!,
        String(request.params.id),
      );
      response.status(204).send();
    } catch (error) {
      next(new HttpError(404, error instanceof Error ? error.message : 'Device not found'));
    }
  });

  app.post('/owner/devices/:id/primary', ownerAuth, async (request, response, next) => {
    try {
      const device = await ownerDevices.setPrimary(
        (request as Request & { ownerId?: string }).ownerId!,
        String(request.params.id),
      );
      response.json(device);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(409, error instanceof Error ? error.message : 'Device cannot be primary'));
    }
  });

  const runtimeInput = (request: Request) => ({
    commandId: typeof request.body?.commandId === 'string' ? request.body.commandId : undefined,
    expectedRevision: typeof request.body?.expectedRevision === 'number'
      ? request.body.expectedRevision
      : undefined,
  });

  const runtimeOwner = (request: Request) => (request as Request & { ownerId?: string }).ownerId!;

  app.get('/conversations/:id/runtime', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.getRuntime(String(request.params.id), runtimeOwner(request))));
    } catch (error) {
      next(error);
    }
  });

  app.get('/conversations/:id/runtime/events', ownerAuth, async (request, response, next) => {
    try {
      const snapshot = await runtime.getRuntime(String(request.params.id), runtimeOwner(request));
      response.status(200);
      response.setHeader('Content-Type', 'text/event-stream');
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Connection', 'keep-alive');
      response.flushHeaders?.();
      response.write(`event: runtime.state_changed\n`);
      response.write(`data: ${JSON.stringify({ runtime: presentRuntime(snapshot) })}\n\n`);
      const unsubscribe = runtime.subscribe(String(request.params.id), (event) => {
        response.write(`event: ${event.type}\n`);
        response.write(`data: ${JSON.stringify({
          ...event,
          occurredAt: event.occurredAt.toISOString(),
        })}\n\n`);
      });
      const keepAlive = setInterval(() => response.write(': ping\n\n'), 25_000);
      request.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/start', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.start(String(request.params.id), runtimeOwner(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/stop', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.stop(String(request.params.id), runtimeOwner(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/pause', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.pause(String(request.params.id), runtimeOwner(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/resume', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.resume(String(request.params.id), runtimeOwner(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/takeover', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.takeOver(String(request.params.id), runtimeOwner(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/return-to-assistant', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.returnToAssistant(String(request.params.id), runtimeOwner(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/interrupt', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.interrupt(String(request.params.id), runtimeOwner(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/runtime/transition-to-sms', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.transitionToSms(String(request.params.id), runtimeOwner(request), runtimeInput(request))));
    } catch (error) {
      next(error);
    }
  });

  app.patch('/conversations/:id/runtime', ownerAuth, async (request, response, next) => {
    try {
      const patch = request.body as RuntimeConfigurationPatch & { expiresAt?: string };
      const fields = Object.entries(patch).filter(([field]) =>
        !['commandId', 'expectedRevision', 'expiresAt'].includes(field),
      ) as [keyof RuntimeConfigurationPatch, unknown][];
      if (fields.length === 0) throw new HttpError(400, 'At least one runtime field is required');
      if (patch.expiresAt !== undefined &&
        (typeof patch.expiresAt !== 'string' || !Number.isFinite(new Date(patch.expiresAt).getTime()))) {
        throw new HttpError(400, 'expiresAt must be a valid date');
      }
      let snapshot = await runtime.getRuntime(String(request.params.id), runtimeOwner(request));
      const commandInput = runtimeInput(request);
      for (const [index, [field, value]] of fields.entries()) {
        snapshot = await runtime.setTemporaryOverride(
          String(request.params.id),
          runtimeOwner(request),
          field as Parameters<RuntimeControlService['setTemporaryOverride']>[2],
          value,
          {
            ...commandInput,
            commandId: index === 0 ? commandInput.commandId : undefined,
            expectedRevision: snapshot.configurationRevision,
          },
          typeof patch.expiresAt === 'string' ? new Date(patch.expiresAt) : undefined,
        );
      }
      response.json(presentRuntime(snapshot));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/conversations/:id/runtime/overrides/:field', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.clearTemporaryOverride(
        String(request.params.id),
        runtimeOwner(request),
        String(request.params.field) as Parameters<RuntimeControlService['clearTemporaryOverride']>[2],
        runtimeInput(request),
      )));
    } catch (error) {
      next(error);
    }
  });

  app.get('/conversations', ownerAuth, async (request, response, next) => {
    try {
      let conversations = await service.listConversations();
      conversations = conversations.filter((conversation) =>
        !conversation.ownerId || conversation.ownerId === (request as Request & { ownerId?: string }).ownerId);
      if (typeof request.query.state === 'string') {
        conversations = conversations.filter((conversation) =>
          (conversation.state ?? 'voice_active') === request.query.state);
      }
      if (request.query.needsOwner === 'true') {
        conversations = conversations.filter((conversation) =>
          presentConversationSummary(conversation).needsOwner === true);
      }
      response.json(await Promise.all(conversations.map(async (conversation) => ({
        ...presentConversationSummary(conversation),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation)),
        voice: presentVoice(conversation),
      }))));
    } catch (error) {
      next(error);
    }
  });

  app.get('/conversations/:id', ownerAuth, async (request, response, next) => {
    try {
      const authenticatedOwner = (request as Request & { ownerId?: string }).ownerId!;
      const conversation = options.ownerAuthToken
        ? await service.requireOwnedConversation(String(request.params.id), authenticatedOwner)
        : await service.getConversation(String(request.params.id));
      if (!conversation) throw new HttpError(404, 'Conversation not found');
      if (options.ownerAuthToken) await service.markOwnerRead(conversation.id, authenticatedOwner);
      const refreshed = await service.getConversation(conversation.id);
      response.json({
        ...presentConversation(refreshed!),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(refreshed!)),
        voice: presentVoice(refreshed!),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/messages', ownerAuth, async (request, response, next) => {
    try {
      const body = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
      if (!body || body.length > 2000) throw new HttpError(400, 'Message body must be between 1 and 2000 characters');
      if (options.ownerAuthToken) {
        await service.requireOwnedConversation(
          String(request.params.id),
          (request as Request & { ownerId?: string }).ownerId!,
        );
      } else if (!await service.getConversation(String(request.params.id))) {
        throw new HttpError(404, 'Conversation not found');
      }
      const key = typeof request.body?.idempotencyKey === 'string' && request.body.idempotencyKey.trim()
        ? request.body.idempotencyKey.trim()
        : `web:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const conversation = await ownerReplies.reply({
        conversationId: String(request.params.id),
        ownerId: (request as Request & { ownerId?: string }).ownerId!,
        body,
        idempotencyKey: key,
        source: 'web',
      });
      response.json({
        ...presentConversation(conversation),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation)),
        voice: presentVoice(conversation),
      });
    } catch (error) {
      next(error);
    }
  });

  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  app.get('/', (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile('index.html', { root: publicDir });
  });
  app.get('/manifest.webmanifest', (_request, response) => {
    response.type('application/manifest+json').sendFile('manifest.webmanifest', { root: publicDir });
  });
  app.get('/icon.svg', (_request, response) => {
    response.sendFile('icon.svg', { root: publicDir });
  });

  app.post('/conversations/:id/turns', async (request, response, next) => {
    try {
      const callbackId =
        typeof request.body?.callbackId === 'string'
          ? request.body.callbackId
          : undefined;
      if (!callbackId) {
        throw new HttpError(400, 'Missing required field: callbackId');
      }
      const conversation = await engine.respond(request.params.id, {
        callbackId,
        audio: request.body?.audio,
      });
      response.json({
        ...presentConversation(conversation),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation)),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/convert-to-text', async (request, response, next) => {
    try {
      const conversation = await service.convertToTextConversation(request.params.id);
      await runtime.finalizeSmsTransition(conversation.id);
      response.json({
        ...presentConversation(conversation),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation)),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/conversations/:id/sms-consent', async (request, response, next) => {
    try {
      const phone = request.body?.phoneNumber ?? request.body?.phone;
      if (typeof phone !== 'string' || !phone.trim()) {
        throw new HttpError(400, 'Missing required field: phoneNumber');
      }
      const conversation = await service.grantSmsConsent(
        request.params.id,
        phone,
        typeof request.body?.displayName === 'string' ? request.body.displayName : undefined,
      );
      const beforeFinalize = await runtime.getRuntimeForConversation(conversation);
      const finalizedConversation = beforeFinalize.state === 'transferring'
        ? await service.convertToTextConversation(conversation.id)
        : conversation;
      const runtimeSnapshot = beforeFinalize.state === 'transferring'
        ? await runtime.finalizeSmsTransition(finalizedConversation.id)
        : await runtime.getRuntimeForConversation(finalizedConversation);
      response.json({
        ...presentConversation(finalizedConversation),
        runtime: presentRuntime(runtimeSnapshot),
      });
    } catch (error) {
      next(error);
    }
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof HttpError) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }

      console.error(error);
      response.status(500).json({ error: 'Internal server error' });
    },
  );

  return app;
}
