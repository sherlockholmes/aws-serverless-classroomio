/**
 * Organization Team Handler Lambda
 *
 * Handles:
 * - GET    /organization/team                (org team list — ADMIN/TUTOR)
 * - POST   /organization/team/invite          (invite team members — ADMIN only)
 * - DELETE /organization/team/:memberId        (remove a team member — ADMIN only)
 * - GET    /organization/link-invite          (fetch the org's link-invite — ADMIN only)
 * - POST   /organization/link-invite          (get-or-create the org's link-invite — ADMIN only)
 * - PATCH  /organization/link-invite          (revoke/unrevoke the org's link-invite — ADMIN only)
 *
 * Mirrors apps/api/src/routes/organization/organization.ts's `/team`,
 * `/team/invite`, `/team/:memberId` and `/link-invite` handlers. Required by
 * the dashboard's org settings "Team" page (invite/remove team members) and
 * the "Invite by link" flow.
 *
 * Auth mirrors Hono: `requireOrgTeamMember` for the team list read (ADMIN or
 * TUTOR), `requireOrgAdmin` for every mutation (team invite/remove, all three
 * link-invite methods) — see _shared/org-membership.ts.
 *
 * Validation is re-implemented manually here (not via zValidator/Zod) to
 * mirror packages/utils/src/validation/organization/organization.ts's
 * ZInviteTeamMembers / ZRemoveTeamMember / ZCreateLinkInvite /
 * ZToggleLinkInvite schemas. The 400 response shape below
 * (`{success:false, message}`) is a reasonable approximation of Hono's
 * zValidator rejection shape, not a byte-for-byte replica — acceptable
 * because this Lambda is bundled standalone from `infrastructure/` and can't
 * import `@hono/zod-validator`'s default error hook without pulling in the
 * Hono app itself.
 *
 * Business logic under `/link-invite` (token generation/hashing, far-future
 * expiry) mirrors apps/api/src/services/organization/invite.ts's
 * fetchOrgLinkInvite / getOrCreateLinkInvite / toggleOrgLinkInvite, reusing
 * the real query-layer functions from @cio/db/queries/organization (not a
 * copy of the service file itself, since apps/api uses the `@api/*` alias
 * that isn't resolvable from this bundle).
 *
 * `POST /team/invite` sends the `inviteTeacher` email via the shared
 * `_shared/email-enqueue.ts` helper (SQS -> email-worker -> SES), mirroring
 * apps/api/src/services/organization/invite.ts's real `inviteTeamMembers`
 * field-building (role label, expiry label, invite link via getAppBaseUrl,
 * org branding). Enqueue failures are logged and swallowed rather than
 * failing the request — the invite row is the source of truth; the email
 * is a best-effort notification (see Task 7.2 of
 * .kiro/specs/ses-email-delivery).
 *
 * Reuses the real query-layer functions from @cio/db (not hand-rolled SQL)
 * so response shapes stay in sync with the monolith — same pattern as
 * organization-handler / organization-courses-handler. Bundled from the
 * monorepo root (bundleFromMonorepoRoot: true in api-stack.ts) so esbuild
 * can resolve @cio/db + better-auth.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import * as crypto from 'node:crypto';
import {
  checkEmailsExistInOrg,
  createLinkInvite,
  createOrganizationInvite,
  createOrganizationMembers,
  deleteOrganizationMember,
  getOrganizationById,
  getOrganizationTeam,
  getOrgLinkInvite,
  revokeActiveOrganizationInvitesByEmails,
  setLinkInviteRevoked
} from '@cio/db/queries/organization';
import { getProfileById } from '@cio/db/queries/auth';
import { ROLE } from '@cio/utils/constants';
import { getAppBaseUrl } from '@cio/core/config/dashboard-url';
import { buildEmailBranding, buildEmailFromName, sanitizeEmailSubject } from '@cio/email';
import { requireOrgAdmin, requireOrgTeamMember, type OrgMembership } from '../_shared/org-membership';
import { enqueueTemplateEmail } from '../_shared/email-enqueue';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_INVITE_EMAILS = 50;
const LINK_INVITE_FAR_FUTURE_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const TEAM_INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

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

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Mirrors apps/api/src/services/organization/invite.ts's buildTeamInviteLink. */
function buildTeamInviteLink(token: string): string {
  return `${getAppBaseUrl()}/invite/${encodeURIComponent(token)}`;
}

/** Mirrors apps/api/src/services/organization/invite.ts's getRoleLabel. */
function getRoleLabel(roleId: number): string {
  if (roleId === ROLE.ADMIN) return 'Admin';
  if (roleId === ROLE.TUTOR) return 'Tutor';
  if (roleId === ROLE.STUDENT) return 'Student';
  return `Role ${roleId}`;
}

/** Mirrors apps/api/src/services/organization/invite.ts's getExpiryLabel. */
function getExpiryLabel(expiresAtIso: string): string {
  return new Date(expiresAtIso).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  });
}

/**
 * Mirrors ZInviteTeamMembers: { emails: string[] (1-50, each a valid email), roleId: positive int }.
 */
function validateInviteTeamMembers(
  body: unknown
): { success: true; data: { emails: string[]; roleId: number } } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { emails, roleId } = body as Record<string, unknown>;

  if (!Array.isArray(emails) || emails.length < 1 || emails.length > MAX_INVITE_EMAILS) {
    return { success: false, message: `emails must be an array of 1 to ${MAX_INVITE_EMAILS} valid email addresses` };
  }

  if (!emails.every((email) => typeof email === 'string' && EMAIL_REGEX.test(email))) {
    return { success: false, message: 'emails must all be valid email addresses' };
  }

  if (typeof roleId !== 'number' || !Number.isInteger(roleId) || roleId <= 0) {
    return { success: false, message: 'roleId must be a positive integer' };
  }

  return { success: true, data: { emails: emails as string[], roleId } };
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
 * Mirrors ZCreateLinkInvite: { roleId: positive int }.
 */
function validateCreateLinkInvite(
  body: unknown
): { success: true; roleId: number } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { roleId } = body as Record<string, unknown>;
  if (typeof roleId !== 'number' || !Number.isInteger(roleId) || roleId <= 0) {
    return { success: false, message: 'roleId must be a positive integer' };
  }

  return { success: true, roleId };
}

/**
 * Mirrors ZToggleLinkInvite: { isRevoked: boolean }.
 */
function validateToggleLinkInvite(
  body: unknown
): { success: true; isRevoked: boolean } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { isRevoked } = body as Record<string, unknown>;
  if (typeof isRevoked !== 'boolean') {
    return { success: false, message: 'isRevoked must be a boolean' };
  }

  return { success: true, isRevoked };
}

type LinkInviteResponse = { id: string; token: string; roleId: number; isRevoked: boolean };

function toLinkInviteResponse(row: {
  id: string;
  metadata: unknown;
  roleId: number;
  isRevoked: boolean;
}): LinkInviteResponse {
  const token = (row.metadata as Record<string, unknown> | null)?.token as string | undefined;
  return { id: row.id, token: token ?? '', roleId: row.roleId, isRevoked: row.isRevoked };
}

/**
 * GET /organization/team — ADMIN or TUTOR.
 */
async function handleGetTeam(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgTeamMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const team = await getOrganizationTeam(member.orgId);
    return jsonResponse(200, { success: true, data: team });
  } catch (error) {
    console.error('[organization-team-handler] getTeam error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch organization team' });
  }
}

/**
 * Creates org invite rows for team member emails that aren't already members.
 * DB-side effects (member placeholders + invite rows) mirror the real
 * inviteTeamMembers service; the transactional "you've been invited" email
 * send is intentionally NOT ported (see module doc KNOWN GAP) and is
 * best-effort/omitted rather than blocking the response.
 */
async function inviteTeamMembers(
  member: OrgMembership,
  emails: string[],
  roleId: number
): Promise<{ status: number; body: unknown }> {
  if (roleId !== ROLE.ADMIN && roleId !== ROLE.TUTOR) {
    return { status: 400, body: { success: false, message: 'Invalid organization role for invite' } };
  }

  const organization = await getOrganizationById(member.orgId);
  if (!organization || !organization.siteName) {
    return { status: 404, body: { success: false, message: 'Organization not found' } };
  }

  const normalizedEmails = [...new Set(emails.map((email) => email.toLowerCase().trim()).filter(Boolean))];
  const existingEmails = await checkEmailsExistInOrg(member.orgId, normalizedEmails);
  const emailsToInvite = normalizedEmails.filter((email) => !existingEmails.includes(email));

  if (emailsToInvite.length === 0) {
    return { status: 201, body: { success: true, data: [] } };
  }

  const members = await createOrganizationMembers(
    emailsToInvite.map((email) => ({ organizationId: member.orgId, email, roleId, verified: false }))
  );
  await revokeActiveOrganizationInvitesByEmails(member.orgId, emailsToInvite, member.userId);

  const expiresAt = new Date(Date.now() + TEAM_INVITE_EXPIRY_MS).toISOString();
  const roleName = getRoleLabel(roleId);
  const inviterProfile = await getProfileById(member.userId);
  const inviterName = inviterProfile?.fullname?.trim() || undefined;

  for (const email of emailsToInvite) {
    try {
      const token = generateToken();
      const tokenHash = hashToken(token);
      await createOrganizationInvite({
        organizationId: member.orgId,
        roleId,
        email,
        tokenHash,
        createdByProfileId: member.userId,
        expiresAt,
        isRevoked: false,
        metadata: { source: 'ORG_SETTINGS_TEAM_INVITE' }
      });

      const inviteLink = buildTeamInviteLink(token);

      try {
        await enqueueTemplateEmail({
          kind: 'template',
          template: 'inviteTeacher',
          to: email,
          fields: {
            email,
            orgName: organization.name,
            orgSiteName: organization.siteName,
            roleName,
            inviterName,
            expiresAt: getExpiryLabel(expiresAt),
            inviteLink,
            branding: buildEmailBranding(organization)
          },
          from: buildEmailFromName(`${organization.name} (via ClassroomIO.com)`),
          subject: sanitizeEmailSubject(`You have been invited to join ${organization.name} on ClassroomIO`)
        });
      } catch (emailError) {
        console.error(`[organization-team-handler] Failed to enqueue inviteTeacher email for ${email}:`, emailError);
      }
    } catch (error) {
      console.error(`[organization-team-handler] Failed to create org invite for ${email}:`, error);
    }
  }

  return { status: 201, body: { success: true, data: members } };
}

/**
 * POST /organization/team/invite — ADMIN only.
 */
async function handlePostTeamInvite(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgAdmin(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateInviteTeamMembers(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const { status, body: responseBody } = await inviteTeamMembers(
      member,
      validation.data.emails,
      validation.data.roleId
    );
    return jsonResponse(status, responseBody);
  } catch (error) {
    console.error('[organization-team-handler] inviteTeamMembers error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to invite team members' });
  }
}

/**
 * DELETE /organization/team/:memberId — ADMIN only.
 */
async function handleDeleteTeamMember(
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
    const deleted = await deleteOrganizationMember(member.orgId, parsedMemberId.memberId);
    if (!deleted) {
      return jsonResponse(404, { success: false, message: 'Team member not found' });
    }

    if (deleted.email) {
      await revokeActiveOrganizationInvitesByEmails(member.orgId, [deleted.email.toLowerCase()], member.userId);
    }

    return jsonResponse(200, { success: true });
  } catch (error) {
    console.error('[organization-team-handler] deleteTeamMember error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to remove team member' });
  }
}

/**
 * GET /organization/link-invite — ADMIN only.
 */
async function handleGetLinkInvite(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgAdmin(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const row = await getOrgLinkInvite(member.orgId);
    return jsonResponse(200, { success: true, data: row ? toLinkInviteResponse(row) : null });
  } catch (error) {
    console.error('[organization-team-handler] getLinkInvite error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch link invite' });
  }
}

/**
 * POST /organization/link-invite — get-or-create, ADMIN only.
 */
async function handlePostLinkInvite(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgAdmin(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateCreateLinkInvite(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const { roleId } = validation;
  if (roleId !== ROLE.ADMIN && roleId !== ROLE.TUTOR) {
    return jsonResponse(400, { success: false, message: 'Invalid organization role for link invite' });
  }

  try {
    const existing = await getOrgLinkInvite(member.orgId);
    if (existing) {
      return jsonResponse(200, { success: true, data: toLinkInviteResponse(existing) });
    }

    const token = generateToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + LINK_INVITE_FAR_FUTURE_MS).toISOString();

    const invite = await createLinkInvite({
      organizationId: member.orgId,
      roleId,
      tokenHash,
      createdByProfileId: member.userId,
      expiresAt,
      metadata: { token, source: 'ORG_SETTINGS_LINK_INVITE' }
    });

    return jsonResponse(200, {
      success: true,
      data: { id: invite.id, token, roleId: invite.roleId, isRevoked: invite.isRevoked }
    });
  } catch (error) {
    console.error('[organization-team-handler] getOrCreateLinkInvite error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to create link invite' });
  }
}

/**
 * PATCH /organization/link-invite — revoke/unrevoke, ADMIN only.
 */
async function handlePatchLinkInvite(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgAdmin(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateToggleLinkInvite(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const updated = await setLinkInviteRevoked(member.orgId, validation.isRevoked, member.userId);
    if (!updated) {
      return jsonResponse(404, { success: false, message: 'Link invite not found' });
    }

    return jsonResponse(200, { success: true, data: toLinkInviteResponse(updated) });
  } catch (error) {
    console.error('[organization-team-handler] toggleLinkInvite error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to update link invite' });
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  if (path.endsWith('/team/invite') && method === 'POST') {
    return handlePostTeamInvite(event);
  }

  if (path.endsWith('/team') && method === 'GET') {
    return handleGetTeam(event);
  }

  if (path.endsWith('/link-invite')) {
    if (method === 'GET') return handleGetLinkInvite(event);
    if (method === 'POST') return handlePostLinkInvite(event);
    if (method === 'PATCH') return handlePatchLinkInvite(event);
    return jsonResponse(405, { success: false, message: 'Method not allowed' });
  }

  const teamMemberMatch = /\/team\/([^/]+)$/.exec(path);
  if (teamMemberMatch && method === 'DELETE') {
    return handleDeleteTeamMember(event, teamMemberMatch[1]);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
