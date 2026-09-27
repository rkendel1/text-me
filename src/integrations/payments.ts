export type EntitlementState = 'pending' | 'active' | 'expired' | 'revoked' | 'billing_retry' | 'grace_period';
export type EntitlementSource = 'direct_purchase' | 'shared_entitlement' | 'web';

export interface VerifiedTransaction {
  transactionId: string;
  userId: string;
  productId: string;
  state: EntitlementState;
  source?: EntitlementSource;
  expiresAt?: Date;
  verifiedAt: Date;
}

export interface TransactionVerifier {
  verify(transaction: unknown): Promise<VerifiedTransaction>;
}

export interface Entitlement {
  userId: string;
  productId: string;
  state: EntitlementState;
  source?: EntitlementSource;
  transactionId: string;
  expiresAt?: Date;
  verifiedAt: Date;
}

export class EntitlementService {
  private readonly entitlements = new Map<string, Entitlement>();

  constructor(private readonly verifier: TransactionVerifier) {}

  async applyTransaction(transaction: unknown): Promise<Entitlement> {
    const verified = await this.verifier.verify(transaction);
    const entitlement: Entitlement = {
      userId: verified.userId,
      productId: verified.productId,
      state: verified.state,
      ...(verified.source ? { source: verified.source } : {}),
      transactionId: verified.transactionId,
      ...(verified.expiresAt ? { expiresAt: verified.expiresAt } : {}),
      verifiedAt: verified.verifiedAt,
    };
    this.entitlements.set(`${entitlement.userId}:${entitlement.productId}`, entitlement);
    return entitlement;
  }

  get(userId: string, productId: string): Entitlement | null {
    return this.entitlements.get(`${userId}:${productId}`) ?? null;
  }

  hasActiveEntitlement(userId: string, productId: string, now = Date.now()): boolean {
    const entitlement = this.get(userId, productId);
    if (!entitlement) return false;
    if (entitlement.state === 'grace_period' || entitlement.state === 'billing_retry') return true;
    return entitlement.state === 'active' &&
      (!entitlement.expiresAt || entitlement.expiresAt.getTime() > now);
  }
}
