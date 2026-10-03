/**
 * Organization Audience Handler Lambda
 *
 * Handles:
 * - GET    /organization/audience                       (list audience — ADMIN/TUTOR)
 * - DELETE /organization/audience/:memberId              (remove an audience member — ADMIN only)
 * - POST   /organization/audience/resend-invite          (resend a pending invite — ADMIN/TUTOR)
 * - POST   /organization/audience/revoke-invite          (revoke a pending invite — ADMIN/TUTOR)
 * - GET    /organization/audience/:userId/analytics      (per-student analytics — ADMIN/TUTOR)
 * - POST   /organization/audience/import                 (bulk-import audience by CSV — ADMIN/TUTOR)
 * - POST   /organization/audience/assign-courses         (assign audience to courses/cohorts — ADMIN/TUTOR)
 *
 * Mirrors apps/api/src/routes/organization/organization.ts's `/audience`
 * sub-routes. Required by the dashboard's org settings "Audience" page.
 *
 * Auth mirrors the real Hono routes exactly (NOT the task's summarized
 * description): `requireOrgTeamMember` (ADMIN or TUTOR) guards every route
 * here EXCEPT the DELETE, which requires `requireOrgAdmin` (ADMIN only) —
 * see _shared/org-membership.ts.
 *
 * Validation is re-implemented manually here (not via zValidator/Zod) to
 * mirror packages/utils/src/validation/organization/audience.ts's
 * ZGetAudienceQuery / ZImportAudienceMembers / ZAssignAudienceCourses /
 * ZAudienceInviteByEmail schemas, plus ZRemoveTeamMember / ZGetUserAnalytics
 * from packages/utils/src/validation/organization/organization.ts. The 400
 * response shape below (`{success:false, message}`) is a reasonable
 * approximation of Hono's zValidator rejection shape, not a byte-for-byte
 * replica — same tradeoff as organization-team-handler.
 *
 * `deriveAudienceMemberStatus` is copied verbatim (pure function, no
 * dependencies) from apps/api/src/utils/audience-member-status.ts, which
 * isn't importable here because apps/api uses the `@api/*` alias that this
 * standalone Lambda bundle can't resolve.
 *
 * KNOWN GAPS (intentional scope cuts for this first pass — the goal is to
 * eliminate the hard 404 from API Gateway, not to reach full functional
 * parity with the Hono service layer in one change):
 *
 * (a) `resend-invite`'s email send IS now ported (Task 7.4 of
 *     .kiro/specs/ses-email-delivery — see handleResendInvite's own doc
 *     comment). `import`'s "you've been invited" email IS now ported too
 *     (see gap (d) below) — each newly-created invite gets a real token,
 *     an invite link, and a studentOrgInvite email enqueued via SQS,
 *     unless the caller passes `sendEmail: false`.
 * (b) Invite audit trail rows (createOrganizationInviteAudits) are NOT
 *     written for resend/revoke/import actions.
 * (c) GET /audience/:userId/analytics is a SIMPLIFIED shape. It returns the
 *     student's profile + their enrolled courses (via getEnrolledCourses,
 *     which does include real per-course lessonCount/progressRate/exercise
 *     counts), but the aggregate `overallCourseProgress` /
 *     `overallAverageGrade` fields are naive averages computed from that
 *     same data rather than the richer analytics-service computation
 *     (getUserExercisesStats / getProfileCourseProgress) used by the real
 *     Hono route. Good enough to avoid a 404; not numerically identical.
 * (d) POST /audience/import NOW enrolls audience members into the
 *     courses/cohorts passed via `courseIds`/`cohortIds`/`allCourses`/
 *     `allCohorts`, mirroring apps/api/src/services/organization/
 *     audience.ts's `importAudienceMembers` (resolveCourseIdsAndNamesForImport
 *     / resolveCohortIdsAndNamesForImport / enrollAudienceStudentProfilesInCourses
 *     / enrollAudienceStudentProfilesInCohorts, ported below almost
 *     verbatim). Existing STUDENT members with a `profileId` are enrolled
 *     immediately (real groupmember/cohortMember rows + studentCourseWelcome/
 *     studentCohortWelcome emails). Genuinely new emails and pending
 *     (member-row-but-no-profileId-yet) emails instead get their invite's
 *     `metadata` populated with the resolved `courseIds`/`cohortIds`, so
 *     invite-handler's `runInviteEnrollmentFanOut` auto-enrolls them at
 *     accept-time (same mechanism as team invites). One piece of the real
 *     service is intentionally NOT ported: `ensureComplianceEnrollmentRecordsForProfiles`
 *     (compliance-cycle tracking rows for COMPLIANCE-type courses) — see
 *     narrower gap (f) below. Regular course/cohort group-membership
 *     enrollment (the actual access-granting mechanism) is fully ported.
 * (e) POST /audience/assign-courses NOW performs the real course/cohort
 *     enrollment for the given `profileIds`, via the same ported
 *     `enrollAudienceStudentProfilesInCourses`/
 *     `enrollAudienceStudentProfilesInCohorts` helpers used by (d). Returns
 *     real `{assigned, alreadyEnrolled, emailsSent}` counts instead of
 *     hardcoded zeros. Same compliance-records caveat as gap (f) below.
 * (f) NARROWER GAP: `ensureComplianceEnrollmentRecordsForProfiles`
 *     (apps/api/src/services/course/compliance.ts) — which creates
 *     courseCompletionRecord tracking rows for COMPLIANCE-type courses on
 *     enrollment — is NOT ported here. Its dependencies are all resolvable
 *     from `@cio/db`, but the underlying compliance-course feature (cycle
 *     tracking, due dates, waivers, reminders) is a large, separate
 *     subsystem out of proportion for this fix. Practical effect: a
 *     student enrolled into a COMPLIANCE-type course via audience
 *     import/assign-courses gets real course access (groupmember row) but
 *     no initial compliance-cycle record, so the compliance dashboard will
 *     show them as having no record until they're separately reset/synced
 *     via the compliance routes (which do create the record). This does
 *     not affect regular (non-COMPLIANCE) course/cohort enrollment.
 *
 * Reuses real query-layer functions from @cio/db (not hand-rolled SQL) for
 * everything that IS implemented, so response shapes stay in sync with the
 * monolith for the parts covered. Bundled from the monorepo root
 * (bundleFromMonorepoRoot: true in api-stack.ts) so esbuild can resolve
 * @cio/db + better-auth.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import * as crypto from 'node:crypto';
import {
  createOrganizationInvite,
  createOrganizationMembers,
  deleteOrganizationAudienceMember,
  getLatestOrgInvitesByEmails,
  getOrganizationAudience,
  getOrganizationById,
  getOrganizationMembersByNormalizedEmails,
  getOrgMembersByProfileIds,
  getStudentOrganizationMemberByOrgAndEmail,
  hasActiveOrganizationInviteForEmail,
  revokeActiveOrganizationInvitesByEmails,
  type TAudienceSortBy,
  type TAudienceSortOrder
} from '@cio/db/queries/organization';
import {
  getCourseById,
  getCourseGroupIds,
  getEnrolledCourses,
  getOrgCourseGroups,
  getOrgCourses,
  getUpcomingSessionsForCourseIds
} from '@cio/db/queries/course';
import {
  addCohortMember,
  getCohortsByOrg,
  getCourseIdsByCohortIds,
  getExistingCohortMembers
} from '@cio/db/queries/cohort';
import { addGroupMembers, enrollUsersInCourseGroups, getExistingGroupMembers } from '@cio/db/queries/group';
import { getProfileById, getProfilesByEmails } from '@cio/db/queries/auth';
import { ROLE } from '@cio/utils/constants';
import { getDashboardBaseUrl } from '@cio/core/config/dashboard-url';
import { buildEmailBranding, buildEmailFromName, buildSessionIcs } from '@cio/email';
import { invalidateOrgStats } from '@cio/core/utils/redis/org-stats-cache';
import { requireOrgAdmin, requireOrgTeamMember } from '../_shared/org-membership';
import { enqueueTemplateEmail } from '../_shared/email-enqueue';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUDIENCE_SORT_BY_VALUES: TAudienceSortBy[] = ['createdAt', 'name', 'email'];
const AUDIENCE_SORT_ORDER_VALUES: TAudienceSortOrder[] = ['asc', 'desc'];
const IMPORT_INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ASSIGN_PROFILE_IDS = 500;

/** Mirrors apps/api/src/services/organization/audience.ts's generateToken/hashToken. */
function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Mirrors apps/api/src/services/organization/audience.ts's buildInviteLink (student-facing, uses getDashboardBaseUrl not getAppBaseUrl). */
function buildStudentInviteLink(
  token: string,
  org?: { siteName?: string | null; customDomain?: string | null; isCustomDomainVerified?: boolean | null }
): string {
  return `${getDashboardBaseUrl(org)}/invite/${encodeURIComponent(token)}`;
}

/** Mirrors apps/api/src/services/organization/audience.ts's getExpiryLabel. */
function getInviteExpiryLabel(expiresAtIso: string): string {
  return new Date(expiresAtIso).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  });
}
const MAX_RECIPIENT_CSV_LENGTH = 25000;

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};

  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Copied verbatim from apps/api/src/utils/audience-member-status.ts — a pure
 * function with no external dependencies, so it's safe to duplicate here
 * rather than import (that file lives behind the `@api/*` alias, which this
 * standalone Lambda bundle can't resolve).
 */
type AudienceMemberStatus = 'active' | 'pending' | 'expired' | 'revoked';

function deriveAudienceMemberStatus(
  profileId: string | null,
  invite: { acceptedAt: string | null; isRevoked: boolean; expiresAt: string } | undefined
): AudienceMemberStatus {
  if (profileId) {
    return 'active';
  }
  if (invite?.acceptedAt) {
    return 'active';
  }
  if (!invite) {
    return 'pending';
  }
  if (invite.isRevoked) {
    return 'revoked';
  }
  if (new Date(invite.expiresAt) <= new Date()) {
    return 'expired';
  }
  return 'pending';
}

/**
 * Mirrors ZGetAudienceQuery: page/limit coerced with defaults, optional
 * search, sortBy/sortOrder enums defaulting to createdAt/desc.
 */
function parseAudienceQuery(query: Record<string, string | undefined>): {
  page: number;
  limit: number;
  search?: string;
  sortBy: TAudienceSortBy;
  sortOrder: TAudienceSortOrder;
} {
  const pageRaw = Number(query.page);
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

  const limitRaw = Number(query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 20;

  const search = query.search?.trim() || undefined;

  const sortByCandidate = query.sortBy as TAudienceSortBy | undefined;
  const sortBy = sortByCandidate && AUDIENCE_SORT_BY_VALUES.includes(sortByCandidate) ? sortByCandidate : 'createdAt';

  const sortOrderCandidate = query.sortOrder as TAudienceSortOrder | undefined;
  const sortOrder =
    sortOrderCandidate && AUDIENCE_SORT_ORDER_VALUES.includes(sortOrderCandidate) ? sortOrderCandidate : 'desc';

  return { page, limit, search, sortBy, sortOrder };
}

/**
 * Mirrors ZRemoveTeamMember: { memberId: z.coerce.number().int().positive() } (from the path param).
 */
function validateMemberIdParam(raw: string | undefined): { success: true; memberId: number } | { success: false } {
  const memberId = Number(raw);
  if (!raw || !Number.isInteger(memberId) || memberId <= 0) {
    return { success: false };
  }

  return { success: true, memberId };
}

/**
 * Mirrors ZGetUserAnalytics: { userId: z.uuid() } (from the path param).
 */
function validateUserIdParam(raw: string | undefined): { success: true; userId: string } | { success: false } {
  if (!raw || !UUID_REGEX.test(raw)) {
    return { success: false };
  }

  return { success: true, userId: raw };
}

/**
 * Mirrors ZAudienceInviteByEmail: { email: z.email() }.
 */
function validateAudienceInviteByEmail(
  body: unknown
): { success: true; email: string } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { email } = body as Record<string, unknown>;
  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) {
    return { success: false, message: 'email must be a valid email address' };
  }

  return { success: true, email };
}

/**
 * Mirrors ZImportAudienceMembers: { recipientCsv: string (<=25000), courseIds?: uuid[],
 * cohortIds?: uuid[], allCourses?: boolean (default false), allCohorts?: boolean (default false),
 * sendEmail?: boolean (default true) }.
 */
function validateImportAudienceMembers(body: unknown):
  | {
      success: true;
      data: {
        recipientCsv: string;
        courseIds: string[];
        cohortIds: string[];
        allCourses: boolean;
        allCohorts: boolean;
        sendEmail: boolean;
      };
    }
  | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { recipientCsv, courseIds, cohortIds, allCourses, allCohorts, sendEmail } = body as Record<string, unknown>;

  if (typeof recipientCsv !== 'string' || recipientCsv.length === 0 || recipientCsv.length > MAX_RECIPIENT_CSV_LENGTH) {
    return {
      success: false,
      message: `recipientCsv must be a non-empty string of at most ${MAX_RECIPIENT_CSV_LENGTH} characters`
    };
  }

  if (
    courseIds !== undefined &&
    (!Array.isArray(courseIds) || !courseIds.every((id) => typeof id === 'string' && UUID_REGEX.test(id)))
  ) {
    return { success: false, message: 'courseIds must be an array of valid UUIDs' };
  }

  if (
    cohortIds !== undefined &&
    (!Array.isArray(cohortIds) || !cohortIds.every((id) => typeof id === 'string' && UUID_REGEX.test(id)))
  ) {
    return { success: false, message: 'cohortIds must be an array of valid UUIDs' };
  }

  if (allCourses !== undefined && typeof allCourses !== 'boolean') {
    return { success: false, message: 'allCourses must be a boolean' };
  }

  if (allCohorts !== undefined && typeof allCohorts !== 'boolean') {
    return { success: false, message: 'allCohorts must be a boolean' };
  }

  return {
    success: true,
    data: {
      recipientCsv,
      courseIds: (courseIds as string[] | undefined) ?? [],
      cohortIds: (cohortIds as string[] | undefined) ?? [],
      allCourses: allCourses === true,
      allCohorts: allCohorts === true,
      sendEmail: sendEmail === false ? false : true
    }
  };
}

/**
 * Mirrors ZAssignAudienceCourses: { profileIds: uuid[] (1-500), courseIds?: uuid[],
 * cohortIds?: uuid[], sendEmail?: boolean (default true) }, refined so at least one of
 * courseIds/cohortIds is non-empty.
 */
function validateAssignAudienceCourses(body: unknown):
  | {
      success: true;
      data: { profileIds: string[]; courseIds: string[]; cohortIds: string[]; sendEmail: boolean };
    }
  | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { profileIds, courseIds, cohortIds, sendEmail } = body as Record<string, unknown>;

  if (
    !Array.isArray(profileIds) ||
    profileIds.length < 1 ||
    profileIds.length > MAX_ASSIGN_PROFILE_IDS ||
    !profileIds.every((id) => typeof id === 'string' && UUID_REGEX.test(id))
  ) {
    return {
      success: false,
      message: `profileIds must be an array of 1 to ${MAX_ASSIGN_PROFILE_IDS} valid UUIDs`
    };
  }

  if (
    courseIds !== undefined &&
    (!Array.isArray(courseIds) || !courseIds.every((id) => typeof id === 'string' && UUID_REGEX.test(id)))
  ) {
    return { success: false, message: 'courseIds must be an array of valid UUIDs' };
  }

  if (
    cohortIds !== undefined &&
    (!Array.isArray(cohortIds) || !cohortIds.every((id) => typeof id === 'string' && UUID_REGEX.test(id)))
  ) {
    return { success: false, message: 'cohortIds must be an array of valid UUIDs' };
  }

  const normalizedCourseIds = (courseIds as string[] | undefined) ?? [];
  const normalizedCohortIds = (cohortIds as string[] | undefined) ?? [];

  if (normalizedCourseIds.length === 0 && normalizedCohortIds.length === 0) {
    return { success: false, message: 'At least one course or cohort must be selected' };
  }

  return {
    success: true,
    data: {
      profileIds: profileIds as string[],
      courseIds: normalizedCourseIds,
      cohortIds: normalizedCohortIds,
      sendEmail: sendEmail === false ? false : true
    }
  };
}

/**
 * GET /organization/audience — ADMIN or TUTOR.
 */
async function handleGetAudience(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgTeamMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const query = parseAudienceQuery(event.queryStringParameters ?? {});

  try {
    const audienceResult = await getOrganizationAudience(member.orgId, query);
    const emailsWithoutProfile = audienceResult.items
      .filter((item) => !item.profileId && item.email)
      .map((item) => item.email.toLowerCase());

    const invites = await getLatestOrgInvitesByEmails(member.orgId, emailsWithoutProfile);
    const inviteByEmail = new Map(invites.map((invite) => [invite.email.toLowerCase(), invite]));

    const items = audienceResult.items.map((item) => ({
      ...item,
      status: deriveAudienceMemberStatus(
        item.profileId,
        item.email ? inviteByEmail.get(item.email.toLowerCase()) : undefined
      )
    }));

    return jsonResponse(200, {
      success: true,
      data: items,
      pagination: {
        page: audienceResult.page,
        limit: audienceResult.limit,
        total: audienceResult.total,
        totalPages: audienceResult.totalPages
      },
      query: {
        page: audienceResult.page,
        limit: audienceResult.limit,
        search: query.search,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder
      }
    });
  } catch (error) {
    console.error('[organization-audience-handler] getAudience error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch organization audience' });
  }
}

/**
 * DELETE /organization/audience/:memberId — ADMIN only.
 */
async function handleDeleteAudienceMember(
  event: APIGatewayProxyEventV2,
  memberIdRaw: string | undefined
): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgAdmin(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const parsedMemberId = validateMemberIdParam(memberIdRaw);
  if (!parsedMemberId.success) {
    return jsonResponse(400, { success: false, message: 'memberId must be a positive integer' });
  }

  try {
    const deleted = await deleteOrganizationAudienceMember(member.orgId, parsedMemberId.memberId);
    if (!deleted) {
      return jsonResponse(404, { success: false, message: 'Audience member not found' });
    }

    if (deleted.email) {
      await revokeActiveOrganizationInvitesByEmails(member.orgId, [deleted.email.toLowerCase()], member.userId);
    }

    return jsonResponse(200, { success: true, data: deleted });
  } catch (error) {
    console.error('[organization-audience-handler] removeAudienceMember error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to remove audience member' });
  }
}

/**
 * POST /organization/audience/resend-invite — ADMIN or TUTOR.
 *
 * Generates a real invite token (previously left as an empty tokenHash —
 * see Task 7.4 of .kiro/specs/ses-email-delivery) and sends the
 * studentOrgInvite email via the shared _shared/email-enqueue.ts SQS
 * helper, mirroring apps/api/src/services/organization/audience.ts's real
 * resendAudienceInvite (minus the course/cohort-access-name lookup from
 * the latest invite's metadata, and minus invite-audit-trail rows — both
 * separate, larger gaps unrelated to email transport; see Task 7.5).
 */
async function handleResendInvite(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgTeamMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateAudienceInviteByEmail(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const normalizedEmail = validation.email.toLowerCase().trim();

  try {
    const studentMember = await getStudentOrganizationMemberByOrgAndEmail(member.orgId, normalizedEmail);
    if (!studentMember) {
      return jsonResponse(404, { success: false, message: 'Audience member not found' });
    }

    if (studentMember.profileId) {
      return jsonResponse(400, { success: false, message: 'Member has already accepted an invite' });
    }

    const organization = await getOrganizationById(member.orgId);
    if (!organization) {
      return jsonResponse(404, { success: false, message: 'Organization not found' });
    }

    await revokeActiveOrganizationInvitesByEmails(member.orgId, [normalizedEmail], member.userId);

    const expiresAt = new Date(Date.now() + IMPORT_INVITE_EXPIRY_MS).toISOString();
    const token = generateInviteToken();
    const invite = await createOrganizationInvite({
      organizationId: member.orgId,
      roleId: ROLE.STUDENT,
      email: normalizedEmail,
      tokenHash: hashInviteToken(token),
      createdByProfileId: member.userId,
      expiresAt,
      isRevoked: false,
      metadata: { source: 'ORG_SETTINGS_AUDIENCE_RESEND_INVITE' }
    });

    let emailSent = false;
    try {
      const inviteLink = buildStudentInviteLink(token, organization);
      await enqueueTemplateEmail({
        kind: 'template',
        template: 'studentOrgInvite',
        to: normalizedEmail,
        fields: {
          email: normalizedEmail,
          orgName: organization.name,
          inviteLink,
          expiresAt: getInviteExpiryLabel(expiresAt),
          branding: buildEmailBranding(organization)
        },
        from: buildEmailFromName(`${organization.name} (via ClassroomIO.com)`)
      });
      emailSent = true;
    } catch (emailError) {
      console.error(
        `[organization-audience-handler] Failed to enqueue studentOrgInvite email for invite ${invite.id}:`,
        emailError
      );
    }

    return jsonResponse(200, { success: true, data: { emailSent } });
  } catch (error) {
    console.error('[organization-audience-handler] resendAudienceInvite error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to resend invite' });
  }
}

/**
 * POST /organization/audience/revoke-invite — ADMIN or TUTOR.
 */
async function handleRevokeInvite(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgTeamMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateAudienceInviteByEmail(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const normalizedEmail = validation.email.toLowerCase().trim();

  try {
    const hasActiveInvite = await hasActiveOrganizationInviteForEmail(member.orgId, normalizedEmail);
    if (!hasActiveInvite) {
      return jsonResponse(404, { success: false, message: 'No active invite found for this email' });
    }

    const revoked = await revokeActiveOrganizationInvitesByEmails(member.orgId, [normalizedEmail], member.userId);
    return jsonResponse(200, { success: true, data: { revoked: revoked.length } });
  } catch (error) {
    console.error('[organization-audience-handler] revokeAudiencePendingInvite error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to revoke invite' });
  }
}

/**
 * GET /organization/audience/:userId/analytics — ADMIN or TUTOR.
 *
 * KNOWN GAP: simplified aggregate metrics (see module doc). Course-level
 * lessonCount/progressRate/exerciseCount/exercisesCompleted come from the
 * real getEnrolledCourses query; overallCourseProgress/overallAverageGrade
 * below are naive averages derived from that same data, not the richer
 * analytics-service computation used by the real Hono route.
 */
async function handleGetUserAnalytics(
  event: APIGatewayProxyEventV2,
  userIdRaw: string | undefined
): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgTeamMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const parsedUserId = validateUserIdParam(userIdRaw);
  if (!parsedUserId.success) {
    return jsonResponse(400, { success: false, message: 'userId must be a valid UUID' });
  }

  try {
    const profile = await getProfileById(parsedUserId.userId);
    if (!profile) {
      return jsonResponse(404, { success: false, message: 'User not found' });
    }

    const courses = await getEnrolledCourses({ orgId: member.orgId, profileId: parsedUserId.userId });

    const coursesWithProgress = courses.filter((course) => course.lessonCount > 0);
    const overallCourseProgress =
      coursesWithProgress.length > 0
        ? coursesWithProgress.reduce((sum, course) => sum + course.progressRate / course.lessonCount, 0) /
          coursesWithProgress.length
        : 0;

    const coursesWithExercises = courses.filter((course) => course.exerciseCount > 0);
    const overallAverageGrade =
      coursesWithExercises.length > 0
        ? coursesWithExercises.reduce((sum, course) => sum + course.exercisesCompleted / course.exerciseCount, 0) /
          coursesWithExercises.length
        : 0;

    return jsonResponse(200, {
      success: true,
      data: {
        user: profile,
        courses,
        overallCourseProgress,
        overallAverageGrade
      }
    });
  } catch (error) {
    console.error('[organization-audience-handler] getUserAnalytics error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch user analytics' });
  }
}

/**
 * Parses a recipientCsv blob into normalized, deduplicated, lowercased email
 * addresses. Mirrors the delimiter set used by the real import service:
 * newlines, commas, semicolons, tabs, and spaces.
 */
function parseRecipientCsv(recipientCsv: string): string[] {
  const tokens = recipientCsv
    .split(/[\n,;\t ]+/g)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(tokens)];
}

type TOrganizationForEmail = NonNullable<Awaited<ReturnType<typeof getOrganizationById>>>;

/**
 * Ported from apps/api/src/services/course/session-invite.ts's
 * getWelcomeSessionIcs — builds the calendar invite (.ics) for a course's
 * next upcoming live session, for attaching to the welcome email on
 * enrollment. Returns undefined when the course isn't a LIVE_CLASS or has
 * no upcoming session. Its dependencies (getCourseById,
 * getUpcomingSessionsForCourseIds, buildSessionIcs) are all resolvable
 * from @cio/db/@cio/email, so this is copied verbatim rather than
 * simplified.
 */
async function getWelcomeSessionIcs(courseId: string): Promise<string | undefined> {
  try {
    const courseRows = await getCourseById(courseId);
    const course = courseRows?.[0];
    if (!course || course.type !== 'LIVE_CLASS') {
      return undefined;
    }

    const upcoming = (await getUpcomingSessionsForCourseIds([courseId])).get(courseId);
    if (!upcoming) {
      return undefined;
    }

    return buildSessionIcs({
      uid: `session-${upcoming.lessonId}@classroomio`,
      sequence: 0,
      method: 'PUBLISH',
      start: upcoming.lessonAt,
      title: upcoming.lessonTitle,
      description: `Join your live session: ${upcoming.callUrl}`,
      url: upcoming.callUrl,
      alarmsBeforeMinutes: [1440, 60]
    });
  } catch (error) {
    console.error('[organization-audience-handler] getWelcomeSessionIcs error:', error);
    return undefined;
  }
}

/**
 * Ported from apps/api/src/services/organization/audience.ts's
 * resolveCourseIdsAndNamesForImport.
 */
async function resolveCourseIdsAndNamesForImport(
  orgId: string,
  data: { courseIds: string[]; allCourses: boolean }
): Promise<{ courseIds: string[]; courseNames: string[] }> {
  if (data.allCourses) {
    const courses = await getOrgCourses({ orgId });
    return {
      courseIds: courses.items.map((c) => c.id),
      courseNames: courses.items.map((c) => c.title).filter(Boolean)
    };
  }

  if (data.courseIds.length > 0) {
    const courses = await getOrgCourses({ orgId, courseIds: data.courseIds });
    return {
      courseIds: courses.items.map((c) => c.id),
      courseNames: courses.items.map((c) => c.title).filter(Boolean)
    };
  }

  return { courseIds: [], courseNames: [] };
}

/**
 * Ported from apps/api/src/services/organization/audience.ts's
 * resolveCohortIdsAndNamesForImport.
 */
async function resolveCohortIdsAndNamesForImport(
  orgId: string,
  data: { cohortIds: string[]; allCohorts: boolean }
): Promise<{ cohortIds: string[]; cohortNames: string[] }> {
  if (data.allCohorts) {
    const cohorts = await getCohortsByOrg(orgId);
    return {
      cohortIds: cohorts.map((cohort) => cohort.id),
      cohortNames: cohorts.map((cohort) => cohort.name).filter(Boolean)
    };
  }

  if (data.cohortIds.length > 0) {
    const cohorts = await getCohortsByOrg(orgId, data.cohortIds);
    return {
      cohortIds: cohorts.map((cohort) => cohort.id),
      cohortNames: cohorts.map((cohort) => cohort.name).filter(Boolean)
    };
  }

  return { cohortIds: [], cohortNames: [] };
}

/**
 * Ported from apps/api/src/services/organization/audience.ts's
 * enrollAudienceStudentProfilesInCourses — the core group-membership
 * enrollment fan-out for EXISTING student profiles. See module doc gap (d)
 * for the one piece intentionally left out
 * (ensureComplianceEnrollmentRecordsForProfiles — narrower gap (f)).
 */
async function enrollAudienceStudentProfilesInCourses(
  orgId: string,
  organization: TOrganizationForEmail,
  profileIds: string[],
  courseIds: string[],
  shouldSendEmail: boolean
): Promise<{ assigned: number; alreadyEnrolled: number; emailsSent: number }> {
  if (courseIds.length === 0 || profileIds.length === 0) {
    return { assigned: 0, alreadyEnrolled: 0, emailsSent: 0 };
  }

  const uniqueProfileIds = [...new Set(profileIds)];
  const orgMembers = await getOrgMembersByProfileIds(orgId, uniqueProfileIds);
  const studentMembers = orgMembers.filter((m) => m.profileId && m.roleId === ROLE.STUDENT);
  const validProfileIds = new Set(studentMembers.map((m) => m.profileId!));
  const profileEmailMap = new Map(studentMembers.filter((m) => m.profileId).map((m) => [m.profileId!, m.email ?? '']));

  const courseGroups = await getOrgCourseGroups(orgId, courseIds);
  if (courseGroups.length === 0) {
    return { assigned: 0, alreadyEnrolled: 0, emailsSent: 0 };
  }

  const validGroupIds = courseGroups.map((cg) => cg.groupId).filter(Boolean) as string[];
  const courseTitleByGroupId = new Map(courseGroups.map((cg) => [cg.groupId, cg.courseTitle]));
  const welcomeMessageByGroupId = new Map(courseGroups.map((cg) => [cg.groupId, cg.welcomeEmailMessage]));
  const validProfiles = uniqueProfileIds.filter((id) => validProfileIds.has(id));

  const pairs = validProfiles.flatMap((profileId) => validGroupIds.map((groupId) => ({ groupId, profileId })));
  const existingSet = await getExistingGroupMembers(pairs);
  const toInsert = pairs.filter((p) => !existingSet.has(`${p.groupId}:${p.profileId}`));
  const alreadyEnrolled = pairs.length - toInsert.length;

  if (toInsert.length > 0) {
    await addGroupMembers(
      toInsert.map((p) => ({
        groupId: p.groupId,
        roleId: ROLE.STUDENT,
        profileId: p.profileId,
        email: profileEmailMap.get(p.profileId) || undefined
      }))
    );

    await invalidateOrgStats(orgId);
  }

  // NOTE: ensureComplianceEnrollmentRecordsForProfiles (compliance-cycle
  // tracking rows for COMPLIANCE-type courses) is intentionally not ported
  // here — see module doc narrower gap (f).

  let emailsSent = 0;
  const loginUrl = getDashboardBaseUrl(organization);

  if (shouldSendEmail && toInsert.length > 0) {
    const icsEntries = await Promise.all(
      courseGroups.map(async (cg) => [cg.groupId, await getWelcomeSessionIcs(cg.courseId)] as const)
    );
    const icsByGroupId = new Map(icsEntries);

    const emailOutcomes = await Promise.all(
      toInsert
        .filter((p) => profileEmailMap.get(p.profileId))
        .map(async (p) => {
          const email = profileEmailMap.get(p.profileId)!;
          try {
            await enqueueTemplateEmail({
              kind: 'template',
              template: 'studentCourseWelcome',
              to: email,
              fields: {
                orgName: organization.name,
                courseName: courseTitleByGroupId.get(p.groupId) || 'Course',
                loginUrl,
                customMessage: welcomeMessageByGroupId.get(p.groupId) ?? undefined,
                branding: buildEmailBranding(organization)
              },
              from: buildEmailFromName(`${organization.name} (via ClassroomIO.com)`),
              ics: icsByGroupId.get(p.groupId)
            });
            return true;
          } catch (emailError) {
            console.error(
              `[organization-audience-handler] enrollAudienceStudentProfilesInCourses enqueue error for ${email}:`,
              emailError
            );
            return false;
          }
        })
    );

    emailsSent = emailOutcomes.filter(Boolean).length;
  }

  return { assigned: toInsert.length, alreadyEnrolled, emailsSent };
}

/**
 * Ported from apps/api/src/services/organization/audience.ts's
 * enrollAudienceStudentProfilesInCohorts — enrolls existing student
 * profiles into cohorts, then cascades to each cohort's courses (same
 * group-membership fan-out pattern already used by invite-handler's
 * runInviteEnrollmentFanOut).
 */
async function enrollAudienceStudentProfilesInCohorts(
  organization: TOrganizationForEmail,
  orgId: string,
  profileIds: string[],
  cohortIds: string[],
  shouldSendEmail: boolean
): Promise<{ assigned: number; alreadyEnrolled: number; emailsSent: number }> {
  if (cohortIds.length === 0 || profileIds.length === 0) {
    return { assigned: 0, alreadyEnrolled: 0, emailsSent: 0 };
  }

  const uniqueProfileIds = [...new Set(profileIds)];
  const orgMembers = await getOrgMembersByProfileIds(orgId, uniqueProfileIds);
  const studentMembers = orgMembers.filter((member) => member.profileId && member.roleId === ROLE.STUDENT);
  const validProfileIds = new Set(studentMembers.map((member) => member.profileId!));
  const profileEmailMap = new Map(
    studentMembers.filter((member) => member.profileId).map((member) => [member.profileId!, member.email ?? ''])
  );

  const cohorts = await getCohortsByOrg(orgId, cohortIds);
  if (cohorts.length === 0) {
    return { assigned: 0, alreadyEnrolled: 0, emailsSent: 0 };
  }

  const cohortNameById = new Map(cohorts.map((cohort) => [cohort.id, cohort.name || 'Cohort']));
  const loginUrl = getDashboardBaseUrl(organization);
  const validCohortIds = cohorts.map((cohort) => cohort.id);
  const validProfiles = uniqueProfileIds.filter((profileId) => validProfileIds.has(profileId));
  const pairs = validProfiles.flatMap((profileId) => validCohortIds.map((cohortId) => ({ cohortId, profileId })));
  const existingSet = await getExistingCohortMembers(pairs);
  const toInsert = pairs.filter((pair) => !existingSet.has(`${pair.cohortId}:${pair.profileId}`));
  const alreadyEnrolled = pairs.length - toInsert.length;

  if (toInsert.length > 0) {
    await Promise.all(
      toInsert.map((pair) =>
        addCohortMember({
          cohortId: pair.cohortId,
          roleId: ROLE.STUDENT,
          profileId: pair.profileId,
          email: profileEmailMap.get(pair.profileId) || undefined
        })
      )
    );
  }

  // Enrols every assigned profile, not only new cohort memberships, so
  // re-running repairs members added before cohort course enrollment
  // existed — same rationale as the real service.
  const cohortCourseIds = await getCourseIdsByCohortIds(validCohortIds);

  if (cohortCourseIds.length > 0 && validProfiles.length > 0) {
    const courseGroups = await getCourseGroupIds(cohortCourseIds);
    const groupIds = courseGroups.map((mapping) => mapping.groupId).filter(Boolean) as string[];
    const users = validProfiles.map((profileId) => ({
      profileId,
      email: profileEmailMap.get(profileId) || undefined
    }));
    const enrolledCount = await enrollUsersInCourseGroups(groupIds, users, ROLE.STUDENT);

    if (enrolledCount > 0) {
      await invalidateOrgStats(orgId);
    }

    // NOTE: ensureComplianceEnrollmentRecordsForProfiles is intentionally
    // not ported here either — see module doc narrower gap (f).
  }

  let emailsSent = 0;

  if (shouldSendEmail && toInsert.length > 0) {
    const emailOutcomes = await Promise.all(
      toInsert
        .filter((pair) => profileEmailMap.get(pair.profileId))
        .map(async (pair) => {
          const email = profileEmailMap.get(pair.profileId)!;
          try {
            await enqueueTemplateEmail({
              kind: 'template',
              template: 'studentCohortWelcome',
              to: email,
              fields: {
                orgName: organization.name,
                cohortName: cohortNameById.get(pair.cohortId) || 'Cohort',
                loginUrl,
                branding: buildEmailBranding(organization)
              },
              from: buildEmailFromName(`${organization.name} (via ClassroomIO.com)`)
            });
            return true;
          } catch (emailError) {
            console.error(
              `[organization-audience-handler] enrollAudienceStudentProfilesInCohorts enqueue error for ${email}:`,
              emailError
            );
            return false;
          }
        })
    );

    emailsSent = emailOutcomes.filter(Boolean).length;
  }

  return { assigned: toInsert.length, alreadyEnrolled, emailsSent };
}

/**
 * POST /organization/audience/import — ADMIN or TUTOR.
 *
 * Sends the studentOrgInvite email for each newly-created invite (unless
 * the caller opts out via `sendEmail: false`), mirroring how
 * handleResendInvite sends its email — see module doc gap (a)/(d).
 *
 * Course/cohort enrollment IS now ported — see module doc gap (d).
 * Existing STUDENT members with a profileId are enrolled immediately;
 * genuinely-new and pending (no-profileId-yet) emails get their invite
 * metadata populated with courseIds/cohortIds so invite-handler's
 * accept-time fan-out enrolls them later.
 */
async function handleImportAudienceMembers(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgTeamMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateImportAudienceMembers(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const emails = parseRecipientCsv(validation.data.recipientCsv);
  const invalidEmails = emails.filter((email) => !EMAIL_REGEX.test(email));
  if (invalidEmails.length > 0) {
    return jsonResponse(400, { success: false, error: `Invalid emails found: ${invalidEmails.join(', ')}` });
  }

  if (emails.length === 0) {
    return jsonResponse(400, { success: false, message: 'recipientCsv must contain at least one email address' });
  }

  try {
    const organization = await getOrganizationById(member.orgId);
    if (!organization) {
      return jsonResponse(404, { success: false, message: 'Organization not found' });
    }

    const existingMembers = await getOrganizationMembersByNormalizedEmails(member.orgId, emails);
    const memberByEmail = new Map(existingMembers.map((existing) => [existing.normalizedEmail, existing]));

    // Three-way split, mirroring the real importAudienceMembers service:
    // genuinely new emails, existing STUDENT rows still pending (no
    // profileId yet — accepted no invite), and existing STUDENT rows with a
    // real profileId (already-active students, eligible for immediate
    // course/cohort enrollment). Non-STUDENT (team) emails are rejected,
    // same as the real service.
    const newEmails: string[] = [];
    const existingStudentProfileIds: string[] = [];
    const pendingStudentEmails: string[] = [];
    const teamEmails: string[] = [];

    for (const email of emails) {
      const existing = memberByEmail.get(email);
      if (!existing) {
        newEmails.push(email);
        continue;
      }
      if (existing.roleId !== ROLE.STUDENT) {
        teamEmails.push(email);
        continue;
      }
      if (!existing.profileId) {
        pendingStudentEmails.push(email);
        continue;
      }
      existingStudentProfileIds.push(existing.profileId);
    }

    if (teamEmails.length > 0) {
      return jsonResponse(400, {
        success: false,
        message: `These emails belong to organization staff, not students: ${teamEmails.slice(0, 8).join(', ')}${teamEmails.length > 8 ? '…' : ''}`
      });
    }

    const duplicates =
      emails.length - newEmails.length - pendingStudentEmails.length - existingStudentProfileIds.length;

    const { courseIds, courseNames } = await resolveCourseIdsAndNamesForImport(member.orgId, validation.data);
    const { cohortIds, cohortNames } = await resolveCohortIdsAndNamesForImport(member.orgId, validation.data);

    let emailsSent = 0;
    let emailsFailed = 0;

    // Existing active students (already have a profileId): enroll them
    // immediately, same as assign-courses.
    const assignedToCourses = await enrollAudienceStudentProfilesInCourses(
      member.orgId,
      organization,
      existingStudentProfileIds,
      courseIds,
      validation.data.sendEmail
    );
    const assignedToCohorts = await enrollAudienceStudentProfilesInCohorts(
      organization,
      member.orgId,
      existingStudentProfileIds,
      cohortIds,
      validation.data.sendEmail
    );
    emailsSent += assignedToCourses.emailsSent + assignedToCohorts.emailsSent;

    // Genuinely new emails: create pending STUDENT member rows, then create
    // invites carrying the resolved courseIds/cohortIds in metadata so
    // invite-handler's accept-time fan-out (runInviteEnrollmentFanOut)
    // grants course/cohort access once they accept — see module doc gap (d).
    if (newEmails.length > 0) {
      await createOrganizationMembers(
        newEmails.map((email) => ({ organizationId: member.orgId, email, roleId: ROLE.STUDENT, verified: false }))
      );

      // A "new" email here only means "no organizationmember row for THIS
      // org yet" — the person may already have a global profile (signed up
      // via another org). If so, enroll them immediately since they can
      // already log in; the invite below still gets created (and still
      // carries courseIds/cohortIds in metadata) so the flow is identical
      // either way. Mirrors the real importAudienceMembers service.
      if (courseIds.length > 0) {
        const courseGroupMappings = await getCourseGroupIds(courseIds);
        const validGroupIds = courseGroupMappings.map((m) => m.groupId).filter(Boolean) as string[];

        if (validGroupIds.length > 0) {
          const newEmailProfiles = await getProfilesByEmails(newEmails);
          if (newEmailProfiles.length > 0) {
            const users = newEmailProfiles.map((p) => ({ profileId: p.id, email: p.email ?? undefined }));
            const enrolledCount = await enrollUsersInCourseGroups(validGroupIds, users, ROLE.STUDENT);
            if (enrolledCount > 0) {
              await invalidateOrgStats(member.orgId);
            }
          }
        }
      }

      if (cohortIds.length > 0) {
        const newEmailProfiles = await getProfilesByEmails(newEmails);
        if (newEmailProfiles.length > 0) {
          await enrollAudienceStudentProfilesInCohorts(
            organization,
            member.orgId,
            newEmailProfiles.map((profile) => profile.id),
            cohortIds,
            false
          );
        }
      }
    }

    const emailsNeedingInvites = [...newEmails, ...pendingStudentEmails];
    let pendingInvitesRenewed = 0;

    if (emailsNeedingInvites.length > 0) {
      await revokeActiveOrganizationInvitesByEmails(member.orgId, emailsNeedingInvites, member.userId);

      const expiresAt = new Date(Date.now() + IMPORT_INVITE_EXPIRY_MS).toISOString();
      for (const email of emailsNeedingInvites) {
        try {
          // Each invite needs its own real, unique token hash — organization_invite
          // has a UNIQUE constraint on token_hash, so a shared/hardcoded value (the
          // previous bug: a hardcoded empty string) makes every invite after the
          // first one in this loop fail with a duplicate-key error. The plaintext
          // token is kept (not discarded) so it can be used to build the invite
          // link and email below.
          const token = generateInviteToken();
          const invite = await createOrganizationInvite({
            organizationId: member.orgId,
            roleId: ROLE.STUDENT,
            email,
            tokenHash: hashInviteToken(token),
            createdByProfileId: member.userId,
            expiresAt,
            isRevoked: false,
            metadata: {
              source: 'ORG_SETTINGS_AUDIENCE_IMPORT',
              courseIds: courseIds.length > 0 ? courseIds : undefined,
              cohortIds: cohortIds.length > 0 ? cohortIds : undefined
            }
          });

          if (pendingStudentEmails.includes(email)) {
            pendingInvitesRenewed += 1;
          }

          if (validation.data.sendEmail) {
            try {
              const inviteLink = buildStudentInviteLink(token, organization);
              const accessNames = [...courseNames, ...cohortNames];
              await enqueueTemplateEmail({
                kind: 'template',
                template: 'studentOrgInvite',
                to: email,
                fields: {
                  email,
                  orgName: organization.name,
                  inviteLink,
                  expiresAt: getInviteExpiryLabel(expiresAt),
                  courseNames: accessNames.length > 0 ? accessNames.join(', ') : undefined,
                  branding: buildEmailBranding(organization)
                },
                from: buildEmailFromName(`${organization.name} (via ClassroomIO.com)`)
              });
              emailsSent += 1;
            } catch (emailError) {
              emailsFailed += 1;
              console.error(
                `[organization-audience-handler] Failed to enqueue studentOrgInvite email for invite ${invite.id}:`,
                emailError
              );
            }
          }
        } catch (error) {
          console.error(`[organization-audience-handler] Failed to create org invite for ${email}:`, error);
        }
      }
    }

    return jsonResponse(201, {
      success: true,
      data: {
        imported: newEmails.length,
        assigned: assignedToCourses.assigned + assignedToCohorts.assigned,
        alreadyEnrolledInCourses: assignedToCourses.alreadyEnrolled,
        alreadyEnrolledInCohorts: assignedToCohorts.alreadyEnrolled,
        pendingInvitesRenewed,
        duplicates,
        emailsSent,
        emailsFailed
      }
    });
  } catch (error) {
    console.error('[organization-audience-handler] importAudienceMembers error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to import audience members' });
  }
}

/**
 * POST /organization/audience/assign-courses — ADMIN or TUTOR.
 *
 * Course/cohort enrollment IS now ported — see module doc gap (e). Calls
 * the same enrollAudienceStudentProfilesInCourses/-InCohorts helpers used
 * by handleImportAudienceMembers, against the caller-supplied profileIds
 * directly (these are audience members who already exist with real
 * profile ids — no invite-metadata deferral needed here).
 */
async function handleAssignAudienceCourses(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgTeamMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateAssignAudienceCourses(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const organization = await getOrganizationById(member.orgId);
    if (!organization) {
      return jsonResponse(404, { success: false, message: 'Organization not found' });
    }

    const { courseIds, cohortIds, profileIds, sendEmail } = validation.data;

    if (courseIds.length > 0) {
      const courseGroups = await getOrgCourseGroups(member.orgId, courseIds);
      if (courseGroups.length === 0) {
        return jsonResponse(400, { success: false, message: 'No valid courses found' });
      }
    }

    if (cohortIds.length > 0) {
      const cohorts = await getCohortsByOrg(member.orgId, cohortIds);
      if (cohorts.length === 0) {
        return jsonResponse(400, { success: false, message: 'No valid cohorts found' });
      }
    }

    const assignedToCourses =
      courseIds.length > 0
        ? await enrollAudienceStudentProfilesInCourses(member.orgId, organization, profileIds, courseIds, sendEmail)
        : { assigned: 0, alreadyEnrolled: 0, emailsSent: 0 };

    const assignedToCohorts =
      cohortIds.length > 0
        ? await enrollAudienceStudentProfilesInCohorts(organization, member.orgId, profileIds, cohortIds, sendEmail)
        : { assigned: 0, alreadyEnrolled: 0, emailsSent: 0 };

    return jsonResponse(200, {
      success: true,
      data: {
        assigned: assignedToCourses.assigned + assignedToCohorts.assigned,
        alreadyEnrolled: assignedToCourses.alreadyEnrolled + assignedToCohorts.alreadyEnrolled,
        emailsSent: assignedToCourses.emailsSent + assignedToCohorts.emailsSent
      }
    });
  } catch (error) {
    console.error('[organization-audience-handler] assignAudienceToCourses error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to assign audience to courses' });
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  if (path.endsWith('/audience/resend-invite') && method === 'POST') {
    return handleResendInvite(event);
  }

  if (path.endsWith('/audience/revoke-invite') && method === 'POST') {
    return handleRevokeInvite(event);
  }

  if (path.endsWith('/audience/import') && method === 'POST') {
    return handleImportAudienceMembers(event);
  }

  if (path.endsWith('/audience/assign-courses') && method === 'POST') {
    return handleAssignAudienceCourses(event);
  }

  if (path.endsWith('/audience') && method === 'GET') {
    return handleGetAudience(event);
  }

  const analyticsMatch = /\/audience\/([^/]+)\/analytics$/.exec(path);
  if (analyticsMatch && method === 'GET') {
    return handleGetUserAnalytics(event, analyticsMatch[1]);
  }

  const memberMatch = /\/audience\/([^/]+)$/.exec(path);
  if (memberMatch && method === 'DELETE') {
    return handleDeleteAudienceMember(event, memberMatch[1]);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
