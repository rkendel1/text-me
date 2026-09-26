import { Pool } from 'pg';

import { createApp } from './app.js';
import { getConfig } from './config.js';
import { PostgresConversationRepository } from './repositories/postgres-conversation-repository.js';

async function main(): Promise<void> {
  const config = getConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const repository = new PostgresConversationRepository(pool);

  await repository.initialize();

  const app = createApp({
    repository,
    includeFakeProviderRoutes: config.enableFakeProviderRoutes,
  });
  app.listen(config.port, () => {
    console.log(`text-me listening on port ${config.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
