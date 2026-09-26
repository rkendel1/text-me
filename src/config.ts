export interface AppConfig {
  databaseUrl: string;
  enableFakeProviderRoutes: boolean;
  port: number;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  return {
    databaseUrl,
    enableFakeProviderRoutes: env.NODE_ENV !== 'production',
    port: Number(env.PORT ?? '3000'),
  };
}
