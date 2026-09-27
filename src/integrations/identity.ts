import { randomBytes } from 'node:crypto';

export type IdentityProvider = 'apple' | 'google' | 'email';

export interface ProviderIdentity {
  id: string;
  userId: string;
  provider: IdentityProvider;
  /** The provider subject is stable; email is only profile data. */
  subject: string;
  email?: string;
  revokedAt?: Date;
  createdAt: Date;
}

export interface VerifiedIdentity {
  provider: IdentityProvider;
  subject: string;
  email?: string;
}

export interface IdentityStore {
  find(provider: IdentityProvider, subject: string): Promise<ProviderIdentity | null>;
  save(identity: ProviderIdentity): Promise<void>;
  list(userId: string): Promise<ProviderIdentity[]>;
}

export class InMemoryIdentityStore implements IdentityStore {
  private readonly identities = new Map<string, ProviderIdentity>();

  async find(provider: IdentityProvider, subject: string): Promise<ProviderIdentity | null> {
    const identity = this.identities.get(`${provider}:${subject}`);
    return identity ? structuredClone(identity) : null;
  }

  async save(identity: ProviderIdentity): Promise<void> {
    this.identities.set(`${identity.provider}:${identity.subject}`, structuredClone(identity));
  }

  async list(userId: string): Promise<ProviderIdentity[]> {
    return [...this.identities.values()]
      .filter((identity) => identity.userId === userId)
      .map((identity) => structuredClone(identity));
  }
}

export class IdentityService {
  constructor(
    private readonly store: IdentityStore,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(verified: VerifiedIdentity): Promise<ProviderIdentity | null> {
    const identity = await this.store.find(verified.provider, verified.subject);
    if (!identity || identity.revokedAt) return null;
    return identity;
  }

  async link(userId: string, verified: VerifiedIdentity): Promise<ProviderIdentity> {
    const existing = await this.store.find(verified.provider, verified.subject);
    if (existing && existing.userId !== userId && !existing.revokedAt) {
      throw new Error('Provider identity is already linked to another user');
    }
    const identity: ProviderIdentity = {
      id: existing?.id ?? `ident_${randomBytes(9).toString('hex')}`,
      userId,
      provider: verified.provider,
      subject: verified.subject,
      ...(verified.email ? { email: verified.email } : {}),
      createdAt: existing?.createdAt ?? new Date(this.now()),
    };
    await this.store.save(identity);
    return identity;
  }

  async revoke(userId: string, provider: IdentityProvider): Promise<boolean> {
    const identities = await this.store.list(userId);
    const identity = identities.find((item) => item.provider === provider && !item.revokedAt);
    if (!identity) return false;
    await this.store.save({ ...identity, revokedAt: new Date(this.now()) });
    return true;
  }
}
