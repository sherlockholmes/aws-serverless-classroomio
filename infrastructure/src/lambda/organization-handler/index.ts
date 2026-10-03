/**
 * Organization Lambda Handler
 *
 * Handles:
 * - GET /organization              (query: siteName, customDomain, isCustomDomainVerified)
 * - GET /organization/first         (self-hosted single-org mode)
 * - POST /organization/auto-join    (idempotent self-join for authenticated users)
 *
 * Mirrors apps/api/src/routes/organization/organization.ts's `/`, `/first`
 * and `/auto-join` handlers. Required by the dashboard's root
 * +layout.server.ts (getOrgSiteInfo in layout-setup.ts), which calls these
 * routes with PRIVATE_SERVER_KEY (no user session) on every SSR page load to
 * resolve which org owns the current host/subdomain/custom-domain, and by
 * the dashboard's `setupApp` auto-join flow when an authenticated user lands
 * on a tenant site they aren't yet a member of.
 *
 * Reuses the real query-layer functions from @cio/db (not hand-rolled SQL)
 * so the response shape stays in sync with apps/api — bundled from the
 * monorepo root (bundleFromMonorepoRoot: true in api-stack.ts), same
 * pattern as auth-handler / account-profile.
 *
 * `/auto-join` mirrors apps/api/src/services/organization/auto-join.ts's
 * `autoJoinOrg`, reusing the same @cio/db/queries/organization(/invite)
 * functions (not importable from apps/api's own service file, which sits
 * behind the `@api/*` alias this standalone Lambda bundle can't resolve).
 *
 * KNOWN GAP: the real `autoJoinOrg` calls `assertStudentCapacityOrThrow`
 * (apps/api/src/services/organization/student-limit.ts), which — beyond
 * the plan/self-hosted capacity check reimplemented below — also
 * fire-and-forgets a one-time "student limit approaching/reached" admin
 * notification email the first time an org crosses 50%/100% of its plan's
 * student cap. That notification email is NOT ported here (it's a
 * fire-and-forget side effect that never blocks the response and doesn't
 * affect the join outcome), only the blocking capacity check itself.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getOrganizations, getFirstOrganizationWithPlans } from '@cio/db/queries/organization';
import {
  createOrganizationMember,
  getActiveOrganizationPlan,
  countActiveStudents,
  getOrganizationById,
  getOrganizationMemberIdByOrgAndProfile,
  getActivePendingOrgInviteForEmail,
  selectOrganizationMemberByOrgAndNormalizedEmail,
  updateOrganizationMemberById
} from '@cio/db/queries/organization';
import { getProfileById } from '@cio/db/queries/auth';
import { db } from '@cio/db/drizzle';
import { getStudentLimit } from '@cio/utils/plans';
import { ROLE } from '@cio/utils/constants';
import { AppError, ErrorCodes } from '@cio/utils/errors';

import { isValidApiKey } from '../_shared/api-key';
import { getSessionUserId } from '../_shared/session';

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function parseBooleanParam(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/**
 * GET /organization/first — self-hosted single-org mode.
 */
async function handleGetFirst(): Promise<APIGatewayProxyResultV2> {
  try {
    const org = await getFirstOrganizationWithPlans();
    return jsonResponse(200, { success: true, data: org ? [org] : [] });
  } catch (error) {
    console.error('[organization-handler] getFirst error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch first organization' });
  }
}

/**
 * GET /organization — filtered lookup (siteName / customDomain).
 */
async function handleGetFiltered(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const query = event.queryStringParameters || {};
    const filters = {
      siteName: query.siteName || undefined,
      customDomain: query.customDomain || undefined,
      isCustomDomainVerified: parseBooleanParam(query.isCustomDomainVerified)
    };

    const organizations = await getOrganizations(filters);
    return jsonResponse(200, { success: true, data: organizations });
  } catch (error) {
    console.error('[organization-handler] getFiltered error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch organizations' });
  }
}

interface AutoJoinResult {
  alreadyMember: boolean;
  linkedExistingMember: boolean;
  pendingInvite?: boolean;
}

/**
 * Mirrors assertStudentCapacityOrThrow's blocking capacity check (see module
 * doc KNOWN GAP for the milestone-notification-email side effect that is
 * intentionally not ported here).
 */
async function assertStudentCapacityOrThrow(orgId: string, additionalStudents: number): Promise<void> {
  if (additionalStudents <= 0) return;
  if (process.env.PUBLIC_IS_SELFHOSTED === 'true') return;

  const activePlan = await getActiveOrganizationPlan(orgId);
  const limit = getStudentLimit(activePlan?.planName);
  if (!Number.isFinite(limit)) return;

  const currentCount = await countActiveStudents(orgId);
  const newCount = currentCount + additionalStudents;

  if (newCount > limit) {
    throw new AppError(
      `This organization has reached its ${limit}-student limit on the Free plan`,
      ErrorCodes.UPGRADE_REQUIRED,
      403
    );
  }
}

/**
 * Links a pre-existing org roster row (audience import, team invite, tutor
 * add) that was created with email but no profile_id yet. Preserves the
 * existing role (TUTOR, ADMIN, etc.) — does not downgrade to STUDENT.
 */
async function linkExistingMemberByEmail(
  userId: string,
  orgId: string,
  normalizedEmail: string
): Promise<AutoJoinResult | null> {
  const existingMemberByEmail = await selectOrganizationMemberByOrgAndNormalizedEmail(db, orgId, normalizedEmail);

  if (!existingMemberByEmail) {
    return null;
  }

  if (existingMemberByEmail.profileId && existingMemberByEmail.profileId !== userId) {
    throw new AppError('Email is already linked to another profile', ErrorCodes.CONFLICT, 409);
  }

  if (!existingMemberByEmail.profileId) {
    await updateOrganizationMemberById(db, existingMemberByEmail.id, {
      profileId: userId,
      email: normalizedEmail,
      verified: true
    });

    return { alreadyMember: true, linkedExistingMember: true };
  }

  return { alreadyMember: true, linkedExistingMember: false };
}

/**
 * Mirrors autoJoinOrg — idempotently joins the authenticated user to orgId.
 * New members are created as STUDENT when no roster row or invite applies.
 */
async function autoJoinOrg(userId: string, orgId: string): Promise<AutoJoinResult> {
  const existingMemberId = await getOrganizationMemberIdByOrgAndProfile(orgId, userId);
  if (existingMemberId) {
    return { alreadyMember: true, linkedExistingMember: false };
  }

  const profile = await getProfileById(userId);
  if (!profile?.email) {
    throw new AppError('Profile email not found', ErrorCodes.NOT_FOUND, 404);
  }

  const normalizedEmail = profile.email.toLowerCase().trim();

  const pendingInvite = await getActivePendingOrgInviteForEmail(orgId, normalizedEmail);
  if (pendingInvite) {
    return { alreadyMember: false, linkedExistingMember: false, pendingInvite: true };
  }

  const linked = await linkExistingMemberByEmail(userId, orgId, normalizedEmail);
  if (linked) {
    return linked;
  }

  const organization = await getOrganizationById(orgId);
  if (!organization) {
    throw new AppError('Organization not found', ErrorCodes.NOT_FOUND, 404);
  }

  if (organization.disableSignup) {
    throw new AppError('Signup is disabled for this organization', ErrorCodes.FORBIDDEN, 403);
  }

  const settings = organization.settings as { signup?: { inviteOnly?: boolean } } | null;
  if (settings?.signup?.inviteOnly) {
    throw new AppError('This organization requires an invitation to join', ErrorCodes.FORBIDDEN, 403);
  }

  await assertStudentCapacityOrThrow(orgId, 1);

  await createOrganizationMember({
    organizationId: orgId,
    profileId: userId,
    email: normalizedEmail,
    roleId: ROLE.STUDENT,
    verified: true
  });

  return { alreadyMember: false, linkedExistingMember: false };
}

/**
 * POST /organization/auto-join — requires a valid session (matches Hono's
 * authMiddleware, no org-role check per design.md — tenant-site auto-join
 * intentionally has no admin/student membership guard, unlike self-hosted's
 * auto-enroll path).
 */
async function handleAutoJoin(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = await getSessionUserId(event);
  if (!userId) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const orgId = event.headers?.['cio-org-id'] ?? event.headers?.['Cio-Org-Id'];
  if (!orgId) {
    return jsonResponse(400, { success: false, error: 'Organization ID is required', code: 'ORG_ID_REQUIRED' });
  }

  try {
    const result = await autoJoinOrg(userId, orgId);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[organization-handler] autoJoin error:', error);

    if (error instanceof AppError) {
      return jsonResponse(error.statusCode, { success: false, error: error.message });
    }

    return jsonResponse(500, { success: false, message: 'Failed to auto-join organization' });
  }
}

/**
 * Lambda handler
 *
 * GET /organization and /organization/first accept EITHER a valid Better
 * Auth session (browser calls, matching apps/api's authOrApiKeyMiddleware)
 * OR a valid PRIVATE_SERVER_KEY bearer token (dashboard SSR, no user
 * session). POST /organization/auto-join requires a real user session
 * (matches Hono's plain authMiddleware — no API-key branch).
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  if (path.endsWith('/organization/auto-join') && method === 'POST') {
    return handleAutoJoin(event);
  }

  const hasValidApiKey = isValidApiKey(event);

  if (!hasValidApiKey) {
    const userId = await getSessionUserId(event);
    if (!userId) {
      return jsonResponse(401, { success: false, message: 'Unauthorized: Missing or invalid API key' });
    }
  }

  if (path.endsWith('/organization/first')) {
    return handleGetFirst();
  }

  return handleGetFiltered(event);
}
