import type { Session } from '@appport/protocol';

import { can, type TenantContext } from '../tenancy/authorization.js';

/** The AppPort application the call capabilities belong to. */
export const CALL_APPLICATION_ID = 'app.justtextme.calls';

export const CALL_PERMISSIONS = {
  /** Start a call (outbound). Account admins and owners. */
  create: 'call.create',
  /** See calls. Every member. */
  read: 'call.read',
  /** End a call. Every member who may control conversations. */
  control: 'call.control',
  /** Record a call that already exists at the provider. Only the telephony webhook; never a user. */
  ingest: 'call.ingest',
} as const;

const createdAt = () => new Date().toISOString();

/**
 * An account member's AppPort session, derived from the already-authorized tenant context.
 * The account is carried as a session attribute, never taken from capability input, and the
 * permissions are exactly what the member's role already allows.
 */
export function appPortSessionFor(tenant: TenantContext): Session {
  const permissions: string[] = [];
  if (can(tenant.role, 'conversation.read')) permissions.push(CALL_PERMISSIONS.read);
  if (can(tenant.role, 'conversation.control')) permissions.push(CALL_PERMISSIONS.control);
  if (can(tenant.role, 'phone.manage')) permissions.push(CALL_PERMISSIONS.create);
  return {
    id: tenant.sessionId,
    applicationId: CALL_APPLICATION_ID,
    createdAt: createdAt(),
    principal: { id: tenant.userId, type: 'user', attributes: { role: tenant.role } },
    permissions,
    attributes: { accountId: tenant.accountId },
  };
}

/**
 * The telephony webhook's session for one account. The account comes from resolving the number
 * that was called (the only thing that says whose call it is), never from the request body.
 */
export function telephonySessionFor(accountId: string): Session {
  return {
    id: `telephony:${accountId}`,
    applicationId: CALL_APPLICATION_ID,
    createdAt: createdAt(),
    principal: { id: 'system:telephony', type: 'application' },
    permissions: [CALL_PERMISSIONS.create, CALL_PERMISSIONS.read, CALL_PERMISSIONS.control, CALL_PERMISSIONS.ingest],
    attributes: { accountId },
  };
}
