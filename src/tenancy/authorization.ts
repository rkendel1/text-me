import { HttpError } from '../errors.js';
import type { MembershipRole } from './model.js';

/**
 * Every request that touches customer data runs as a TenantContext:
 *
 *   authenticated principal (session) → membership → authorized account → resource
 *
 * The account is never taken from the request body, a phone number, an email
 * or the deployment; it is the session's active account, re-checked against a
 * live membership on every request.
 */
export interface TenantContext {
  userId: string;
  accountId: string;
  role: MembershipRole;
  sessionId: string;
}

export type TenantAction =
  | 'account.read'
  | 'account.manage'
  | 'members.manage'
  | 'conversation.read'
  | 'conversation.control'
  | 'device.register'
  | 'device.manage'
  | 'settings.manage'
  | 'phone.manage';

const MEMBER: TenantAction[] = ['account.read', 'conversation.read', 'conversation.control', 'device.register'];
const ADMIN: TenantAction[] = [...MEMBER, 'account.manage', 'device.manage', 'settings.manage', 'phone.manage'];
const OWNER: TenantAction[] = [...ADMIN, 'members.manage'];

const PERMISSIONS: Record<MembershipRole, ReadonlySet<TenantAction>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  member: new Set(MEMBER),
};

export function can(role: MembershipRole, action: TenantAction): boolean {
  return PERMISSIONS[role]?.has(action) ?? false;
}

/** Fails closed: an unknown role, a missing context or a missing permission is a refusal. */
export function authorize(context: TenantContext | undefined, action: TenantAction): TenantContext {
  if (!context) throw new HttpError(401, 'Authentication required', 'unauthenticated');
  if (!can(context.role, action)) throw new HttpError(403, 'You don’t have permission to do that in this account.', 'forbidden');
  return context;
}

/**
 * The resource half of the check: a resource that belongs to another account
 * is reported as not found, so ids from other tenants reveal nothing.
 */
export function assertOwnedBy<T extends { accountId?: string | null }>(
  resource: T | null | undefined,
  accountId: string,
  notFound = 'Not found',
): T {
  if (!resource || !resource.accountId || resource.accountId !== accountId) throw new HttpError(404, notFound);
  return resource;
}

/**
 * Background work carries its ownership with it. A worker (the live call
 * applying a command, the Mac bridge claiming a reply target, a notification
 * delivery) re-checks that the job and the resource it acts on belong to the
 * same account before doing anything; retries keep the original account.
 */
export interface TenantJob {
  id: string;
  accountId: string;
  resourceId: string;
}

export class CrossTenantJobError extends Error {
  constructor(job: TenantJob, resourceAccountId: string | undefined) {
    super(`Job ${job.id} belongs to ${job.accountId} but its resource ${job.resourceId} belongs to ${resourceAccountId ?? 'no account'}`);
  }
}

export function assertJobOwnership(job: TenantJob, resource: { accountId?: string | null } | null | undefined): void {
  if (!resource || !resource.accountId || resource.accountId !== job.accountId) {
    throw new CrossTenantJobError(job, resource?.accountId ?? undefined);
  }
}
