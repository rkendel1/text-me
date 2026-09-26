export interface RealtimeVoiceConfig {
  modelId: string;
  /** Model for text messages (SMS replies, relaying the owner's answers). */
  textModelId: string;
  voice?: string;
  apiKey?: string;
  baseURL?: string;
  teamIdOrSlug?: string;
}

import { apnsConfigFromEnv, type ApnsConfig } from './attention/apns.js';

export interface AiGatewayConfig {
  textModelId: string;
  apiKey?: string;
  baseURL?: string;
  teamIdOrSlug?: string;
}

export interface AppConfig {
  /**
   * Production composition (NODE_ENV=production, or any Vercel deployment):
   * durable stores only, no fake providers, and missing pieces fail startup.
   */
  production: boolean;
  release: { environment: string; commit?: string };
  /** Native iOS push; optional (the web app uses Web Push). */
  apns?: ApnsConfig;
  appleTeamId?: string;
  /** The text model for SMS and relays; required in production. */
  aiGateway?: AiGatewayConfig;
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
export const DEFAULT_TEXT_MODEL = 'anthropic/claude-haiku-4.5';

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

function hasGatewayCredential(env: NodeJS.ProcessEnv): boolean {
  // Vercel deployments authenticate to AI Gateway with OIDC automatically; elsewhere use an API key.
  return Boolean(env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN || env.VERCEL);
}

function resolveAiGateway(env: NodeJS.ProcessEnv): AiGatewayConfig | undefined {
  if (!hasGatewayCredential(env)) return undefined;
  return {
    textModelId: env.TEXT_MODEL || DEFAULT_TEXT_MODEL,
    apiKey: env.AI_GATEWAY_API_KEY || undefined,
    baseURL: env.AI_GATEWAY_BASE_URL || undefined,
    teamIdOrSlug: env.AI_GATEWAY_TEAM || undefined,
  };
}

function resolveRealtimeVoice(env: NodeJS.ProcessEnv): RealtimeVoiceConfig | undefined {
  if (env.REALTIME_VOICE === 'off') return undefined;
  const gateway = resolveAiGateway(env);
  if (!gateway) return undefined;
  return {
    modelId: env.REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
    textModelId: gateway.textModelId,
    voice: env.REALTIME_VOICE_NAME || undefined,
    apiKey: gateway.apiKey,
    baseURL: gateway.baseURL,
    teamIdOrSlug: gateway.teamIdOrSlug,
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

  const production = env.NODE_ENV === 'production' || Boolean(env.VERCEL);
  const aiGateway = resolveAiGateway(env);
  if (production && !aiGateway) {
    throw new Error('An AI Gateway credential is required in production: set AI_GATEWAY_API_KEY (Vercel deployments use OIDC automatically)');
  }
  if (production && !/^https:\/\//.test(resolvePublicBaseUrl(env))) {
    throw new Error('PUBLIC_BASE_URL must be an https URL in production (Twilio calls back to it)');
  }

  return {
    production,
    release: { environment: env.VERCEL_ENV ?? env.NODE_ENV ?? 'development', commit: env.VERCEL_GIT_COMMIT_SHA || undefined },
    aiGateway,
    apns: apnsConfigFromEnv(env),
    appleTeamId: env.APNS_TEAM_ID || undefined,
    databaseUrl,
    databaseListenUrl: env.DATABASE_URL_UNPOOLED ?? env.POSTGRES_URL_NON_POOLING ?? databaseUrl,
    enableFakeProviderRoutes: !production,
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
