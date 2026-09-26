export interface RealtimeVoiceConfig {
  modelId: string;
  voice?: string;
  apiKey?: string;
  baseURL?: string;
  teamIdOrSlug?: string;
}

export interface AppConfig {
  databaseUrl: string;
  /** Direct (non-pooled) connection for LISTEN/NOTIFY; Neon's DATABASE_URL_UNPOOLED. */
  databaseListenUrl: string;
  enableFakeProviderRoutes: boolean;
  port: number;
  publicBaseUrl: string;
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  ownerPhone: string;
  ownerId: string;
  ownerAuthToken: string;
  /** Present when calls should be answered by the AI Gateway realtime voice agent. */
  realtimeVoice?: RealtimeVoiceConfig;
}

export const DEFAULT_REALTIME_MODEL = 'openai/gpt-realtime-2';

/**
 * The public origin Twilio calls back to. On Vercel this defaults to the
 * project's production domain (`<project>.vercel.app`), so no domain setup is
 * needed; set PUBLIC_BASE_URL to override (e.g. a custom domain).
 */
export function resolvePublicBaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL;
  if (vercelHost) return `https://${vercelHost}`;
  return `http://localhost:${env.PORT ?? '3000'}`;
}

function resolveRealtimeVoice(env: NodeJS.ProcessEnv): RealtimeVoiceConfig | undefined {
  if (env.REALTIME_VOICE === 'off') return undefined;
  // Vercel deployments authenticate to AI Gateway with OIDC automatically; elsewhere use an API key.
  const hasCredential = Boolean(env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN || env.VERCEL);
  if (!hasCredential) return undefined;
  return {
    modelId: env.REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
    voice: env.REALTIME_VOICE_NAME || undefined,
    apiKey: env.AI_GATEWAY_API_KEY || undefined,
    baseURL: env.AI_GATEWAY_BASE_URL || undefined,
    teamIdOrSlug: env.AI_GATEWAY_TEAM || undefined,
  };
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Neon's Vercel integration sets DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED;
  // the legacy POSTGRES_* names are accepted too.
  const databaseUrl = env.DATABASE_URL ?? env.POSTGRES_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (add Neon from the Vercel Marketplace, or set it manually)');
  }
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'OWNER_PHONE_NUMBER', 'OWNER_AUTH_TOKEN'];
  for (const key of required) {
    if (!env[key]) throw new Error(`${key} is required`);
  }

  return {
    databaseUrl,
    databaseListenUrl: env.DATABASE_URL_UNPOOLED ?? env.POSTGRES_URL_NON_POOLING ?? databaseUrl,
    enableFakeProviderRoutes: env.NODE_ENV !== 'production' && !env.VERCEL,
    port: Number(env.PORT ?? '3000'),
    publicBaseUrl: resolvePublicBaseUrl(env),
    twilioAccountSid: env.TWILIO_ACCOUNT_SID!,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN!,
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER!,
    ownerPhone: env.OWNER_PHONE_NUMBER!,
    ownerId: env.OWNER_ID ?? 'owner',
    ownerAuthToken: env.OWNER_AUTH_TOKEN ?? '',
    realtimeVoice: resolveRealtimeVoice(env),
  };
}
