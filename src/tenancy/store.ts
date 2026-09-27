import type {
  Account,
  AuditEvent,
  Membership,
  PhoneNumber,
  Plane,
  ProviderConfiguration,
  Subscription,
  User,
} from './model.js';

export class EmailTakenError extends Error {
  constructor() { super('An account already uses that email. Sign in instead.'); }
}

export class PhoneNumberTakenError extends Error {
  constructor(readonly number: string) { super('That number is already in use by another account.'); }
}

export type PhoneNumberPatch = Partial<Pick<PhoneNumber,
  'status' | 'verificationStatus' | 'verificationCodeHash' | 'verificationExpiresAt' | 'verificationAttempts' |
  'verifiedAt' | 'providerRef' | 'number'>>;

/**
 * Durable tenancy state. Every read that returns customer data takes the
 * account id it is scoped to; the only unscoped lookups are the ones that
 * *establish* scope (a session's user, a called number's account).
 */
export interface TenancyStore {
  createUser(user: User, passwordHash: string): Promise<void>;
  getUser(id: string): Promise<User | null>;
  findUserByEmail(email: string): Promise<{ user: User; passwordHash: string } | null>;
  updateUser(id: string, patch: { name?: string }): Promise<User | null>;

  /** Creates the account together with its first membership, subscription and provider configuration. */
  createAccount(input: {
    account: Account;
    membership: Membership;
    subscription: Subscription;
    providerConfiguration: ProviderConfiguration;
  }): Promise<void>;
  getAccount(id: string): Promise<Account | null>;
  updateAccount(id: string, patch: { name?: string; onboardingState?: Account['onboardingState'] }): Promise<Account | null>;

  getMembership(accountId: string, userId: string): Promise<Membership | null>;
  /** Adds a user to an account; returns the existing membership if they already belong. */
  addMembership(membership: Membership): Promise<Membership>;
  removeMembership(accountId: string, userId: string): Promise<boolean>;
  listMembershipsForUser(userId: string): Promise<Membership[]>;
  listMembershipsForAccount(accountId: string): Promise<Membership[]>;

  listPhoneNumbers(accountId: string): Promise<PhoneNumber[]>;
  /** Throws PhoneNumberTakenError if the number already belongs to another account. */
  insertPhoneNumber(number: PhoneNumber): Promise<void>;
  updatePhoneNumber(accountId: string, id: string, patch: PhoneNumberPatch): Promise<PhoneNumber | null>;
  /** Establishes scope for provider webhooks: which account owns this assistant line. */
  findAssistantLine(number: string): Promise<PhoneNumber | null>;
  /** Every assistant line assigned to any account (so the pool never hands one out twice). */
  listAssignedLines(): Promise<string[]>;

  getPlane(accountId: string): Promise<Plane | null>;
  savePlane(plane: Plane): Promise<void>;

  getSubscription(accountId: string): Promise<Subscription | null>;
  findSubscriptionByStripeId(id: string): Promise<Subscription | null>;
  updateSubscription(accountId: string, patch: Partial<Pick<Subscription, 'status' | 'stripeCustomerId' | 'stripeSubscriptionId' | 'stripePriceId' | 'currentPeriodEnd'>>): Promise<Subscription | null>;
  getProviderConfiguration(accountId: string): Promise<ProviderConfiguration | null>;

  recordAudit(event: AuditEvent): Promise<void>;
  listAudit(accountId: string, limit?: number): Promise<AuditEvent[]>;
}

const LIVE: PhoneNumber['status'][] = ['pending_verification', 'verified', 'active'];
const CLAIMED: PhoneNumber['status'][] = ['verified', 'active'];

/** Same uniqueness rules as the Postgres indexes. */
export function phoneNumberConflict(existing: PhoneNumber[], candidate: PhoneNumber): boolean {
  return existing.some((other) => other.id !== candidate.id && other.number === candidate.number && other.kind === candidate.kind && (
    // An assistant line routes calls: it can belong to one account at a time.
    (candidate.kind === 'assistant_line' && LIVE.includes(other.status) && LIVE.includes(candidate.status)) ||
    // A personal number identifies the owner's texts: once verified it belongs to one account.
    (candidate.kind === 'personal' && CLAIMED.includes(other.status) && CLAIMED.includes(candidate.status))
  ));
}

export class InMemoryTenancyStore implements TenancyStore {
  private readonly users = new Map<string, { user: User; passwordHash: string }>();
  private readonly accounts = new Map<string, Account>();
  private readonly memberships = new Map<string, Membership>();
  private readonly numbers = new Map<string, PhoneNumber>();
  private readonly planes = new Map<string, Plane>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly providers = new Map<string, ProviderConfiguration>();
  private readonly audit: AuditEvent[] = [];

  async createUser(user: User, passwordHash: string): Promise<void> {
    if ([...this.users.values()].some((entry) => entry.user.email === user.email)) throw new EmailTakenError();
    this.users.set(user.id, { user: structuredClone(user), passwordHash });
  }

  async getUser(id: string): Promise<User | null> {
    return structuredClone(this.users.get(id)?.user ?? null);
  }

  async findUserByEmail(email: string): Promise<{ user: User; passwordHash: string } | null> {
    const found = [...this.users.values()].find((entry) => entry.user.email === email);
    return found ? structuredClone(found) : null;
  }

  async updateUser(id: string, patch: { name?: string }): Promise<User | null> {
    const entry = this.users.get(id);
    if (!entry) return null;
    if (patch.name !== undefined) entry.user.name = patch.name;
    entry.user.updatedAt = new Date();
    return structuredClone(entry.user);
  }

  async createAccount(input: Parameters<TenancyStore['createAccount']>[0]): Promise<void> {
    this.accounts.set(input.account.id, structuredClone(input.account));
    this.memberships.set(input.membership.id, structuredClone(input.membership));
    this.subscriptions.set(input.account.id, structuredClone(input.subscription));
    this.providers.set(input.account.id, structuredClone(input.providerConfiguration));
  }

  async getAccount(id: string): Promise<Account | null> {
    return structuredClone(this.accounts.get(id) ?? null);
  }

  async updateAccount(id: string, patch: { name?: string; onboardingState?: Account['onboardingState'] }): Promise<Account | null> {
    const account = this.accounts.get(id);
    if (!account) return null;
    if (patch.name !== undefined) account.name = patch.name;
    if (patch.onboardingState !== undefined) account.onboardingState = patch.onboardingState;
    account.updatedAt = new Date();
    return structuredClone(account);
  }

  async getMembership(accountId: string, userId: string): Promise<Membership | null> {
    return structuredClone([...this.memberships.values()].find((item) => item.accountId === accountId && item.userId === userId) ?? null);
  }

  async addMembership(membership: Membership): Promise<Membership> {
    const existing = await this.getMembership(membership.accountId, membership.userId);
    if (existing) return existing;
    this.memberships.set(membership.id, structuredClone(membership));
    return structuredClone(membership);
  }

  async removeMembership(accountId: string, userId: string): Promise<boolean> {
    const found = [...this.memberships.values()].find((item) => item.accountId === accountId && item.userId === userId);
    if (!found) return false;
    this.memberships.delete(found.id);
    return true;
  }

  async listMembershipsForUser(userId: string): Promise<Membership[]> {
    return [...this.memberships.values()].filter((item) => item.userId === userId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()).map((item) => structuredClone(item));
  }

  async listMembershipsForAccount(accountId: string): Promise<Membership[]> {
    return [...this.memberships.values()].filter((item) => item.accountId === accountId).map((item) => structuredClone(item));
  }

  async listPhoneNumbers(accountId: string): Promise<PhoneNumber[]> {
    return [...this.numbers.values()].filter((item) => item.accountId === accountId && item.status !== 'released')
      .map((item) => structuredClone(item));
  }

  async insertPhoneNumber(number: PhoneNumber): Promise<void> {
    if (phoneNumberConflict([...this.numbers.values()], number)) throw new PhoneNumberTakenError(number.number);
    this.numbers.set(number.id, structuredClone(number));
  }

  async updatePhoneNumber(accountId: string, id: string, patch: PhoneNumberPatch): Promise<PhoneNumber | null> {
    const current = this.numbers.get(id);
    if (!current || current.accountId !== accountId) return null;
    const next = { ...current, ...structuredClone(patch), updatedAt: new Date() };
    if (phoneNumberConflict([...this.numbers.values()], next)) throw new PhoneNumberTakenError(next.number);
    this.numbers.set(id, next);
    return structuredClone(next);
  }

  async findAssistantLine(number: string): Promise<PhoneNumber | null> {
    return structuredClone([...this.numbers.values()].find((item) =>
      item.kind === 'assistant_line' && item.number === number && CLAIMED.includes(item.status)) ?? null);
  }

  async listAssignedLines(): Promise<string[]> {
    return [...this.numbers.values()].filter((item) => item.kind === 'assistant_line' && LIVE.includes(item.status)).map((item) => item.number);
  }

  async getPlane(accountId: string): Promise<Plane | null> {
    return structuredClone(this.planes.get(accountId) ?? null);
  }

  async savePlane(plane: Plane): Promise<void> {
    this.planes.set(plane.accountId, structuredClone(plane));
  }

  async getSubscription(accountId: string): Promise<Subscription | null> {
    return structuredClone(this.subscriptions.get(accountId) ?? null);
  }

  async findSubscriptionByStripeId(id: string): Promise<Subscription | null> {
    return structuredClone([...this.subscriptions.values()].find((item) =>
      item.stripeCustomerId === id || item.stripeSubscriptionId === id) ?? null);
  }

  async updateSubscription(accountId: string, patch: Partial<Pick<Subscription, 'status' | 'stripeCustomerId' | 'stripeSubscriptionId' | 'stripePriceId' | 'currentPeriodEnd'>>): Promise<Subscription | null> {
    const subscription = this.subscriptions.get(accountId);
    if (!subscription) return null;
    Object.assign(subscription, structuredClone(patch), { updatedAt: new Date() });
    return structuredClone(subscription);
  }

  async getProviderConfiguration(accountId: string): Promise<ProviderConfiguration | null> {
    return structuredClone(this.providers.get(accountId) ?? null);
  }

  async recordAudit(event: AuditEvent): Promise<void> {
    this.audit.push(structuredClone(event));
  }

  async listAudit(accountId: string, limit = 100): Promise<AuditEvent[]> {
    return this.audit.filter((event) => event.accountId === accountId).slice(-limit).reverse().map((event) => structuredClone(event));
  }
}
