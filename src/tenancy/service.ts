import { HttpError } from '../errors.js';
import type { AssistantBehavior, OwnerConfigurationService } from '../owner/configuration.js';
import type { PhoneNumberService } from '../telephony/phone-number.js';
import type { TenantContext } from './authorization.js';
import type { NotificationChannelResolver } from './channels.js';
import {
  createAccountId,
  createAuditEventId,
  createMembershipId,
  createPlaneId,
  createUserId,
  DEFAULT_ENTITLEMENTS,
  isValidEmail,
  normalizeEmail,
  ONBOARDING_STATES,
  type Account,
  type Membership,
  type OnboardingState,
  type Plane,
  type User,
} from './model.js';
import { hashPassword, passwordProblem, verifyPassword } from './passwords.js';
import { EmailTakenError, type TenancyStore } from './store.js';

export interface OnboardingStep {
  id: 'account' | 'identity' | 'phone' | 'application' | 'notifications';
  label: string;
  done: boolean;
}

export interface OnboardingView {
  state: OnboardingState;
  ready: boolean;
  steps: OnboardingStep[];
  /** The first step that isn't done, if any. */
  next: OnboardingStep['id'] | null;
}

const cleanName = (value: unknown, max = 80): string => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');

/**
 * Accounts, users and memberships, and the onboarding state machine:
 *
 *   account_created → identity_configured → phone_configured
 *     → application_configured → notifications_configured → ready
 *
 * The state is derived from durable facts (a name, a verified line and number,
 * a plane, a working notification channel), persisted on the account, and
 * sticky once ready. The existing owner migrated from the single-user
 * deployment goes through exactly the same evaluation.
 */
export class TenancyService {
  constructor(
    private readonly store: TenancyStore,
    private readonly deps: {
      configuration: OwnerConfigurationService;
      phoneNumbers?: PhoneNumberService;
      channels?: NotificationChannelResolver;
      now?: () => number;
    },
  ) {}

  private now(): Date {
    return new Date(this.deps.now?.() ?? Date.now());
  }

  async audit(accountId: string, type: string, detail: Record<string, unknown> = {}, userId?: string): Promise<void> {
    await this.store.recordAudit({ id: createAuditEventId(), accountId, userId, type, detail, occurredAt: this.now() });
  }

  /** Anyone can create an account: a user, an account, and an owner membership between them. */
  async signUp(input: { email: unknown; password: unknown; name?: unknown; accountName?: unknown }):
    Promise<{ user: User; account: Account; membership: Membership }> {
    const email = typeof input.email === 'string' ? normalizeEmail(input.email) : '';
    if (!isValidEmail(email)) throw new HttpError(400, 'Enter a valid email address.', 'invalid_email');
    const problem = passwordProblem(input.password);
    if (problem) throw new HttpError(400, problem, 'weak_password');
    const now = this.now();
    const user: User = { id: createUserId(), name: cleanName(input.name), email, createdAt: now, updatedAt: now };
    try {
      await this.store.createUser(user, await hashPassword(input.password as string));
    } catch (error) {
      if (error instanceof EmailTakenError) throw new HttpError(409, error.message, 'email_taken');
      throw error;
    }
    const { account, membership } = await this.createAccount(user.id, cleanName(input.accountName) || user.name);
    return { user, account, membership };
  }

  async signIn(emailInput: unknown, password: unknown): Promise<User | null> {
    const email = typeof emailInput === 'string' ? normalizeEmail(emailInput) : '';
    const found = email ? await this.store.findUserByEmail(email) : null;
    // verifyPassword does the same work for unknown emails, so timing doesn't reveal who has an account.
    const ok = await verifyPassword(typeof password === 'string' ? password : '', found?.passwordHash);
    return ok && found ? found.user : null;
  }

  /** A user can own several accounts; each is its own tenant with its own line, devices and data. */
  async createAccount(userId: string, name: string): Promise<{ account: Account; membership: Membership }> {
    const existing = await this.store.listMembershipsForUser(userId);
    if (existing.length >= DEFAULT_ENTITLEMENTS.maxAccountsPerUser) {
      throw new HttpError(403, 'You’ve reached the number of accounts you can create.', 'entitlement');
    }
    const now = this.now();
    const account: Account = { id: createAccountId(), name: cleanName(name), onboardingState: 'account_created', createdAt: now, updatedAt: now };
    const membership: Membership = { id: createMembershipId(), accountId: account.id, userId, role: 'owner', createdAt: now };
    await this.store.createAccount({
      account,
      membership,
      subscription: { accountId: account.id, plan: 'standard', status: 'active', entitlements: DEFAULT_ENTITLEMENTS, createdAt: now, updatedAt: now },
      providerConfiguration: { accountId: account.id, telephonyProvider: 'twilio', messagingProvider: 'twilio', settings: {}, updatedAt: now },
    });
    await this.audit(account.id, 'account.created', { membershipId: membership.id }, userId);
    return { account, membership };
  }

  /** principal + membership → the account this request may act on, or null (fail closed). */
  async resolveContext(userId: string, accountId: string, sessionId: string): Promise<TenantContext | null> {
    if (!userId || !accountId) return null;
    const membership = await this.store.getMembership(accountId, userId);
    if (!membership || membership.userId !== userId || membership.accountId !== accountId) return null;
    return { userId, accountId, role: membership.role, sessionId };
  }

  getUser(userId: string) {
    return this.store.getUser(userId);
  }

  getAccount(accountId: string) {
    return this.store.getAccount(accountId);
  }

  getPlane(accountId: string) {
    return this.store.getPlane(accountId);
  }

  getSubscription(accountId: string) {
    return this.store.getSubscription(accountId);
  }

  listAudit(accountId: string, limit?: number) {
    return this.store.listAudit(accountId, limit);
  }

  async memberships(userId: string): Promise<Array<Membership & { accountName: string }>> {
    const memberships = await this.store.listMembershipsForUser(userId);
    return Promise.all(memberships.map(async (membership) => ({
      ...membership, accountName: (await this.store.getAccount(membership.accountId))?.name ?? '',
    })));
  }

  async members(accountId: string): Promise<Array<{ userId: string; name: string; email: string; role: Membership['role'] }>> {
    const memberships = await this.store.listMembershipsForAccount(accountId);
    return Promise.all(memberships.map(async (membership) => {
      const user = await this.store.getUser(membership.userId);
      return { userId: membership.userId, name: user?.name ?? '', email: user?.email ?? '', role: membership.role };
    }));
  }

  /** An owner adds an existing user to the account. Roles decide what they can do; the account still owns everything. */
  async addMember(context: TenantContext, input: { email?: unknown; role?: unknown }): Promise<Membership> {
    const email = typeof input.email === 'string' ? normalizeEmail(input.email) : '';
    const role = input.role === 'admin' ? 'admin' : input.role === 'member' ? 'member' : null;
    if (!role) throw new HttpError(400, 'Role must be admin or member.');
    const found = email ? await this.store.findUserByEmail(email) : null;
    if (!found) throw new HttpError(404, 'No one has signed up with that email yet.', 'user_not_found');
    const members = await this.store.listMembershipsForAccount(context.accountId);
    const subscription = await this.store.getSubscription(context.accountId);
    if (members.length >= (subscription?.entitlements.maxMembers ?? DEFAULT_ENTITLEMENTS.maxMembers)) {
      throw new HttpError(403, 'This account has as many members as its plan allows.', 'entitlement');
    }
    const membership = await this.store.addMembership({
      id: createMembershipId(), accountId: context.accountId, userId: found.user.id, role, createdAt: this.now(),
    });
    await this.audit(context.accountId, 'membership.added', { userId: found.user.id, role }, context.userId);
    return membership;
  }

  async removeMember(context: TenantContext, userId: string): Promise<void> {
    const target = await this.store.getMembership(context.accountId, userId);
    if (!target) throw new HttpError(404, 'Not a member of this account.');
    if (target.role === 'owner') {
      const owners = (await this.store.listMembershipsForAccount(context.accountId)).filter((membership) => membership.role === 'owner');
      if (owners.length <= 1) throw new HttpError(409, 'An account always keeps at least one owner.');
    }
    await this.store.removeMembership(context.accountId, userId);
    await this.audit(context.accountId, 'membership.removed', { userId }, context.userId);
  }

  async updateProfile(userId: string, input: { name?: unknown }): Promise<User> {
    const name = cleanName(input.name);
    if (!name) throw new HttpError(400, 'Enter your name.', 'invalid_name');
    const user = await this.store.updateUser(userId, { name });
    if (!user) throw new HttpError(404, 'User not found');
    return user;
  }

  /** Onboarding: who you are. Your name is also how the assistant introduces you on this account's line. */
  async configureIdentity(context: TenantContext, input: { name?: unknown; accountName?: unknown }): Promise<OnboardingView> {
    const user = await this.updateProfile(context.userId, input);
    const account = await this.store.getAccount(context.accountId);
    const accountName = cleanName(input.accountName) || account?.name || user.name;
    await this.store.updateAccount(context.accountId, { name: accountName });
    await this.deps.configuration.update(context.accountId, { assistant: { ownerName: user.name.split(' ')[0] } }, 'onboarding');
    await this.audit(context.accountId, 'onboarding.identity_configured', {}, context.userId);
    return this.refreshOnboarding(context.accountId);
  }

  /** Onboarding: the application/plane — the assistant that answers this account's line. */
  async configurePlane(context: TenantContext, input: { name?: unknown; behavior?: unknown }): Promise<Plane> {
    const behaviors: AssistantBehavior[] = ['automatic', 'ask_when_unsure', 'ask_before_commitments'];
    const behavior = behaviors.includes(input.behavior as AssistantBehavior) ? input.behavior as AssistantBehavior : undefined;
    const name = cleanName(input.name, 60);
    const existing = await this.store.getPlane(context.accountId);
    const now = this.now();
    const plane: Plane = existing
      ? { ...existing, name: name || existing.name, updatedAt: now }
      : { id: createPlaneId(), accountId: context.accountId, name: name || 'Assistant', status: 'active', createdAt: now, updatedAt: now };
    await this.store.savePlane(plane);
    await this.deps.configuration.update(context.accountId, {
      assistant: { assistantName: plane.name, ...(behavior ? { behavior } : {}) },
    }, 'onboarding');
    if (!existing) await this.audit(context.accountId, 'plane.created', { planeId: plane.id }, context.userId);
    await this.refreshOnboarding(context.accountId);
    return plane;
  }

  /** Where the account is in setup, from durable facts. `ready` is sticky: later changes never lock an account out. */
  async onboarding(accountId: string): Promise<OnboardingView> {
    const account = await this.store.getAccount(accountId);
    if (!account) throw new HttpError(404, 'Account not found');
    const [configuration, numbers, plane, channels] = await Promise.all([
      this.deps.configuration.get(accountId),
      this.store.listPhoneNumbers(accountId),
      this.store.getPlane(accountId),
      this.deps.channels?.list(accountId) ?? Promise.resolve([]),
    ]);
    const line = numbers.find((number) => number.kind === 'assistant_line');
    const personal = numbers.find((number) => number.kind === 'personal' && (number.status === 'verified' || number.status === 'active'));
    const steps: OnboardingStep[] = [
      { id: 'account', label: 'Account created', done: true },
      { id: 'identity', label: 'Your name', done: configuration.assistant.ownerName.trim().length > 0 },
      { id: 'phone', label: 'Your number', done: line?.status === 'active' && Boolean(personal) },
      { id: 'application', label: 'Your assistant', done: Boolean(plane) },
      { id: 'notifications', label: 'Notifications', done: channels.some((channel) => channel.enabled && channel.available) },
    ];
    const firstOpen = steps.findIndex((step) => !step.done);
    const derived: OnboardingState = firstOpen === -1 ? 'ready' : ONBOARDING_STATES[firstOpen - 1];
    const state = account.onboardingState === 'ready' ? 'ready' : derived;
    return { state, ready: state === 'ready', steps, next: firstOpen === -1 ? null : steps[firstOpen].id };
  }

  async refreshOnboarding(accountId: string): Promise<OnboardingView> {
    const view = await this.onboarding(accountId);
    const account = await this.store.getAccount(accountId);
    if (account && account.onboardingState !== view.state) {
      await this.store.updateAccount(accountId, { onboardingState: view.state });
      await this.audit(accountId, 'onboarding.state_changed', { from: account.onboardingState, to: view.state });
    }
    return view;
  }
}
