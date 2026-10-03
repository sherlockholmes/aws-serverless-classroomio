/**
 * Invite Handler Lambda
 *
 * Handles:
 * - GET    /invite/organization/pending             (session, lenient — pending org invite for caller)
 * - POST   /invite/organization/:inviteId/accept-by-id (session — accept by invite ID)
 * - GET    /invite/organization/:token/preview       (API key — server-only preview)
 * - POST   /invite/organization/:token/accept        (session — accept by token)
 * - GET    /invite/link/:token/preview                (API key — server-only preview)
 * - POST   /invite/link/:token/accept                 (session — join via reusable link invite)
 *
 * Mirrors apps/api/src/routes/invite/invite.ts's `inviteRouter`, mounted at
 * `/invite`. Required by the dashboard's `/invite/[hash]` and
 * `/invite/link/[hash]` pages (organization + link invite accept flows) —
 * this Lambda group was entirely missing prior to this change, so every
 * "Accept invitation" link 404'd at API Gateway (no route registered at
 * all, not an application-level 404).
 *
 * The service logic backing these routes
 * (apps/api/src/services/organization/invite.ts) lives behind the `@api/*`
 * alias, which this standalone Lambda bundle can't resolve — its
 * business logic (status derivation, email-match enforcement, course/cohort
 * auto-enrollment on accept, invite audit trail writes) is reimplemented
 * directly below using only @cio/db/@cio/core/@cio/utils imports, following
 * the real Hono service line-for-line. `AppError`/`ErrorCodes` come from
 * `@cio/utils/errors` (NOT `@api/utils/errors`, which is itself
 * `@api/*`-aliased) — same swap used in every other Lambda this session.
 *
 * `parseCourseIdsFromInviteMetadata` / `parseCohortIdsFromInviteMetadata` are
 * copied verbatim from apps/api/src/utils/org.ts (pure functions, no
 * dependencies) — same "copy verbatim" precedent as
 * `deriveAudienceMemberStatus` in organization-audience-handler.
 *
 * `assertStudentCapacityOrThrow` (apps/api/src/services/organization/
 * student-limit.ts) is reimplemented locally as
 * `assertStudentCapacityOrThrowLocal`, replicating only the blocking
 * capacity check — same precedent as organization-handler's own local copy
 * of the same function. The milestone admin-notification email
 * (fire-and-forget side effect, never blocks the response) is intentionally
 * NOT ported — see KNOWN GAPS below.
 *
 * KNOWN GAPS (intentional scope cuts for this first pass):
 *
 * (a) Rate limiting (`createRateLimiter` from `@api/middlewares/
 *     rate-limiter`, Redis-backed) is NOT ported. None of the 7 real Hono
 *     routes' per-route rate limiters (preview/accept/pending flood
 *     protection) apply here. This mirrors the established pattern of
 *     documenting Redis-dependent middleware gaps elsewhere in this
 *     codebase (e.g. dash-handler's caching-only, not rate-limiting, use of
 *     Redis) — a standalone Lambda has no shared Redis-backed limiter
 *     wired up, and building one is separate, larger infrastructure work.
 * (b) `GET /invite/student/:token` (course-level invite preview, backed by
 *     apps/api/src/services/course/invite.ts's `previewStudentInvite`) is
 *     NOT implemented. Its dependencies (`countInviteDistinctPreviewIps`,
 *     `getCourseInviteByTokenHash`, `createCourseInviteAudit` from
 *     `@cio/db/queries/course/invite`, plus `getProfileByEmail` from
 *     `@cio/db/queries/auth`) ARE all resolvable from `@cio/db`/`@cio/utils`
 *     — this route is not blocked by an unportable dependency, it's simply
 *     out of scope for this pass because it is a *different* invite family
 *     (course-level, not organization/link-level) or the user's currently
 *     reported bug. The route dispatcher below returns a clean 404 for it
 *     rather than crashing, so a future pass can port it without any
 *     architecture change here.
 * (c) The milestone "student limit approaching/reached" one-time admin
 *     notification email (part of the real `assertStudentCapacityOrThrow`)
 *     is not sent by the local capacity-check reimplementation — only the
 *     blocking check itself is ported. Same gap already documented in
 *     organization-handler's `assertStudentCapacityOrThrow` local copy.
 * (d) `inviteTeamMembers` (ADMIN/TUTOR team invites, a different flow that
 *     creates+emails brand-new org invites) is out of scope — this Lambda
 *     only covers invite *preview/accept*, not creation. Team invite
 *     creation continues to be handled by organization-team-handler /
 *     organization-audience-handler where applicable.
 *
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/db + better-auth.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import * as crypto from 'node:crypto';
import { db, type DbOrTxClient } from '@cio/db/drizzle';
import { ROLE } from '@cio/utils/constants';
import { AppError, ErrorCodes } from '@cio/utils/errors';
import { getStudentLimit } from '@cio/utils/plans';
import {
  claimPendingOrganizationInvite,
  createOrganizationInviteAudit,
  createOrganizationMember,
  countActiveStudents,
  getActiveOrganizationPlan,
  getActivePendingOrgInviteForEmail,
  getOrganizationInviteByTokenHash,
  getOrgLinkInviteWithOrg,
  selectOrganizationInviteWithOrgByInviteId,
  selectOrganizationInviteWithOrgByTokenHash,
  selectOrganizationMemberByOrgAndNormalizedEmail,
  selectOrganizationMemberByOrgAndProfile,
  updateOrganizationMemberById,
  type TOrganizationInviteAcceptRow
} from '@cio/db/queries/organization';
import { getCourseGroupIds } from '@cio/db/queries/course';
import { enrollUsersInCourseGroups } from '@cio/db/queries/group';
import { addCohortMember, getCourseIdsByCohortIds, getExistingCohortMembers } from '@cio/db/queries/cohort';
import { markUserAndProfileEmailVerified } from '@cio/db/queries/auth';
import { invalidateOrgStats } from '@cio/core/utils/redis/org-stats-cache';

import { isValidApiKey } from '../_shared/api-key';
import { getSessionUser } from '../_shared/session';

type OrganizationInviteStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'ACCEPTED';

interface TInviteRequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

interface TAuthUser {
  id: string;
  email?: string | null;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function errorResponse(error: unknown, fallbackMessage: string): APIGatewayProxyResultV2 {
  if (error instanceof AppError) {
    return jsonResponse(error.statusCode, { success: false, message: error.message });
  }

  console.error('[invite-handler]', fallbackMessage, error);
  return jsonResponse(500, { success: false, message: fallbackMessage });
}

function getClientIp(event: APIGatewayProxyEventV2): string | null {
  return event.requestContext?.http?.sourceIp ?? null;
}

function getUserAgent(event: APIGatewayProxyEventV2): string | null {
  return event.headers?.['user-agent'] ?? event.headers?.['User-Agent'] ?? null;
}

function getRequestContext(event: APIGatewayProxyEventV2): TInviteRequestContext {
  return { ipAddress: getClientIp(event), userAgent: getUserAgent(event) };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors ZOrganizationInviteTokenParam: { token: string (10-512 chars) }. */
function isValidTokenParam(token: string | undefined): token is string {
  return typeof token === 'string' && token.length >= 10 && token.length <= 512;
}

/**
 * Copied verbatim from apps/api/src/utils/org.ts — pure functions with no
 * external dependencies, so they're safe to duplicate here rather than
 * import (that file lives behind the `@api/*` alias, which this standalone
 * Lambda bundle can't resolve).
 */
function parseInviteIds(metadata: unknown, keys: string[]): string[] {
  let obj: Record<string, unknown> | null = null;
  if (metadata == null) {
    return [];
  }
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      obj = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return [];
    }
  } else if (typeof metadata === 'object') {
    obj = metadata as Record<string, unknown>;
  }
  if (!obj) {
    return [];
  }

  const raw = keys.map((key) => obj![key]).find((value) => value !== undefined);
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function parseCourseIdsFromInviteMetadata(metadata: unknown): string[] {
  return parseInviteIds(metadata, ['courseIds', 'course_ids']);
}

function parseCohortIdsFromInviteMetadata(metadata: unknown): string[] {
  return parseInviteIds(metadata, ['cohortIds', 'cohort_ids', 'programIds', 'program_ids']);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getRoleLabel(roleId: number): string {
  if (roleId === ROLE.ADMIN) return 'Admin';
  if (roleId === ROLE.TUTOR) return 'Tutor';
  if (roleId === ROLE.STUDENT) return 'Student';
  return `Role ${roleId}`;
}

function getInviteStatus(invite: {
  isRevoked: boolean;
  expiresAt: string;
  acceptedAt: string | null;
}): OrganizationInviteStatus {
  if (invite.isRevoked) {
    return 'REVOKED';
  }

  if (invite.acceptedAt) {
    return 'ACCEPTED';
  }

  if (new Date(invite.expiresAt).getTime() <= Date.now()) {
    return 'EXPIRED';
  }

  return 'ACTIVE';
}

async function recordOrganizationInviteAudit(
  inviteId: string,
  organizationId: string,
  eventType: 'CREATED' | 'REVOKED' | 'PREVIEWED' | 'ACCEPTED' | 'EMAIL_SENT' | 'EMAIL_FAILED' | 'ABUSE_BLOCKED',
  context: {
    actorProfileId?: string | null;
    targetEmail?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    metadata?: Record<string, unknown>;
  } = {}
) {
  await createOrganizationInviteAudit({
    inviteId,
    organizationId,
    eventType,
    actorProfileId: context.actorProfileId ?? null,
    targetEmail: context.targetEmail ?? null,
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
    metadata: context.metadata ?? {}
  });
}

/**
 * Mirrors assertStudentCapacityOrThrow's blocking capacity check only — see
 * module doc KNOWN GAP (c) for the milestone-notification-email side effect
 * that is intentionally not ported here. Same precedent as
 * organization-handler's own local copy of this function.
 */
async function assertStudentCapacityOrThrowLocal(orgId: string, additionalStudents: number): Promise<void> {
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

async function syncOrgMemberForOrgInvite(
  tx: DbOrTxClient,
  params: { organizationId: string; roleId: number; normalizedEmail: string; userId: string }
): Promise<void> {
  const orgMemberByEmail = await selectOrganizationMemberByOrgAndNormalizedEmail(
    tx,
    params.organizationId,
    params.normalizedEmail
  );

  if (orgMemberByEmail) {
    if (orgMemberByEmail.profileId && orgMemberByEmail.profileId !== params.userId) {
      throw new AppError('This invite is linked to another account', ErrorCodes.UNAUTHORIZED, 403);
    }

    await updateOrganizationMemberById(tx, orgMemberByEmail.id, {
      profileId: params.userId,
      roleId: params.roleId,
      email: params.normalizedEmail,
      verified: true
    });

    return;
  }

  const orgMemberByProfile = await selectOrganizationMemberByOrgAndProfile(tx, params.organizationId, params.userId);

  if (orgMemberByProfile) {
    await updateOrganizationMemberById(tx, orgMemberByProfile.id, {
      roleId: params.roleId,
      email: params.normalizedEmail,
      verified: true
    });

    return;
  }

  if (params.roleId === ROLE.STUDENT) {
    await assertStudentCapacityOrThrowLocal(params.organizationId, 1);
  }

  await createOrganizationMember(
    {
      organizationId: params.organizationId,
      roleId: params.roleId,
      profileId: params.userId,
      email: params.normalizedEmail,
      verified: true
    },
    tx
  );
}

/**
 * Runs the course/cohort auto-enrollment fan-out for a just-accepted org
 * invite, driven by courseIds/cohortIds embedded in the invite's metadata
 * (set by audience import). Mirrors acceptOrganizationInvite /
 * acceptOrganizationInviteById's post-transaction enrollment block exactly,
 * including their fire-and-forget error handling (enrollment failures are
 * logged, never surfaced to the caller — the org membership itself already
 * succeeded).
 */
async function runInviteEnrollmentFanOut(params: {
  organizationId: string;
  roleId: number;
  userId: string;
  normalizedEmail: string;
  metadata: unknown;
}): Promise<void> {
  const courseIds = parseCourseIdsFromInviteMetadata(params.metadata);
  const cohortIds = parseCohortIdsFromInviteMetadata(params.metadata);

  if (courseIds.length > 0) {
    try {
      const courseGroupMappings = await getCourseGroupIds(courseIds);
      const validGroupIds = courseGroupMappings.map((m) => m.groupId).filter(Boolean) as string[];
      const enrolledCount = await enrollUsersInCourseGroups(
        validGroupIds,
        [{ profileId: params.userId, email: params.normalizedEmail }],
        params.roleId
      );

      if (enrolledCount > 0 && params.roleId === ROLE.STUDENT) {
        await invalidateOrgStats(params.organizationId);
      }
    } catch (error) {
      console.error('[invite-handler] course enrollment error:', error);
    }
  }

  if (cohortIds.length > 0) {
    try {
      const existingCohortMemberships = await getExistingCohortMembers(
        cohortIds.map((cohortId) => ({ cohortId, profileId: params.userId }))
      );
      const cohortIdsToInsert = cohortIds.filter(
        (cohortId) => !existingCohortMemberships.has(`${cohortId}:${params.userId}`)
      );

      await Promise.all(
        cohortIdsToInsert.map((cohortId) =>
          addCohortMember({
            cohortId,
            roleId: params.roleId,
            profileId: params.userId,
            email: params.normalizedEmail
          })
        )
      );

      const cohortCourseIds = await getCourseIdsByCohortIds(cohortIds);
      const courseIdsToEnroll = cohortCourseIds.filter((courseId) => !courseIds.includes(courseId));

      if (courseIdsToEnroll.length > 0) {
        const cohortCourseGroups = await getCourseGroupIds(courseIdsToEnroll);
        const cohortGroupIds = cohortCourseGroups.map((mapping) => mapping.groupId).filter(Boolean) as string[];
        const cohortEnrolledCount = await enrollUsersInCourseGroups(
          cohortGroupIds,
          [{ profileId: params.userId, email: params.normalizedEmail }],
          params.roleId
        );

        if (cohortEnrolledCount > 0 && params.roleId === ROLE.STUDENT) {
          await invalidateOrgStats(params.organizationId);
        }
      }
    } catch (error) {
      console.error('[invite-handler] cohort enrollment error:', error);
    }
  }
}

function getRedirectTo(roleId: number, siteName: string | null | undefined): string {
  return roleId === ROLE.STUDENT ? '/lms' : siteName ? `/org/${siteName}` : '/org';
}

// ─── GET /invite/organization/:token/preview ───────────────────────────────

async function handlePreviewOrganizationInvite(
  event: APIGatewayProxyEventV2,
  token: string | undefined
): Promise<APIGatewayProxyResultV2> {
  if (!isValidApiKey(event)) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  if (!isValidTokenParam(token)) {
    return jsonResponse(400, { success: false, message: 'token must be between 10 and 512 characters' });
  }

  try {
    const tokenHash = hashToken(token);
    const data = await getOrganizationInviteByTokenHash(tokenHash);

    if (!data) {
      return jsonResponse(404, { success: false, message: 'Invalid invite link' });
    }

    const context = getRequestContext(event);
    await recordOrganizationInviteAudit(data.invite.id, data.invite.organizationId, 'PREVIEWED', {
      targetEmail: data.invite.email,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    });

    return jsonResponse(200, {
      success: true,
      data: {
        invite: {
          id: data.invite.id,
          roleId: data.invite.roleId,
          roleLabel: getRoleLabel(data.invite.roleId),
          email: data.invite.email,
          expiresAt: data.invite.expiresAt,
          status: getInviteStatus(data.invite)
        },
        organization: data.organization
      }
    });
  } catch (error) {
    return errorResponse(error, 'Failed to load organization invite');
  }
}

// ─── POST /invite/organization/:token/accept ───────────────────────────────

async function handleAcceptOrganizationInvite(
  event: APIGatewayProxyEventV2,
  token: string | undefined
): Promise<APIGatewayProxyResultV2> {
  const sessionUser = await getSessionUser(event);
  if (!sessionUser) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  if (!isValidTokenParam(token)) {
    return jsonResponse(400, { success: false, message: 'token must be between 10 and 512 characters' });
  }

  try {
    const result = await acceptOrganizationInviteByTokenOrId(
      { kind: 'token', token },
      sessionUser,
      getRequestContext(event)
    );

    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    return errorResponse(error, 'Failed to accept organization invite');
  }
}

// ─── POST /invite/organization/:inviteId/accept-by-id ──────────────────────

async function handleAcceptOrganizationInviteById(
  event: APIGatewayProxyEventV2,
  inviteId: string | undefined
): Promise<APIGatewayProxyResultV2> {
  const sessionUser = await getSessionUser(event);
  if (!sessionUser) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  if (!inviteId || !UUID_REGEX.test(inviteId)) {
    return jsonResponse(400, { success: false, message: 'inviteId must be a valid UUID' });
  }

  try {
    const result = await acceptOrganizationInviteByTokenOrId(
      { kind: 'id', inviteId },
      sessionUser,
      getRequestContext(event)
    );

    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    return errorResponse(error, 'Failed to accept organization invite');
  }
}

/**
 * Shared implementation for both accept-by-token and accept-by-id — mirrors
 * acceptOrganizationInvite / acceptOrganizationInviteById in
 * apps/api/src/services/organization/invite.ts, which duplicate this exact
 * logic keyed by token vs. invite ID respectively.
 */
async function acceptOrganizationInviteByTokenOrId(
  lookup: { kind: 'token'; token: string } | { kind: 'id'; inviteId: string },
  user: TAuthUser,
  context: TInviteRequestContext
) {
  if (!user.id || !user.email) {
    throw new AppError('Authenticated user email is required', ErrorCodes.UNAUTHORIZED, 401);
  }

  const normalizedEmail = user.email.toLowerCase().trim();
  const tokenHash = lookup.kind === 'token' ? hashToken(lookup.token) : null;

  const result = await db.transaction(async (tx) => {
    const row: TOrganizationInviteAcceptRow | null =
      lookup.kind === 'token'
        ? await selectOrganizationInviteWithOrgByTokenHash(tx, tokenHash!)
        : await selectOrganizationInviteWithOrgByInviteId(tx, lookup.inviteId);

    if (!row) {
      throw new AppError(lookup.kind === 'token' ? 'Invalid invite link' : 'Invalid invite', ErrorCodes.NOT_FOUND, 404);
    }

    const status = getInviteStatus(row.invite);
    if (status === 'REVOKED') {
      throw new AppError('This invite has been revoked', ErrorCodes.UNAUTHORIZED, 403);
    }
    if (status === 'EXPIRED') {
      throw new AppError('This invite has expired', ErrorCodes.VALIDATION_ERROR, 400);
    }

    const inviteEmail = row.invite.email ?? '';
    if (inviteEmail.toLowerCase().trim() !== normalizedEmail) {
      throw new AppError('This invite is for a different email address', ErrorCodes.UNAUTHORIZED, 403);
    }

    if (status === 'ACCEPTED') {
      await markUserAndProfileEmailVerified(user.id, tx);

      return { organization: row.organization, invite: row.invite, roleId: row.invite.roleId, alreadyAccepted: true };
    }

    await syncOrgMemberForOrgInvite(tx, {
      organizationId: row.invite.organizationId,
      roleId: row.invite.roleId,
      normalizedEmail,
      userId: user.id
    });

    await markUserAndProfileEmailVerified(user.id, tx);

    const acceptedInvite = await claimPendingOrganizationInvite(tx, row.invite.id, user.id);
    if (!acceptedInvite) {
      throw new AppError('Invite is no longer available', ErrorCodes.VALIDATION_ERROR, 409);
    }

    return { organization: row.organization, invite: row.invite, roleId: row.invite.roleId, alreadyAccepted: false };
  });

  await recordOrganizationInviteAudit(result.invite.id, result.invite.organizationId, 'ACCEPTED', {
    actorProfileId: user.id,
    targetEmail: normalizedEmail,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { alreadyAccepted: result.alreadyAccepted }
  });

  // Auto-enroll in courses/cohorts if invite metadata references them (from
  // audience import). Runs regardless of alreadyAccepted — enrollment is
  // idempotent and the user may have accepted previously without getting
  // course access yet.
  await runInviteEnrollmentFanOut({
    organizationId: result.invite.organizationId,
    roleId: result.invite.roleId,
    userId: user.id,
    normalizedEmail,
    metadata: result.invite.metadata
  });

  const siteName = result.organization.siteName || '';

  return {
    organizationId: result.organization.id,
    roleId: result.roleId,
    alreadyAccepted: result.alreadyAccepted,
    redirectTo: getRedirectTo(result.roleId, siteName)
  };
}

// ─── GET /invite/link/:token/preview ────────────────────────────────────────

async function handlePreviewLinkInvite(
  event: APIGatewayProxyEventV2,
  token: string | undefined
): Promise<APIGatewayProxyResultV2> {
  if (!isValidApiKey(event)) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  if (!isValidTokenParam(token)) {
    return jsonResponse(400, { success: false, message: 'token must be between 10 and 512 characters' });
  }

  try {
    const tokenHash = hashToken(token);
    const data = await getOrgLinkInviteWithOrg(db, tokenHash);

    if (!data) {
      return jsonResponse(404, { success: false, message: 'Invalid invite link' });
    }

    const context = getRequestContext(event);
    await recordOrganizationInviteAudit(data.invite.id, data.invite.organizationId, 'PREVIEWED', {
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    });

    return jsonResponse(200, {
      success: true,
      data: {
        invite: {
          id: data.invite.id,
          roleId: data.invite.roleId,
          roleLabel: getRoleLabel(data.invite.roleId),
          isRevoked: data.invite.isRevoked
        },
        organization: data.organization
      }
    });
  } catch (error) {
    return errorResponse(error, 'Failed to load link invite');
  }
}

// ─── POST /invite/link/:token/accept ────────────────────────────────────────

async function handleAcceptLinkInvite(
  event: APIGatewayProxyEventV2,
  token: string | undefined
): Promise<APIGatewayProxyResultV2> {
  const sessionUser = await getSessionUser(event);
  if (!sessionUser) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  if (!isValidTokenParam(token)) {
    return jsonResponse(400, { success: false, message: 'token must be between 10 and 512 characters' });
  }

  if (!sessionUser.email) {
    return jsonResponse(401, { success: false, message: 'Authenticated user email is required' });
  }

  try {
    const normalizedEmail = sessionUser.email.toLowerCase().trim();
    const tokenHash = hashToken(token);

    const result = await db.transaction(async (tx) => {
      const row = await getOrgLinkInviteWithOrg(tx, tokenHash);

      if (!row) {
        throw new AppError('Invalid invite link', ErrorCodes.NOT_FOUND, 404);
      }

      if (row.invite.isRevoked) {
        throw new AppError('This invite link has been disabled', ErrorCodes.UNAUTHORIZED, 403);
      }

      await syncOrgMemberForOrgInvite(tx, {
        organizationId: row.invite.organizationId,
        roleId: row.invite.roleId,
        normalizedEmail,
        userId: sessionUser.id
      });

      await markUserAndProfileEmailVerified(sessionUser.id, tx);

      return { organization: row.organization, roleId: row.invite.roleId, inviteId: row.invite.id };
    });

    const context = getRequestContext(event);
    await recordOrganizationInviteAudit(result.inviteId, result.organization.id, 'ACCEPTED', {
      actorProfileId: sessionUser.id,
      targetEmail: normalizedEmail,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { source: 'LINK_INVITE' }
    });

    const siteName = result.organization.siteName || '';

    return jsonResponse(200, {
      success: true,
      data: {
        organizationId: result.organization.id,
        roleId: result.roleId,
        redirectTo: getRedirectTo(result.roleId, siteName)
      }
    });
  } catch (error) {
    return errorResponse(error, 'Failed to accept link invite');
  }
}

// ─── GET /invite/organization/pending ───────────────────────────────────────

/**
 * Lenient by design (matches the real Hono route): returns
 * `{success:true, data:null}` rather than a 400/401 when the `cio-org-id`
 * header or the session user's email is missing, instead of erroring.
 */
async function handlePendingOrganizationInvite(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const sessionUser = await getSessionUser(event);
  if (!sessionUser) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const orgId = event.headers?.['cio-org-id'] ?? event.headers?.['Cio-Org-Id'];

  if (!orgId || !sessionUser.email) {
    return jsonResponse(200, { success: true, data: null });
  }

  try {
    const data = await getActivePendingOrgInviteForEmail(orgId, sessionUser.email);

    if (!data) {
      return jsonResponse(200, { success: true, data: null });
    }

    return jsonResponse(200, {
      success: true,
      data: {
        id: data.invite.id,
        email: data.invite.email,
        roleId: data.invite.roleId,
        roleLabel: getRoleLabel(data.invite.roleId),
        expiresAt: data.invite.expiresAt,
        organization: data.organization
      }
    });
  } catch (error) {
    return errorResponse(error, 'Failed to load pending invite');
  }
}

/**
 * Lambda handler
 *
 * Route dispatch is done by rawPath suffix matching (same pattern as
 * organization-audience-handler), since API Gateway HTTP API strips the
 * base mapping and we only ever see `/invite/...` paths here.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  if (path.endsWith('/organization/pending') && method === 'GET') {
    return handlePendingOrganizationInvite(event);
  }

  const acceptByIdMatch = /\/organization\/([^/]+)\/accept-by-id$/.exec(path);
  if (acceptByIdMatch && method === 'POST') {
    return handleAcceptOrganizationInviteById(event, acceptByIdMatch[1]);
  }

  const orgPreviewMatch = /\/organization\/([^/]+)\/preview$/.exec(path);
  if (orgPreviewMatch && method === 'GET') {
    return handlePreviewOrganizationInvite(event, orgPreviewMatch[1]);
  }

  const orgAcceptMatch = /\/organization\/([^/]+)\/accept$/.exec(path);
  if (orgAcceptMatch && method === 'POST') {
    return handleAcceptOrganizationInvite(event, orgAcceptMatch[1]);
  }

  const linkPreviewMatch = /\/link\/([^/]+)\/preview$/.exec(path);
  if (linkPreviewMatch && method === 'GET') {
    return handlePreviewLinkInvite(event, linkPreviewMatch[1]);
  }

  const linkAcceptMatch = /\/link\/([^/]+)\/accept$/.exec(path);
  if (linkAcceptMatch && method === 'POST') {
    return handleAcceptLinkInvite(event, linkAcceptMatch[1]);
  }

  // GET /invite/student/:token — course-level invite preview. Intentionally
  // not implemented in this pass — see module doc KNOWN GAP (b). Returned as
  // a clean 404 rather than falling through to a crash.
  return jsonResponse(404, { success: false, message: 'Not Found' });
}
