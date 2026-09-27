import { randomBytes } from 'node:crypto';

/**
 * The SaaS tenancy model. The account is the unit of ownership: every
 * customer resource (conversations, devices, numbers, attention, commands…)
 * carries an `accountId`. Users reach an account only through a membership.
 * Every identifier is an opaque, durable id; names, emails and phone numbers
 * are attributes, never keys.
 */

export type MembershipRole = 'owner' | 'admin' | 'member';

export interface Account {
  id: string;
  name: string;
  onboardingState: OnboardingState;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  /** Display name. Never an identifier. */
  name: string;
  /** Sign-in identifier, stored lower-cased. Never an account key. */
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Membership {
  id: string;
  accountId: string;
  userId: string;
  role: MembershipRole;
  createdAt: Date;
}

/** The unconfigured → pending_verification → verified → active lifecycle every number goes through. */
export type PhoneNumberStatus = 'pending_verification' | 'verified' | 'active' | 'released';
export type PhoneNumberVerification = 'unverified' | 'code_sent' | 'verified' | 'provider_verified' | 'migrated';
/**
 * assistant_line: a provider number assigned to the account; callers' calls are forwarded to it.
 * personal: the owner's real mobile. Callers keep dialing it; texts from it are the owner's replies.
 */
export type PhoneNumberKind = 'assistant_line' | 'personal';

export interface PhoneNumber {
  id: string;
  accountId: string;
  kind: PhoneNumberKind;
  /** E.164 */
  number: string;
  status: PhoneNumberStatus;
  provider: string;
  /** The provider's id for the number (e.g. a Twilio IncomingPhoneNumber SID). Not a secret. */
  providerRef?: string;
  verificationStatus: PhoneNumberVerification;
  verificationCodeHash?: string;
  verificationExpiresAt?: Date;
  verificationAttempts: number;
  verifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** The plane: the assistant that answers the account's line. One per account today. */
export interface Plane {
  id: string;
  accountId: string;
  name: string;
  status: 'active' | 'paused';
  createdAt: Date;
  updatedAt: Date;
}

/** Non-secret, account-scoped provider choices. Provider credentials stay platform secrets. */
export interface ProviderConfiguration {
  accountId: string;
  telephonyProvider: string;
  messagingProvider: string;
  settings: Record<string, unknown>;
  updatedAt: Date;
}

export interface Entitlements {
  maxAssistantLines: number;
  maxMembers: number;
  maxAccountsPerUser: number;
}

export interface Subscription {
  accountId: string;
  plan: string;
  status: 'active' | 'past_due' | 'canceled';
  entitlements: Entitlements;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditEvent {
  id: string;
  accountId: string;
  userId?: string;
  type: string;
  detail: Record<string, unknown>;
  occurredAt: Date;
}

/** Where attention can reach the account. Resolved from account-owned records, never deployment config. */
export type NotificationChannelKind = 'push' | 'mac_messages' | 'sms';

export interface NotificationChannel {
  id: string;
  accountId: string;
  kind: NotificationChannelKind;
  /** The account turned this channel on. */
  enabled: boolean;
  /** Something is set up that can actually receive it (a registered device, a verified number…). */
  available: boolean;
  /** Human description of the destination, e.g. "2 devices" or "+1 555…". */
  destination: string | null;
}

export const ONBOARDING_STATES = [
  'account_created',
  'identity_configured',
  'phone_configured',
  'application_configured',
  'notifications_configured',
  'ready',
] as const;
export type OnboardingState = typeof ONBOARDING_STATES[number];

export const DEFAULT_ENTITLEMENTS: Entitlements = { maxAssistantLines: 1, maxMembers: 5, maxAccountsPerUser: 5 };

const opaque = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
export const createAccountId = () => opaque('acct');
export const createUserId = () => opaque('usr');
export const createMembershipId = () => opaque('mem');
export const createPhoneNumberId = () => opaque('pn');
export const createPlaneId = () => opaque('plane');
export const createAuditEventId = () => opaque('aud');

export const E164 = /^\+[1-9]\d{6,14}$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}
