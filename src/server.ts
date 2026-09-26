import { Pool } from 'pg';

import { createApp } from './app.js';
import { getConfig } from './config.js';
import { OwnerConfigurationService } from './owner/configuration.js';
import { OwnerDeviceService } from './owner/device.js';
import { QueuedMacMessagesOwnerChannel } from './owner/delivery.js';
import { TwilioMessagingProvider } from './messaging/twilio-provider.js';
import { PostgresConversationRepository } from './repositories/postgres-conversation-repository.js';
import {
  PostgresOwnerConfigurationStore,
  PostgresOwnerDeviceSessionStore,
  PostgresOwnerDeviceStore,
  PostgresOwnerMessageDeliveryStore,
  PostgresOwnerPairingCredentialStore,
} from './repositories/postgres-owner-runtime-repository.js';

async function main(): Promise<void> {
  const config = getConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const repository = new PostgresConversationRepository(pool);
  const ownerDeviceStore = new PostgresOwnerDeviceStore(pool);
  const ownerPairings = new PostgresOwnerPairingCredentialStore(pool);
  const ownerSessions = new PostgresOwnerDeviceSessionStore(pool);
  const ownerConfigurations = new PostgresOwnerConfigurationStore(pool);
  const ownerDeliveries = new PostgresOwnerMessageDeliveryStore(pool);

  await repository.initialize();
  await ownerDeviceStore.initialize();
  await ownerPairings.initialize();
  await ownerSessions.initialize();
  await ownerConfigurations.initialize();
  await ownerDeliveries.initialize();

  const ownerDeviceService = new OwnerDeviceService(ownerDeviceStore, Date.now, ownerPairings, ownerSessions);
  const ownerConfigurationService = new OwnerConfigurationService(ownerConfigurations);
  const ownerChannel = new QueuedMacMessagesOwnerChannel(
    ownerDeliveries,
    ownerDeviceService,
    ownerConfigurationService,
  );

  const app = createApp({
    repository,
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
  });
  app.listen(config.port, () => {
    console.log(`text-me listening on port ${config.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
