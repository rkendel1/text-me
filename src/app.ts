import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { toDataURL } from 'qrcode';

import { HttpError } from './errors.js';
import { presentConversation, presentConversationSummary } from './http/presenters.js';
import type { Conversation } from './domain/conversation.js';
import { openOwnerRequest } from './domain/owner-requests.js';
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
import { runtimeIdFor, type RuntimeCommand, type RuntimeCommandStore } from './runtime/commands.js';
import { OwnerAttentionService } from './attention/service.js';
import type { PhoneNumberService } from './telephony/phone-number.js';
import { attentionUrl, createSurfaceDeviceId, type OwnerDeviceCapability } from './attention/model.js';
import { NotificationRouter } from './attention/router.js';
import { MacMessagesSurface, OwnerSmsSurface, VapidPushSender, WebPushSurface, type PushSender } from './attention/surfaces.js';
import {
  InMemoryAppSecretStore,
  InMemoryNotificationDeliveryStore,
  InMemoryOwnerAttentionStore,
  InMemoryOwnerSurfaceDeviceStore,
  type AppSecretStore,
  type NotificationDeliveryStore,
  type OwnerAttentionStore,
  type OwnerSurfaceDeviceStore,
} from './attention/stores.js';
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
  runtimeCommandStore?: RuntimeCommandStore;
  attentionStore?: OwnerAttentionStore;
  notificationDeliveryStore?: NotificationDeliveryStore;
  surfaceDeviceStore?: OwnerSurfaceDeviceStore;
  appSecretStore?: AppSecretStore;
  pushSender?: PushSender;
  /** Lets the owner connect their number from the app (no provider console). */
  phoneNumbers?: PhoneNumberService;
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
      // Passive by default: the owner is only interrupted if they opted in to call-start notifications.
      await service.raiseAttention(conversation.id, {
        type: 'conversation_started',
        title: (name) => `${name} is calling`,
        body: 'Your assistant is answering',
        dedupeKey: `started:${conversation.id}`,
      });
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
      if (statusUpdate.status === 'completed') {
        await service.resolveAttention(conversation.id, ['conversation_started'], 'call ended');
        await service.raiseAttention(conversation.id, {
          type: 'conversation_completed',
          title: (name) => `${name.split(' ')[0]}'s ${conversation.state === 'text_active' ? 'call' : 'conversation'} is complete`,
          body: conversation.state === 'text_active' ? 'The conversation continues by text' : 'Handled by your assistant',
          dedupeKey: `completed:${conversation.id}`,
        });
      }
      response.status(200).json(presentConversation(conversation));
    } catch (error) {
      next(error);
    }
  });
}

function presentRuntime(
  runtime: Awaited<ReturnType<RuntimeControlService['getRuntimeForConversation']>>,
  conversation?: Conversation,
) {
  // The spec's owner-facing vocabulary; `state` keeps the fine-grained activity.
  const status = runtime.state === 'stopped' ? 'ended'
    : runtime.state === 'paused' ? 'paused'
      : runtime.aiMode === 'owner_only' ? 'takeover'
        : runtime.state === 'waiting_for_owner' || (conversation && openOwnerRequest(conversation)) ? 'owner_needed'
          : runtime.state === 'text_active' ? 'text_active'
            : runtime.state === 'idle' || runtime.state === 'starting' ? 'idle' : 'active';
  return {
    ...runtime,
    status,
    runtimeId: runtimeIdFor(runtime.conversationId),
    mode: runtime.aiMode === 'owner_assist' ? 'ask_owner' : runtime.aiMode,
    overriddenFields: runtime.overriddenFields ?? [],
    temporarySettings: (runtime.overriddenFields ?? []).length > 0,
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
    options.runtimeCommandStore,
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
  // Owner attention: surfaces are optional add-ons; none of them is required for a conversation to work.
  const attentionStore = options.attentionStore ?? new InMemoryOwnerAttentionStore();
  const surfaceDevices = options.surfaceDeviceStore ?? new InMemoryOwnerSurfaceDeviceStore();
  const pushSender = options.pushSender ?? new VapidPushSender(options.appSecretStore ?? new InMemoryAppSecretStore());
  const attention = new OwnerAttentionService(
    attentionStore,
    options.notificationDeliveryStore ?? new InMemoryNotificationDeliveryStore(attentionStore),
    new NotificationRouter({
      push: new WebPushSurface(surfaceDevices, pushSender),
      mac: options.ownerChannel ? new MacMessagesSurface(options.ownerChannel, options.repository) : undefined,
      sms: new OwnerSmsSurface(messaging, options.ownerPhone),
    }),
    async (owner) => ({ notifyOnActivity: (await ownerConfiguration.get(owner)).messages.notifyOnActivity === true }),
    (raised) => runtime.publishAttention(raised.conversationId, {
      attentionId: raised.id, attentionType: raised.type, status: raised.status, priority: raised.priority,
    }),
  );
  const service = new ConversationService(
    options.repository, messaging, options.ownerPhone, ownerId, attention,
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
      let conversation = received;
      try {
        conversation = await engine.respondToCallerText(received.id, message.providerMessageId);
      } catch (error) {
        // The caller's text is saved; if the assistant can't reply, the owner must see it.
        console.error(`[sms ${received.id}] assistant reply failed`, error);
        await service.requestOwner(received.id, {
          question: `New text: "${message.body}" — the assistant couldn't reply. Can you answer?`,
          source: 'sms', callId: message.providerMessageId,
        }).catch(() => undefined);
        await runtime.noteOwnerNeeded(received.id, message.providerMessageId, message.body).catch(() => undefined);
        conversation = (await service.getConversation(received.id)) ?? received;
      }
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

  // ---- Owner surfaces: push registration (web now; ios/macos later use the same records) ----
  const presentSurfaceDevice = (device: Awaited<ReturnType<OwnerSurfaceDeviceStore['list']>>[number]) => ({
    id: device.id, platform: device.platform, capabilities: device.capabilities, label: device.label ?? null,
    status: device.status, createdAt: device.createdAt.toISOString(), lastSeenAt: device.lastSeenAt.toISOString(),
  });

  app.get('/owner/push/config', ownerAuth, async (_request, response, next) => {
    try {
      response.json({ publicKey: await pushSender.publicKey() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/owner/push/devices', ownerAuth, async (request, response, next) => {
    try {
      response.json((await surfaceDevices.list(runtimeOwner(request))).map(presentSurfaceDevice));
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/push/devices', ownerAuth, async (request, response, next) => {
    try {
      const subscription = request.body?.subscription;
      const endpoint = subscription?.endpoint;
      if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) ||
        typeof subscription?.keys?.p256dh !== 'string' || typeof subscription?.keys?.auth !== 'string') {
        throw new HttpError(400, 'A valid push subscription is required');
      }
      // Capabilities are what we can actually do for a web push device; action buttons only where the browser shows them.
      const capabilities: OwnerDeviceCapability[] = ['push', 'deep_link'];
      if (request.body?.supportsActions === true) capabilities.push('interactive_notification');
      const now = new Date();
      const device = await surfaceDevices.upsert({
        id: createSurfaceDeviceId(), ownerId: runtimeOwner(request), platform: 'web',
        deviceToken: JSON.stringify({ endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } }),
        capabilities, label: typeof request.body?.label === 'string' ? request.body.label.slice(0, 60) : undefined,
        status: 'active', createdAt: now, lastSeenAt: now,
      });
      response.status(201).json(presentSurfaceDevice(device));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/owner/push/devices/:id', ownerAuth, async (request, response, next) => {
    try {
      const device = (await surfaceDevices.list(runtimeOwner(request))).find((candidate) => candidate.id === String(request.params.id));
      if (!device) throw new HttpError(404, 'Device not found');
      await surfaceDevices.setStatus(device.id, 'revoked');
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/push/test', ownerAuth, async (request, response, next) => {
    try {
      const devices = (await surfaceDevices.list(runtimeOwner(request))).filter((device) => device.status === 'active' && device.platform === 'web');
      if (!devices.length) throw new HttpError(409, 'Turn on notifications on this device first');
      const payload = JSON.stringify({ title: 'Notifications are on', body: 'You’ll hear from your assistant only when it needs you.', url: '/', tag: 'test' });
      const results = await Promise.all(devices.map((device) => pushSender.send(JSON.parse(device.deviceToken), payload, { ttlSeconds: 60, urgency: 'normal' })
        .then(() => 'sent', () => 'failed')));
      response.json({ sent: results.filter((result) => result === 'sent').length, failed: results.filter((result) => result === 'failed').length });
    } catch (error) {
      next(error);
    }
  });

  // ---- Owner attention: what needs the owner, and one-tap actions from a notification ----
  const presentAttention = (item: Awaited<ReturnType<OwnerAttentionService['list']>>[number]) => ({
    id: item.id, conversationId: item.conversationId, type: item.type, priority: item.priority, title: item.title,
    body: item.body, actions: item.actions, status: item.status, url: attentionUrl(item),
    createdAt: item.createdAt.toISOString(), resolvedAt: item.resolvedAt?.toISOString() ?? null,
  });

  app.get('/owner/attention', ownerAuth, async (request, response, next) => {
    try {
      response.json((await attention.list(runtimeOwner(request), {
        open: request.query.open === 'true',
        conversationId: typeof request.query.conversationId === 'string' ? request.query.conversationId : undefined,
        limit: 50,
      })).map(presentAttention));
    } catch (error) {
      next(error);
    }
  });

  const requireAttention = async (request: Request) => {
    const item = await attention.get(String(request.params.id), runtimeOwner(request));
    if (!item) throw new HttpError(404, 'Not found');
    return item;
  };

  app.post('/owner/attention/:id/opened', ownerAuth, async (request, response, next) => {
    try {
      const item = await requireAttention(request);
      await attention.markOpened(item);
      response.json(presentAttention((await attention.get(item.id, runtimeOwner(request)))!));
    } catch (error) {
      next(error);
    }
  });

  app.post('/owner/attention/:id/dismiss', ownerAuth, async (request, response, next) => {
    try {
      const item = await requireAttention(request);
      await attention.dismiss(item);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  /**
   * Act on a notification. The conversation comes from the stored attention,
   * never from the client, and the action runs as a durable runtime command.
   */
  app.post('/owner/attention/:id/actions', ownerAuth, async (request, response, next) => {
    try {
      const item = await requireAttention(request);
      const action = request.body?.action;
      const commandId = typeof request.body?.commandId === 'string' ? request.body.commandId : `attention:${item.id}:${action}`;
      if (action === 'take_over') {
        const snapshot = await runtime.takeOver(item.conversationId, item.ownerId, { commandId });
        await attention.markActed(item, 'take_over', commandId);
        response.json({ conversationId: item.conversationId, runtime: presentRuntime(snapshot) });
        return;
      }
      if (action === 'reply') {
        const body = typeof request.body?.body === 'string' ? request.body.body.trim() : '';
        if (!body || body.length > 2000) throw new HttpError(400, 'Reply must be between 1 and 2000 characters');
        const conversation = await ownerReplies.reply({
          conversationId: item.conversationId, ownerId: item.ownerId, body, idempotencyKey: commandId, source: 'web',
        });
        await attention.markActed(item, 'reply', commandId);
        response.json({ conversationId: item.conversationId, conversation: presentConversation(conversation) });
        return;
      }
      throw new HttpError(400, 'Unknown action');
    } catch (error) {
      next(error);
    }
  });

  // Owner-wide live stream: every change in any of the owner's conversations, including new attention.
  app.get('/owner/events', ownerAuth, (request, response) => {
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders?.();
    response.write(`event: ready\ndata: {}\n\n`);
    const unsubscribe = runtime.subscribeOwner(runtimeOwner(request), (event) => {
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify({ ...event, occurredAt: event.occurredAt.toISOString() })}\n\n`);
    });
    const keepAlive = setInterval(() => response.write(': ping\n\n'), 25_000);
    request.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // ---- The owner's phone number ----
  app.get('/owner/phone', ownerAuth, async (_request, response, next) => {
    try {
      if (!options.phoneNumbers) {
        response.json({ available: false, phoneNumber: null, connected: false });
        return;
      }
      response.json({ available: true, ...(await options.phoneNumbers.status()) });
    } catch (error) {
      next(new HttpError(502, 'Couldn’t reach your phone provider. Try again in a moment.'));
    }
  });

  app.post('/owner/phone/connect', ownerAuth, async (_request, response, next) => {
    try {
      if (!options.phoneNumbers) throw new HttpError(409, 'No phone number is set up for this account yet');
      response.json(await options.phoneNumbers.connect());
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(502, error instanceof Error ? error.message : 'Couldn’t connect your number'));
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

  // adjust_interaction: one command, one revision, this conversation only.
  app.patch('/conversations/:id/runtime', ownerAuth, async (request, response, next) => {
    try {
      const patch = { ...(request.body ?? {}) } as Record<string, unknown>;
      const expiresAt = patch.expiresAt;
      if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !Number.isFinite(new Date(expiresAt).getTime()))) {
        throw new HttpError(400, 'expiresAt must be a valid date');
      }
      for (const key of ['commandId', 'expectedRevision', 'expiresAt']) delete patch[key];
      const conversationId = String(request.params.id);
      const conversation = await service.getConversation(conversationId);
      const snapshot = await runtime.adjust(conversationId, runtimeOwner(request), patch as Parameters<RuntimeControlService['adjust']>[2],
        runtimeInput(request), typeof expiresAt === 'string' ? new Date(expiresAt) : undefined);
      response.json(presentRuntime(snapshot, conversation ?? undefined));
    } catch (error) {
      next(error);
    }
  });

  // Reset this conversation to the owner's defaults.
  app.delete('/conversations/:id/runtime/overrides', ownerAuth, async (request, response, next) => {
    try {
      response.json(presentRuntime(await runtime.resetOverrides(String(request.params.id), runtimeOwner(request), runtimeInput(request))));
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

  const presentCommand = (command: RuntimeCommand) => ({
    ...command,
    createdAt: command.createdAt.toISOString(),
    processedAt: command.processedAt?.toISOString() ?? null,
    appliedLiveAt: command.appliedLiveAt?.toISOString() ?? null,
  });

  app.get('/conversations/:id/runtime/commands', ownerAuth, async (request, response, next) => {
    try {
      response.json((await runtime.listCommands(String(request.params.id), runtimeOwner(request))).map(presentCommand));
    } catch (error) {
      next(error);
    }
  });

  // One ordered timeline with every identifier, so a journey can be reconstructed
  // end to end: caller turn -> transcript -> AI response -> command -> owner reply -> SMS.
  app.get('/conversations/:id/audit', ownerAuth, async (request, response, next) => {
    try {
      const conversationId = String(request.params.id);
      const conversation = await service.requireOwnedConversation(conversationId, runtimeOwner(request))
        .catch(async (error) => {
          if (options.ownerAuthToken) throw error;
          const found = await service.getConversation(conversationId);
          if (!found) throw error;
          return found;
        });
      const [runtimeEvents, commands, snapshot, attentionItems, notifications] = await Promise.all([
        runtime.listEvents(conversationId, runtimeOwner(request)),
        runtime.listCommands(conversationId, runtimeOwner(request)),
        runtime.getRuntimeForConversation(conversation),
        attention.list(conversation.ownerId ?? runtimeOwner(request), { conversationId }),
        attention.deliveriesForConversation(conversationId),
      ]);
      const idKeys = ['callbackId', 'responseId', 'commandId', 'messageId', 'requestId', 'providerMessageId',
        'idempotencyKey', 'deliveryId', 'externalId', 'streamSid', 'callSid', 'callId', 'revision'] as const;
      const ids = (payload: Record<string, unknown>) => Object.fromEntries(idKeys
        .filter((key) => payload[key] !== undefined && payload[key] !== null)
        .map((key) => [key === 'callbackId' ? 'turnId' : key, payload[key]]));
      const timeline = [
        ...conversation.events.map((event) => ({
          at: event.occurredAt, source: 'conversation', type: event.type, eventId: event.id, ids: ids(event.payload),
          summary: typeof event.payload.text === 'string' ? event.payload.text
            : typeof event.payload.summary === 'string' ? event.payload.summary
              : typeof event.payload.question === 'string' ? event.payload.question : undefined,
        })),
        ...runtimeEvents.filter((event) => event.durable || event.type !== 'runtime.state_changed').map((event) => ({
          at: event.occurredAt, source: 'runtime', type: event.type, eventId: event.id, ids: ids(event.payload),
          summary: typeof event.payload.state === 'string' ? `state: ${event.payload.state}` : undefined,
        })),
        ...attentionItems.map((item) => ({
          at: item.createdAt, source: 'attention', type: `attention.${item.type}`, eventId: item.id,
          ids: { attentionId: item.id, ...(item.metadata.requestId ? { requestId: item.metadata.requestId } : {}), status: item.status },
          summary: item.title,
        })),
        ...notifications.map((delivery) => ({
          at: delivery.createdAt, source: 'notification', type: `notification.${delivery.status}`, eventId: delivery.id,
          ids: { notificationId: delivery.id, attentionId: delivery.attentionId, surface: delivery.surface,
            ...(delivery.deviceId ? { deviceId: delivery.deviceId } : {}), ...(delivery.providerId ? { providerId: delivery.providerId } : {}) },
          summary: delivery.error,
        })),
      ].sort((left, right) => left.at.getTime() - right.at.getTime())
        .map((entry) => ({ ...entry, at: entry.at.toISOString() }));
      response.json({
        conversationId,
        provider: conversation.provider,
        providerCallId: conversation.providerCallId,
        runtime: { conversationId, revision: snapshot.configurationRevision, state: snapshot.state },
        commands: commands.map(presentCommand),
        timeline,
      });
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
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation), conversation),
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
        runtime: presentRuntime(await runtime.getRuntimeForConversation(refreshed!), refreshed!),
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
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation), conversation),
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
  // Deep link from a notification straight into one live conversation (the app loads it, no inbox step).
  app.get('/conversations/:id/live', (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile('index.html', { root: publicDir });
  });
  app.get('/sw.js', (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Service-Worker-Allowed', '/');
    response.type('application/javascript').sendFile('sw.js', { root: publicDir });
  });
  app.get(/^\/icon-(180|192|512)\.png$/, (request, response) => {
    response.sendFile(request.path.slice(1), { root: publicDir });
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
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation), conversation),
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
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation), conversation),
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
