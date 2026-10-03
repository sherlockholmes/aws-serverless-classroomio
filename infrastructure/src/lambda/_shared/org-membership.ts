/**
 * Shared org-role auth helpers for org-scoped Lambda routes.
 *
 * Mirrors the three Hono org-role middlewares in
 * apps/api/src/middlewares/organization.ts:
 *   - orgMemberMiddleware     -> requireOrgMember     (any role in the org)
 *   - orgTeamMemberMiddleware -> requireOrgTeamMember  (ADMIN or TUTOR)
 *   - orgAdminMiddleware      -> requireOrgAdmin        (ADMIN only)
 *
 * All three read the target org id from the `cio-org-id` request header,
 * validate the Better Auth session cookie via auth.api.getSession, and look
 * up the caller's role for that org from the session's `orgRoles` map
 * (populated by the customSession plugin in packages/db/src/auth.ts — no
 * extra DB query needed).
 *
 * This lifts the local `requireOrgMember` implementation that previously
 * lived only in organization-courses-handler/index.ts so every new
 * org-scoped Lambda (team, audience, dash, onboarding, mutation, ...) can
 * import a single, tested implementation instead of re-deriving the same
 * header-parsing + session-lookup logic per handler.
 */

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { auth } from '@cio/db/auth';
import { ROLE } from '@cio/utils/constants';

export interface OrgMembership {
  userId: string;
  orgId: string;
  roleId: number;
}

/**
 * Rebuild a Fetch API Headers object from an API Gateway v2 event, including
 * cookies (event.cookies is delivered separately from event.headers by HTTP API).
 */
function buildHeaders(event: APIGatewayProxyEventV2): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value) headers.set(key, value);
  }

  if (event.cookies && event.cookies.length > 0) {
    headers.set('cookie', event.cookies.join('; '));
  }

  return headers;
}

/**
 * Resolves the authenticated session + this org's role for the caller.
 * Returns null if there is no session, no cio-org-id header, or the user
 * has no membership in that org — same rejection conditions as
 * orgMemberMiddleware.
 */
export async function requireOrgMember(event: APIGatewayProxyEventV2): Promise<OrgMembership | null> {
  const orgId = event.headers?.['cio-org-id'] ?? event.headers?.['Cio-Org-Id'];
  if (!orgId) return null;

  let session: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
  try {
    session = await auth.api.getSession({ headers: buildHeaders(event) });
  } catch (error) {
    console.error('[org-membership] getSession error:', error);
    return null;
  }

  if (!session?.user) return null;

  const orgRoles = (session as unknown as { orgRoles?: Record<string, number> }).orgRoles ?? {};
  const roleId = orgRoles[orgId];
  if (roleId === undefined) return null;

  return { userId: session.user.id, orgId, roleId };
}

/**
 * Same as requireOrgMember, but additionally rejects (returns null) unless
 * the caller's role in the org is ADMIN or TUTOR — mirrors
 * orgTeamMemberMiddleware.
 */
export async function requireOrgTeamMember(event: APIGatewayProxyEventV2): Promise<OrgMembership | null> {
  const member = await requireOrgMember(event);
  if (!member) return null;

  if (member.roleId !== ROLE.ADMIN && member.roleId !== ROLE.TUTOR) return null;

  return member;
}

/**
 * Same as requireOrgMember, but additionally rejects (returns null) unless
 * the caller's role in the org is ADMIN — mirrors orgAdminMiddleware.
 */
export async function requireOrgAdmin(event: APIGatewayProxyEventV2): Promise<OrgMembership | null> {
  const member = await requireOrgMember(event);
  if (!member) return null;

  if (member.roleId !== ROLE.ADMIN) return null;

  return member;
}
