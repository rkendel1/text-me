import { createServer, type Server } from 'node:http';

import { Pool } from 'pg';

import { createApp, type AppOptions } from './app.js';
import { getConfig, type AppConfig } from './config.js';
import { OwnerConfigurationService } from './owner/configuration.js';
import { OwnerDeviceService } from './owner/device.js';
import { QueuedMacMessagesOwnerChannel } from './owner/delivery.js';
import { TwilioMessagingProvider } from './messaging/twilio-provider.js';
import { PostgresConversationRepository } from './repositories/postgres-conversation-repository.js';
import {
  PostgresConversationRuntimeEventStore,
  PostgresConversationRuntimeStore,
  PostgresRuntimeOverrideStore,
} from './repositories/postgres-conversation-runtime-repository.js';
import {
  PostgresOwnerConfigurationStore,
  PostgresOwnerDeviceSessionStore,
  PostgresOwnerDeviceStore,
  PostgresOwnerMessageDeliveryStore,
  PostgresOwnerPairingCredentialStore,
} from './repositories/postgres-owner-runtime-repository.js';
import { PostgresRuntimeEventBus } from './runtime/event-bus.js';
import { FakeTelephonyProvider } from './telephony/fake-provider.js';
import { TwilioProvider } from './telephony/twilio-provider.js';
import { createGateway } from 'ai';

import { AiSdkTextAgent } from './conversation/ai-sdk-text-agent.js';
import { GatewayRealtimeConnector } from './voice/realtime/connector.js';
import { MEDIA_STREAM_PATH, RealtimeVoiceService } from './voice/realtime/realtime-voice.js';

/**
 * Builds the HTTP server synchronously (Vercel imports the default export) and
 * creates database tables lazily on the first request.
 */
export function buildServer(
  config: AppConfig = getConfig(),
  overrides: Partial<AppOptions> = {},
): { server: Server; ready: Promise<void> } {
  // Serverless instances each hold their own pool; keep it small for Neon's pooler.
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  const repository = new PostgresConversationRepository(pool);
  const ownerDeviceStore = new PostgresOwnerDeviceStore(pool);
  const ownerPairings = new PostgresOwnerPairingCredentialStore(pool);
  const ownerSessions = new PostgresOwnerDeviceSessionStore(pool);
  const ownerConfigurations = new PostgresOwnerConfigurationStore(pool);
  const ownerDeliveries = new PostgresOwnerMessageDeliveryStore(pool);
  const runtimeStore = new PostgresConversationRuntimeStore(pool);
  const runtimeEvents = new PostgresConversationRuntimeEventStore(pool);
  const runtimeOverrides = new PostgresRuntimeOverrideStore(pool);
  const runtimeEventBus = new PostgresRuntimeEventBus(pool, config.databaseListenUrl);

  const ready = (async () => {
    await repository.initialize();
    await ownerDeviceStore.initialize();
    await ownerPairings.initialize();
    await ownerSessions.initialize();
    await ownerConfigurations.initialize();
    await ownerDeliveries.initialize();
    await runtimeStore.initialize();
    await runtimeEvents.initialize();
    await runtimeOverrides.initialize();
  })();
  ready.catch((error) => console.error('Database initialization failed', error));

  const ownerDeviceService = new OwnerDeviceService(ownerDeviceStore, Date.now, ownerPairings, ownerSessions);
  const ownerConfigurationService = new OwnerConfigurationService(ownerConfigurations);
  const ownerChannel = new QueuedMacMessagesOwnerChannel(
    ownerDeliveries,
    ownerDeviceService,
    ownerConfigurationService,
  );
  const realtimeVoice = config.realtimeVoice
    ? new RealtimeVoiceService(new GatewayRealtimeConnector(config.realtimeVoice), { voice: config.realtimeVoice.voice })
    : undefined;
  // AI SDK is the AI boundary: realtime voice and text both go through AI Gateway.
  const ai = config.realtimeVoice;
  const textAgent = ai
    ? new AiSdkTextAgent(createGateway({ apiKey: ai.apiKey, baseURL: ai.baseURL, teamIdOrSlug: ai.teamIdOrSlug })(ai.textModelId))
    : undefined;
  const mediaStreamUrl = `${config.publicBaseUrl.replace(/^http/, 'ws')}${MEDIA_STREAM_PATH}`;

  const app = createApp({
    repository,
    providers: [
      new TwilioProvider(realtimeVoice ? {
        mediaStreamUrl,
        continueUrl: `${config.publicBaseUrl}/webhooks/twilio/voice/continue`,
      } : {}),
      new FakeTelephonyProvider(),
    ],
    includeFakeProviderRoutes: config.enableFakeProviderRoutes,
    messagingProvider: new TwilioMessagingProvider(
      config.twilioAccountSid,
      config.twilioAuthToken,
      config.twilioPhoneNumber,
    ),
    ownerPhone: config.ownerPhone,
    ownerId: config.ownerId,
    ownerAuthToken: config.ownerAuthToken,
    twilioAuthToken: config.twilioAuthToken,
    ownerDeviceService,
    ownerConfigurationService,
    ownerDeliveryStore: ownerDeliveries,
    ownerChannel,
    runtimeStore,
    runtimeEventStore: runtimeEvents,
    runtimeOverrideStore: runtimeOverrides,
    runtimeEventBus,
    realtimeVoice,
    conversationModel: textAgent,
    autoReplyToCallerTexts: Boolean(textAgent),
    beforeRequest: ready,
    ...overrides,
  });

  const server = createServer(app);
  realtimeVoice?.attach(server, {
    twilioAuthToken: config.twilioAuthToken,
    publicBaseUrl: config.publicBaseUrl,
    beforeConnect: ready,
  });
  return { server, ready };
}
