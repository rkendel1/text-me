import { createServer, type Server } from 'node:http';
import type { Express } from 'express';

import { Pool } from 'pg';

import { createApp, type AppOptions } from './http-app.js';
import { getConfig, type AppConfig } from './config.js';
import { OwnerConfigurationService } from './owner/configuration.js';
import { OwnerDeviceService } from './owner/device.js';
import { QueuedMacMessagesOwnerChannel } from './owner/delivery.js';
import { TwilioMessagingProvider } from './messaging/twilio-provider.js';
import { PostgresConversationRepository } from './repositories/postgres-conversation-repository.js';
import {
  PostgresConversationRuntimeEventStore,
  PostgresConversationRuntimeStore,
  PostgresRuntimeCommandStore,
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
import {
  PostgresAppSecretStore,
  PostgresNotificationDeliveryStore,
  PostgresOwnerAttentionStore,
  PostgresOwnerSurfaceDeviceStore,
} from './attention/postgres.js';
import { VapidPushSender } from './attention/surfaces.js';
import { PostgresAuthSessionStore } from './auth/sessions.js';
import { PostgresTenancyStore } from './tenancy/postgres.js';
import { HttpApnsSender } from './attention/apns.js';
import { PhoneNumberService, TwilioPhoneNumberClient, type PhoneNumberClient } from './telephony/phone-number.js';
import type { MessagingProvider } from './messaging/provider.js';
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
/** Platform integrations; tests and local tools may stand in for the real providers. */
export interface PlatformProviders {
  phoneNumberClient?: PhoneNumberClient;
  messagingProvider?: MessagingProvider;
}

export function buildServer(
  config: AppConfig = getConfig(),
  overrides: Partial<AppOptions> = {},
  platform: PlatformProviders = {},
): { app: Express; server: Server; ready: Promise<void> } {
  // Serverless instances each hold their own pool; keep it small for Neon's pooler.
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
  return buildServerWithPool(config, pool, overrides, platform);
}

/** The whole composition over one pool (tests run several instances against one database this way). */
export function buildServerWithPool(
  config: AppConfig,
  pool: Pool,
  overrides: Partial<AppOptions> = {},
  platform: PlatformProviders = {},
): { app: Express; server: Server; ready: Promise<void>; stores: ReturnType<typeof createStores> } {
  const stores = createStores(pool, config);
  const { tenancyStore, repository, ownerDeviceStore, ownerPairings, ownerSessions, ownerConfigurations, ownerDeliveries,
    runtimeStore, runtimeEvents, runtimeOverrides, runtimeCommands, attentionStore, notificationDeliveries, surfaceDevices,
    appSecrets, runtimeEventBus, authSessions, initialize } = stores;
  // Retried on the next request after a failure (e.g. a database cold start), rather than
  // failing every request for the lifetime of this instance.
  let initializing: Promise<void> | undefined;
  const ensureReady = (): Promise<void> => {
    initializing ??= initialize().catch((error) => {
      initializing = undefined;
      console.error('Database initialization failed', error);
      throw error;
    });
    return initializing;
  };
  const ready = ensureReady();
  ready.catch(() => undefined);

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
  const ai = config.aiGateway;
  const textAgent = ai
    ? new AiSdkTextAgent(createGateway({ apiKey: ai.apiKey, baseURL: ai.baseURL, teamIdOrSlug: ai.teamIdOrSlug })(ai.textModelId))
    : undefined;
  // Platform credentials; each account's numbers are records in `phone_numbers`.
  const messagingProvider = platform.messagingProvider ?? new TwilioMessagingProvider(config.twilioAccountSid, config.twilioAuthToken);
  const phoneNumbers = new PhoneNumberService(
    tenancyStore,
    platform.phoneNumberClient ?? new TwilioPhoneNumberClient(config.twilioAccountSid, config.twilioAuthToken),
    config.publicBaseUrl,
    messagingProvider,
    { allowPurchase: config.allowNumberPurchase },
  );
  const mediaStreamUrl = `${config.publicBaseUrl.replace(/^http/, 'ws')}${MEDIA_STREAM_PATH}`;

  const app = createApp({
    repository,
    providers: [
      new TwilioProvider(realtimeVoice ? {
        mediaStreamUrl,
        continueUrl: `${config.publicBaseUrl}/webhooks/twilio/voice/continue`,
      } : {}),
      // The fake provider exists for local development only; production never registers it.
      ...(config.production ? [] : [new FakeTelephonyProvider()]),
    ],
    includeFakeProviderRoutes: config.enableFakeProviderRoutes,
    // Each text is sent from the sending account's own assistant line.
    messagingProvider,
    tenancyStore,
    twilioAuthToken: config.twilioAuthToken,
    stripe: config.stripe ? { ...config.stripe, baseUrl: config.publicBaseUrl } : undefined,
    ownerDeviceService,
    ownerConfigurationService,
    ownerDeliveryStore: ownerDeliveries,
    ownerChannel,
    runtimeStore,
    runtimeEventStore: runtimeEvents,
    runtimeOverrideStore: runtimeOverrides,
    runtimeEventBus,
    runtimeCommandStore: runtimeCommands,
    publicBaseUrl: config.publicBaseUrl,
    phoneNumbers,
    attentionStore,
    notificationDeliveryStore: notificationDeliveries,
    surfaceDeviceStore: surfaceDevices,
    // VAPID keys are generated once and kept in Neon, so push works with zero configuration.
    pushSender: new VapidPushSender(appSecrets, {
      subject: process.env.VAPID_SUBJECT,
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    }),
    realtimeVoice,
    conversationModel: textAgent,
    autoReplyToCallerTexts: Boolean(textAgent),
    beforeRequest: ensureReady,
    authSessionStore: authSessions,
    neonAuth: config.neonAuth,
    apnsSender: config.apns ? new HttpApnsSender(config.apns) : undefined,
    appleTeamId: config.appleTeamId,
    production: config.production,
    release: config.release,
    healthCheck: async () => { await pool.query('SELECT 1'); },
    ...overrides,
  });

  const server = createServer(app);
  realtimeVoice?.attach(server, {
    twilioAuthToken: config.twilioAuthToken,
    publicBaseUrl: config.publicBaseUrl,
    beforeConnect: ensureReady,
  });
  return { app, server, ready, stores };
}

/** Every durable store, over one pool. Tables are created (and legacy columns renamed) on first use. */
export function createStores(pool: Pool, config: Pick<AppConfig, 'databaseListenUrl'>) {
  // Neon closes idle connections; without a listener pg's 'error' event would crash the whole process.
  pool.on('error', (error) => console.error('[database] idle connection closed:', error.message));
  const tenancyStore = new PostgresTenancyStore(pool);
  const repository = new PostgresConversationRepository(pool);
  const ownerDeviceStore = new PostgresOwnerDeviceStore(pool);
  const ownerPairings = new PostgresOwnerPairingCredentialStore(pool);
  const ownerSessions = new PostgresOwnerDeviceSessionStore(pool);
  const ownerConfigurations = new PostgresOwnerConfigurationStore(pool);
  const ownerDeliveries = new PostgresOwnerMessageDeliveryStore(pool);
  const runtimeStore = new PostgresConversationRuntimeStore(pool);
  const runtimeEvents = new PostgresConversationRuntimeEventStore(pool);
  const runtimeOverrides = new PostgresRuntimeOverrideStore(pool);
  const runtimeCommands = new PostgresRuntimeCommandStore(pool);
  const attentionStore = new PostgresOwnerAttentionStore(pool);
  const notificationDeliveries = new PostgresNotificationDeliveryStore(pool);
  const surfaceDevices = new PostgresOwnerSurfaceDeviceStore(pool);
  const appSecrets = new PostgresAppSecretStore(pool);
  const runtimeEventBus = new PostgresRuntimeEventBus(pool, config.databaseListenUrl);
  const authSessions = new PostgresAuthSessionStore(pool);
  const initialize = async () => {
    await tenancyStore.initialize();
    await repository.initialize();
    await ownerDeviceStore.initialize();
    await ownerPairings.initialize();
    await ownerSessions.initialize();
    await ownerConfigurations.initialize();
    await ownerDeliveries.initialize();
    await runtimeStore.initialize();
    await runtimeEvents.initialize();
    await runtimeOverrides.initialize();
    await runtimeCommands.initialize();
    await attentionStore.initialize();
    await notificationDeliveries.initialize();
    await surfaceDevices.initialize();
    await appSecrets.initialize();
    await authSessions.initialize();
  };
  return {
    pool, tenancyStore, repository, ownerDeviceStore, ownerPairings, ownerSessions, ownerConfigurations, ownerDeliveries,
    runtimeStore, runtimeEvents, runtimeOverrides, runtimeCommands, attentionStore, notificationDeliveries, surfaceDevices,
    appSecrets, runtimeEventBus, authSessions, initialize,
  };
}
