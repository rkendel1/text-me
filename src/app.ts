import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { toDataURL } from 'qrcode';

import { HttpError } from './errors.js';
import { presentConversation, presentConversationSummary } from './http/presenters.js';
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
  );
  const fakeRoutesEnabled = options.includeFakeProviderRoutes ?? true;

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

  app.post('/webhooks/twilio/sms', async (request, response, next) => {
    try {
      if (!twilioProvider.parseIncomingSms) throw new HttpError(501, 'SMS is not supported');
      const message = twilioProvider.parseIncomingSms(request.body);
      const conversation = await service.receiveSms(message);
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
      const conversation = await engine.respondToOwner(
        delivery.conversationId,
        body,
        `macos:${device.id}:${externalId}`,
        'macos_messages',
      );
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
      response.write(`event: runtime.state_changed\\n`);
      response.write(`data: ${JSON.stringify({ runtime: presentRuntime(snapshot) })}\\n\\n`);
      const unsubscribe = runtime.subscribe(String(request.params.id), (event) => {
        response.write(`event: ${event.type}\\n`);
        response.write(`data: ${JSON.stringify({
          ...event,
          occurredAt: event.occurredAt.toISOString(),
        })}\\n\\n`);
      });
      request.on('close', unsubscribe);
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
      let snapshot = await runtime.getRuntime(String(request.params.id), runtimeOwner(request));
      for (const [field, value] of fields) {
        snapshot = await runtime.setTemporaryOverride(
          String(request.params.id),
          runtimeOwner(request),
          field as Parameters<RuntimeControlService['setTemporaryOverride']>[2],
          value,
          runtimeInput(request),
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
      const conversation = await engine.respondToOwner(String(request.params.id), body, key);
      response.json({
        ...presentConversation(conversation),
        runtime: presentRuntime(await runtime.getRuntimeForConversation(conversation)),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/', (_request, response) => {
    response.type('html').send(`<!doctype html>
<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live Control Plane</title><style>
:root{color-scheme:light;--bg:#eef2f8;--surface:rgba(255,255,255,.72);--surface-strong:#fff;--text:#0f172a;--muted:#5f6c82;--line:rgba(148,163,184,.24);--blue:#1677ff;--blue-strong:#0a60ff;--danger:#ff453a;--success:#30d158;--shadow:0 24px 60px rgba(15,23,42,.12)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}body{margin:0;min-height:100vh;font:16px/1.4 -apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text',system-ui,sans-serif;color:var(--text);background:radial-gradient(circle at top,#fdfefe 0,#eef3ff 40%,#e9eef5 100%) fixed}button,input{font:inherit}button{border:0;cursor:pointer;transition:transform .16s ease,opacity .16s ease,box-shadow .16s ease}button:active{transform:scale(.98)}main{min-height:100vh;padding:clamp(16px,3vw,28px);display:grid;grid-template-columns:minmax(300px,360px) minmax(0,1fr);gap:20px;max-width:1380px;margin:0 auto}
.panel{background:var(--surface);backdrop-filter:blur(28px);border:1px solid rgba(255,255,255,.7);box-shadow:var(--shadow);border-radius:28px;overflow:hidden}.sidebar{display:flex;flex-direction:column}.sidebarHeader,.detailHeader{padding:20px 20px 16px;border-bottom:1px solid var(--line)}.eyebrow{font-size:.78rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h1,h2,h3,p{margin:0}.title{font-size:clamp(1.4rem,2vw,2rem);font-weight:750;letter-spacing:-.03em}.subtitle{color:var(--muted);margin-top:6px}
.actionRow,.quickActions,.runtimeGrid,.toggleGrid,.toolbar{display:grid;gap:12px}.actionRow{padding:18px 20px;border-bottom:1px solid var(--line)}.actionRow.two{grid-template-columns:repeat(2,minmax(0,1fr))}.button{border-radius:18px;padding:14px 16px;font-weight:700;box-shadow:0 12px 30px rgba(22,119,255,.2);background:linear-gradient(180deg,#3291ff,#1677ff);color:#fff}.button.secondary{background:rgba(255,255,255,.9);color:var(--text);box-shadow:none;border:1px solid rgba(148,163,184,.22)}.button.ghost{background:rgba(22,119,255,.1);color:var(--blue-strong);box-shadow:none}.button.danger{background:linear-gradient(180deg,#ff7369,#ff453a)}.button.small{padding:11px 14px;border-radius:14px;font-size:.95rem}.pairing,#devices{padding:0 20px 18px}.pairing img{max-width:100%;border-radius:22px;background:#fff;border:1px solid var(--line);padding:10px}.pairing code{display:block;word-break:break-all;font-size:.8rem;color:var(--muted);margin-top:10px}
.list{padding:10px 14px 18px;overflow:auto}.item{width:100%;text-align:left;background:rgba(255,255,255,.78);border:1px solid transparent;color:inherit;border-radius:22px;padding:16px 16px 14px;box-shadow:0 10px 24px rgba(15,23,42,.06);margin-bottom:12px}.item.active{border-color:rgba(22,119,255,.36);background:rgba(230,240,255,.98)}.item strong,.item span{display:block}.itemTitle{display:flex;align-items:center;justify-content:space-between;gap:12px}.itemMeta{color:var(--muted);font-size:.93rem;margin-top:4px}.badge{display:inline-flex;align-items:center;gap:8px;padding:8px 12px;border-radius:999px;font-size:.82rem;font-weight:700;background:rgba(255,255,255,.85);border:1px solid rgba(148,163,184,.22)}.badge.live::before,.dot::before{content:'';width:9px;height:9px;border-radius:999px;background:var(--success);box-shadow:0 0 0 4px rgba(48,209,88,.12)}.badge.paused::before{background:#f59e0b;box-shadow:0 0 0 4px rgba(245,158,11,.12)}.badge.stopped::before{background:var(--danger);box-shadow:0 0 0 4px rgba(255,69,58,.12)}.dot{display:inline-flex;align-items:center;gap:8px}
.detail{display:flex;flex-direction:column;min-width:0;overflow:hidden}.detailBody{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:18px;padding:18px}.card{background:rgba(255,255,255,.86);border:1px solid rgba(148,163,184,.18);border-radius:24px;box-shadow:0 12px 30px rgba(15,23,42,.05)}.transcript{display:flex;flex-direction:column;min-height:0}.cardHeader{padding:18px 18px 0}.cardBody{padding:18px}.messages{padding:0 18px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px;max-height:56vh}.message{max-width:min(82%,480px);padding:13px 15px;border-radius:20px;background:#eff3f8}.message.owner{margin-left:auto;background:rgba(22,119,255,.12);color:#0a2a63}.message.assistant{background:rgba(255,244,214,.92)}.role{font-size:.74rem;font-weight:700;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:5px}
.statusPanel{display:grid;gap:14px}.runtimeGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.stat{padding:14px;border-radius:18px;background:rgba(246,248,252,.92);border:1px solid rgba(148,163,184,.14)}.statLabel{font-size:.76rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}.statValue{margin-top:6px;font-size:1rem;font-weight:700}.quickActions{grid-template-columns:repeat(2,minmax(0,1fr))}.toggleGrid{grid-template-columns:repeat(2,minmax(0,1fr))}.toggle{padding:14px 16px;border-radius:18px;background:rgba(246,248,252,.92);border:1px solid rgba(148,163,184,.14);display:flex;align-items:center;justify-content:space-between;font-weight:650}.toggle em{font-style:normal;color:var(--muted);font-size:.9rem}.toggle.on{background:rgba(230,240,255,.82);border-color:rgba(22,119,255,.25)}
.composer{display:flex;gap:10px;padding:18px;border-top:1px solid var(--line)}input{width:100%;padding:15px 16px;border:1px solid rgba(148,163,184,.25);border-radius:18px;background:rgba(255,255,255,.92)}.chipRow{display:flex;flex-wrap:wrap;gap:10px}.chip{padding:10px 12px;border-radius:999px;background:rgba(246,248,252,.92);font-weight:650;color:var(--muted);border:1px solid rgba(148,163,184,.14)}
.empty{display:grid;place-items:center;padding:48px 24px;min-height:60vh;text-align:center}.empty .card{padding:28px;max-width:540px}
@media (max-width:1040px){main{grid-template-columns:1fr}.detailBody{grid-template-columns:1fr}.messages{max-height:none}.statusPanel{order:-1}}
@media (max-width:720px){body{background:linear-gradient(180deg,#f8fbff,#eef2f8)}main{padding:12px;gap:12px}.panel{border-radius:30px}.sidebarHeader,.detailHeader,.actionRow,.pairing,#devices,.detailBody,.composer{padding-left:16px;padding-right:16px}.detailHeader{padding-bottom:14px}.detailBody{padding-top:14px}.actionRow.two,.quickActions,.toggleGrid,.runtimeGrid{grid-template-columns:1fr 1fr}.detail.hidden,.sidebar.hidden{display:none}.toolbar{grid-template-columns:1fr}.title{font-size:1.55rem}}
@media (max-width:560px){.actionRow.two,.quickActions,.toggleGrid,.runtimeGrid{grid-template-columns:1fr}.messages{padding:0 14px 14px}.message{max-width:100%}.button{width:100%}}
</style></head><body><main id="app"><aside class="panel sidebar" id="sidebar"><div class="sidebarHeader"><div class="eyebrow">Control Plane</div><div class="title">Live Now</div><p class="subtitle">Operate calls in real time, switch channels, and take over instantly.</p></div><div class="actionRow two"><button class="button" id="pairButton">Pair Mac Messages</button><button class="button secondary" id="devicesButton">Connected Devices</button></div><div class="pairing" id="pairing"></div><div id="devices"></div><div class="list" id="list">Loading…</div></aside><section class="panel detail" id="thread"><div class="empty"><div class="card"><div class="eyebrow">Ready</div><h2 class="title" style="font-size:1.6rem;margin-top:8px">Open a live conversation</h2><p class="subtitle" style="margin-top:10px">The owner surface is optimized for touch — pause, stop, take over, or move to text without leaving this screen.</p></div></div></section></main>
<script>
const sidebar=document.querySelector('#sidebar'),list=document.querySelector('#list'),thread=document.querySelector('#thread'),pairing=document.querySelector('#pairing'),token=localStorage.getItem('ownerToken')||'';
const headers=token?{Authorization:'Bearer '+token}:{},jsonHeaders={...headers,'Content-Type':'application/json'};let selected,currentConversation,currentRuntime,eventSource;const esc=s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));const titleCase=s=>String(s||'').replace(/_/g,' ').replace(/\\b\\w/g,ch=>ch.toUpperCase());
function badgeClass(state){return state==='paused'?'paused':state==='stopped'?'stopped':'live'}
function mobileSelected(open){if(window.innerWidth<=720){sidebar.classList.toggle('hidden',open)}}
async function api(path,options={}){const response=await fetch(path,{...options,headers:options.headers||headers});if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error||'Request failed');return response}
async function loadList(){const r=await fetch('/conversations',{headers});if(r.status===401){list.textContent='Sign in to view conversations.';return}const data=await r.json();list.innerHTML='';if(!data.length){list.innerHTML='<div class=\"card\" style=\"padding:18px\"><div class=\"eyebrow\">Quiet for now</div><p class=\"subtitle\" style=\"margin-top:8px\">Active conversations will appear here as soon as they start.</p></div>';return}data.forEach(c=>{const runtime=c.runtime||{};const b=document.createElement('button');b.className='item'+(selected===c.id?' active':'');b.innerHTML='<div class=\"itemTitle\"><strong>'+esc((c.participant&&c.participant.name)||c.caller)+'</strong><span class=\"badge '+badgeClass(runtime.state)+'\">'+esc(titleCase(runtime.state||c.state||'live'))+'</span></div><span class=\"itemMeta\">'+esc(c.preview||'No transcript yet')+'</span><span class=\"itemMeta\">'+esc(runtime.currentActivity|| (c.needsOwner?'Needs owner response':'Ready'))+'</span>';b.onclick=()=>loadConversation(c.id);list.appendChild(b)})}
function renderConversation(){if(!currentConversation||!currentRuntime)return;const caller=((currentConversation.participants||[]).find(p=>p.role==='caller')||{}).displayName||currentConversation.caller;const controls=currentRuntime.state==='paused'?[['Resume','/resume','button'],['Stop','/stop','button danger']]:[['Pause','/pause','button secondary'],['Stop','/stop','button danger']];controls.push(currentRuntime.aiMode==='owner_only'?['Return to Assistant','/return-to-assistant','button']:[ 'Take Over','/takeover','button' ]);controls.push(['Move to Text','/transition-to-sms','button ghost']);const toggles=[['Voice',currentRuntime.voiceEnabled,'voiceEnabled'],['Transcription',currentRuntime.transcriptionEnabled,'transcriptionEnabled'],['SMS Transition',currentRuntime.smsTransitionEnabled,'smsTransitionEnabled']];const transcriptMessages=(currentConversation.messages||[]).map(m=>'<div class=\"message '+esc(m.role)+'\"><div class=\"role\">'+esc(m.role==='owner'?'Owner':m.role)+'</div>'+esc(m.body)+'</div>').join('')||'<div class=\"subtitle\">Waiting for activity…</div>';thread.innerHTML='<div class=\"detailHeader\"><div class=\"eyebrow\">Live Interaction</div><div style=\"display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:8px\"><div><div class=\"title\">'+esc(caller)+'</div><p class=\"subtitle\">'+esc(currentConversation.caller)+' • '+esc(titleCase(currentRuntime.currentActivity||currentRuntime.state))+'</p></div><span class=\"badge '+badgeClass(currentRuntime.state)+'\">'+esc(titleCase(currentRuntime.state))+'</span></div></div><div class=\"detailBody\"><section class=\"card transcript\"><div class=\"cardHeader\"><div class=\"eyebrow\">Live Transcript</div></div><div class=\"messages\">'+transcriptMessages+'</div><form class=\"composer\" id=\"messageForm\"><input placeholder=\"Reply as the owner…\" required maxlength=\"2000\"><button class=\"button small\">Send</button></form></section><aside class=\"statusPanel\"><section class=\"card\"><div class=\"cardBody\"><div class=\"eyebrow\">Runtime</div><div class=\"runtimeGrid\" style=\"margin-top:14px\"><div class=\"stat\"><div class=\"statLabel\">Assistant</div><div class=\"statValue\">'+esc(currentRuntime.assistantEnabled?'Running':'Stopped')+'</div></div><div class=\"stat\"><div class=\"statLabel\">AI Mode</div><div class=\"statValue\">'+esc(titleCase(currentRuntime.aiMode))+'</div></div><div class=\"stat\"><div class=\"statLabel\">Voice</div><div class=\"statValue\">'+esc(currentRuntime.voiceEnabled?'On':'Off')+'</div></div><div class=\"stat\"><div class=\"statLabel\">STT</div><div class=\"statValue\">'+esc(currentRuntime.transcriptionEnabled?'On':'Off')+'</div></div></div><div class=\"chipRow\" style=\"margin-top:14px\"><span class=\"chip\">Style: '+esc(titleCase(currentRuntime.responseStyle))+'</span><span class=\"chip\">Verbosity: '+esc(titleCase(currentRuntime.verbosity))+'</span><span class=\"chip\">Ask Owner: '+esc(titleCase(currentRuntime.askOwnerWhen))+'</span></div></div></section><section class=\"card\"><div class=\"cardBody\"><div class=\"eyebrow\">Controls</div><div class=\"quickActions\" style=\"margin-top:14px\">'+controls.map(([label,path,klass])=>'<button class=\"'+klass+'\" data-runtime=\"'+path+'\">'+esc(label)+'</button>').join('')+'</div></div></section><section class=\"card\"><div class=\"cardBody\"><div class=\"eyebrow\">Live Settings</div><div class=\"toggleGrid\" style=\"margin-top:14px\">'+toggles.map(([label,value,key])=>'<button class=\"toggle '+(value?'on':'')+'\" data-toggle=\"'+key+'\"><span>'+esc(label)+'</span><em>'+esc(value?'On':'Off')+'</em></button>').join('')+'</div><div class=\"toolbar\" style=\"margin-top:12px\"><button class=\"toggle\" data-style=\"concise\"><span>Be concise</span><em>'+esc(currentRuntime.responseStyle==='concise'?'Applied':'Tap to apply')+'</em></button><button class=\"toggle\" data-ask=\"important\"><span>Ask me on important items</span><em>'+esc(currentRuntime.askOwnerWhen==='important'?'Applied':'Tap to apply')+'</em></button></div></div></section></aside></div>';
thread.querySelector('#messageForm').onsubmit=sendMessage;thread.querySelectorAll('[data-runtime]').forEach(button=>button.onclick=()=>runtimeCommand(button.dataset.runtime));thread.querySelectorAll('[data-toggle]').forEach(button=>button.onclick=()=>toggleRuntime(button.dataset.toggle));thread.querySelectorAll('[data-style]').forEach(button=>button.onclick=()=>patchRuntime({responseStyle:button.dataset.style}));thread.querySelectorAll('[data-ask]').forEach(button=>button.onclick=()=>patchRuntime({askOwnerWhen:button.dataset.ask}));mobileSelected(true)}
async function loadConversation(id){selected=id;const r=await fetch('/conversations/'+id,{headers});if(!r.ok){thread.innerHTML='<div class=\"empty\"><div class=\"card\"><h2>Conversation unavailable</h2></div></div>';return}currentConversation=await r.json();currentRuntime=currentConversation.runtime;renderConversation();openStream(id);loadList()}
async function runtimeCommand(path){if(!selected||!currentRuntime)return;try{const r=await fetch('/conversations/'+selected+'/runtime'+path,{method:'POST',headers:jsonHeaders,body:JSON.stringify({expectedRevision:currentRuntime.revision})});const data=await r.json();if(!r.ok)throw new Error(data.error||'Command failed');currentRuntime=data;renderConversation();loadList()}catch(error){alert(error.message||'Command failed')}}
async function patchRuntime(body){if(!selected||!currentRuntime)return;try{const r=await fetch('/conversations/'+selected+'/runtime',{method:'PATCH',headers:jsonHeaders,body:JSON.stringify({...body,expectedRevision:currentRuntime.revision})});const data=await r.json();if(!r.ok)throw new Error(data.error||'Could not apply change');currentRuntime=data;renderConversation();loadList()}catch(error){alert(error.message||'Could not apply change')}}
async function toggleRuntime(field){if(!currentRuntime)return;await patchRuntime({[field]:!currentRuntime[field]})}
async function sendMessage(e){e.preventDefault();const input=e.target.querySelector('input'),button=e.target.querySelector('button');button.disabled=true;const r=await fetch('/conversations/'+selected+'/messages',{method:'POST',headers:jsonHeaders,body:JSON.stringify({body:input.value})});if(r.ok){input.value='';await loadConversation(selected)}else{alert('Could not deliver response. Please retry.')}button.disabled=false}
function openStream(id){if(eventSource){eventSource.close();eventSource=null}if(!token)return;eventSource=new EventSource('/conversations/'+id+'/runtime/events?token='+encodeURIComponent(token),{withCredentials:false});eventSource.onmessage=()=>undefined;['runtime.state_changed','runtime.transcript_final','runtime.ai_started','runtime.ai_completed','runtime.voice_started','runtime.voice_stopped','runtime.owner_needed','runtime.configuration_changed'].forEach(name=>eventSource.addEventListener(name,async()=>{if(selected===id)await loadConversation(id)}))}
async function loadDevices(){const r=await fetch('/owner/devices',{headers});if(!r.ok)return;const data=await r.json();document.querySelector('#devices').innerHTML=data.map(d=>'<div class=\"item\"><div class=\"itemTitle\"><strong>'+esc(d.name)+'</strong><span class=\"badge '+(d.status==='active'?'live':'paused')+'\">'+esc(d.status==='active'?'Connected':'Pending')+'</span></div><span class=\"itemMeta\">Messages '+esc(d.health?.messagesAccess?'✓':'—')+' · Chat '+esc(d.health?.authorizedChat?'✓':'—')+' · '+esc(d.setupStatus)+'</span></div>').join('')}
async function pairDevice(){pairing.innerHTML='<p class=\"subtitle\">Generating secure pairing QR…</p>';const r=await fetch('/owner/devices/pair/qr',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'Mac Messages'})});if(r.status===401){pairing.textContent='Sign in to pair a Mac.';return}if(!r.ok){pairing.textContent='Could not create pairing QR.';return}const data=await r.json();pairing.innerHTML='<p class=\"subtitle\">Scan this from the Mac bridge to connect Messages as an owner takeover channel.</p><img alt=\"Mac pairing QR\" src=\"'+data.qrDataUrl+'\"><p class=\"itemMeta\">Expires '+esc(new Date(data.expiresAt).toLocaleString())+'</p><code>'+esc(data.pairingUri)+'</code>'}
document.querySelector('#pairButton').onclick=pairDevice;document.querySelector('#devicesButton').onclick=loadDevices;window.addEventListener('resize',()=>mobileSelected(Boolean(selected)));loadList();loadDevices();setInterval(loadList,10000);setInterval(loadDevices,15000);
</script></body></html>`);
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

      response.status(500).json({ error: 'Internal server error' });
    },
  );

  return app;
}
