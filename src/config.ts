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
  /** Platform telephony credentials. The numbers they hold are assigned to accounts in the database. */
  twilioAccountSid: string;
  twilioAuthToken: string;
  /** Let accounts buy a new assistant line when the platform's pool of numbers is empty. */
  allowNumberPurchase: boolean;
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

/** Every configuration problem at once, with what to do about each. Never includes values. */
export class ConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration incomplete:\n- ${problems.join('\n- ')}`);
  }
}

const REQUIRED: Array<[string, string]> = [
  ['TWILIO_ACCOUNT_SID', 'TWILIO_ACCOUNT_SID is missing (Twilio Console → Account Info)'],
  ['TWILIO_AUTH_TOKEN', 'TWILIO_AUTH_TOKEN is missing (Twilio Console → Account Info → Auth Token)'],
];

/**
 * Environment variables are platform configuration and secrets only. These
 * named a customer (the single owner) and are no longer read by anything; if
 * one is still set, the deployment refuses to start rather than let anyone
 * believe it still decides who the customer is.
 */
export const CUSTOMER_IDENTITY_VARIABLES = [
  'OWNER_PHONE_NUMBER', 'OWNER_ID', 'OWNER_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER',
  'USER_NAME', 'USER_PHONE', 'USER_EMAIL', 'ACCOUNT_ID', 'DEVICE_ID', 'OWNER_NAME', 'OWNER_EMAIL',
] as const;

export function customerIdentityProblems(env: NodeJS.ProcessEnv): string[] {
  return CUSTOMER_IDENTITY_VARIABLES.filter((key) => env[key]?.trim()).map((key) =>
    `${key} is set, but customer identity no longer comes from the environment: accounts, users and numbers live in the database. ` +
    'If this deployment predates accounts, run `npm run migrate:legacy` once (docs/saas-migration.md), then delete this variable.');
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];
  // Neon's Vercel integration sets DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED;
  // the legacy POSTGRES_* names are accepted too.
  const databaseUrl = env.DATABASE_URL ?? env.POSTGRES_URL;
  if (!databaseUrl) problems.push('DATABASE_URL is missing (Vercel → Storage → add Neon and connect it to this project)');
  for (const [key, message] of REQUIRED) {
    if (!env[key]?.trim()) problems.push(message);
  }
  problems.push(...customerIdentityProblems(env));
  const apnsKeys = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY', 'APNS_BUNDLE_ID'];
  const apnsSet = apnsKeys.filter((key) => env[key]);
  if (apnsSet.length && apnsSet.length < apnsKeys.length) {
    problems.push(`iOS push is partly configured: also set ${apnsKeys.filter((key) => !env[key]).join(', ')} (or remove the APNS_* variables)`);
  }

  const production = env.NODE_ENV === 'production' || Boolean(env.VERCEL);
  const aiGateway = resolveAiGateway(env);
  if (production && !aiGateway) {
    problems.push('An AI Gateway credential is required in production: set AI_GATEWAY_API_KEY (Vercel deployments use OIDC automatically)');
  }
  if (production && env.REALTIME_VOICE === 'off') {
    problems.push('REALTIME_VOICE=off isn’t supported in production: calls would get a canned greeting instead of your assistant');
  }
  if (production && !/^https:\/\//.test(resolvePublicBaseUrl(env))) {
    problems.push('PUBLIC_BASE_URL must be an https URL in production (Twilio calls back to it)');
  }
  if (problems.length) throw new ConfigurationError(problems);

  return {
    production,
    release: { environment: env.VERCEL_ENV ?? env.NODE_ENV ?? 'development', commit: env.VERCEL_GIT_COMMIT_SHA || undefined },
    aiGateway,
    apns: apnsConfigFromEnv(env),
    appleTeamId: env.APNS_TEAM_ID || undefined,
    databaseUrl: databaseUrl!,
    databaseListenUrl: env.DATABASE_URL_UNPOOLED ?? env.POSTGRES_URL_NON_POOLING ?? databaseUrl!,
    enableFakeProviderRoutes: !production,
    port: Number(env.PORT ?? '3000'),
    publicBaseUrl: resolvePublicBaseUrl(env),
    twilioAccountSid: env.TWILIO_ACCOUNT_SID!.trim(),
    twilioAuthToken: env.TWILIO_AUTH_TOKEN!.trim(),
    allowNumberPurchase: env.TELEPHONY_NUMBER_PURCHASE === 'on',
    realtimeVoice: resolveRealtimeVoice(env),
  };
}
