import { Pool } from 'pg';

import { createApp } from './app.js';
import { getConfig } from './config.js';
import { PostgresConversationRepository } from './repositories/postgres-conversation-repository.js';
import { TwilioMessagingProvider } from './messaging/twilio-provider.js';

async function main(): Promise<void> {
  const config = getConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const repository = new PostgresConversationRepository(pool);

  await repository.initialize();

  const app = createApp({
    repository,
    includeFakeProviderRoutes: config.enableFakeProviderRoutes,
    messagingProvider: new TwilioMessagingProvider(
      config.twilioAccountSid,
      config.twilioAuthToken,
      config.twilioPhoneNumber,
    ),
    ownerPhone: config.ownerPhone,
    twilioAuthToken: config.twilioAuthToken,
  });
  app.listen(config.port, () => {
    console.log(`text-me listening on port ${config.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
