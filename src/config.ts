export interface AppConfig {
  databaseUrl: string;
  enableFakeProviderRoutes: boolean;
  port: number;
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  ownerPhone: string;
  ownerId: string;
  ownerAuthToken: string;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'OWNER_PHONE_NUMBER'];
  for (const key of required) {
    if (!env[key]) throw new Error(`${key} is required`);
  }

  return {
    databaseUrl,
    enableFakeProviderRoutes: env.NODE_ENV !== 'production',
    port: Number(env.PORT ?? '3000'),
    twilioAccountSid: env.TWILIO_ACCOUNT_SID!,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN!,
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER!,
    ownerPhone: env.OWNER_PHONE_NUMBER!,
    ownerId: env.OWNER_ID ?? 'owner',
    ownerAuthToken: env.OWNER_AUTH_TOKEN ?? '',
  };
}
