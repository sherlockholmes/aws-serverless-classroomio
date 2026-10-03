/**
 * Course invite Lambda. Token persistence, listing, revocation, and audit are
 * ported here. Email delivery is intentionally deferred to the AWS email queue.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import crypto from 'node:crypto';
import { ROLE } from '@cio/utils/constants';
import { getDashboardBaseUrl } from '@cio/core/config/dashboard-url';
import { getCourseById, getCourseWithOrgData } from '@cio/db/queries/course';
import { buildEmailBranding, buildEmailFromName } from '@cio/email';
import {
  createCourseInvite,
  createCourseInviteAudit,
  getCourseInviteById,
  listCourseInviteAudit,
  listCourseInviteAuditStats,
  listCourseInvites,
  revokeCourseInvite
} from '@cio/db/queries/course';
import { requireCourseTeamMember } from '../_shared/course-membership';
import { enqueueTemplateEmail } from '../_shared/email-enqueue';
import {
  ZCourseInviteAuditParam,
  ZCourseInviteParam,
  ZCourseInviteRevokeParam,
  ZCreateCourseInvite
} from '@cio/utils/validation/course';

function response(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
function token(): string {
  return crypto.randomBytes(32).toString('base64url');
}
function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function status(invite: { isRevoked: boolean; expiresAt: string; usedCount: number; maxUses: number }): string {
  if (invite.isRevoked) return 'REVOKED';
  if (new Date(invite.expiresAt).getTime() <= Date.now()) return 'EXPIRED';
  if (invite.usedCount >= invite.maxUses) return 'USED_UP';
  return 'ACTIVE';
}
function policy(data: { preset?: string; expiresAt?: string; maxUses?: number }): {
  expiresAt: string;
  maxUses: number;
} {
  const presets: Record<string, { ms: number; uses: number }> = {
    ONE_TIME_24H: { ms: 86400000, uses: 1 },
    MULTI_USE_7D: { ms: 604800000, uses: 50 },
    MULTI_USE_30D: { ms: 2592000000, uses: 1000 }
  };
  if (!data.expiresAt && data.maxUses === undefined && data.preset !== 'CUSTOM') {
    const presetData = presets[data.preset || 'MULTI_USE_30D'];
    return { expiresAt: new Date(Date.now() + presetData.ms).toISOString(), maxUses: presetData.uses };
  }
  const expiresAt = data.expiresAt ? new Date(data.expiresAt) : new Date(Date.now() + 2592000000);
  const maxUses = data.maxUses ?? 1;
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || maxUses < 1 || maxUses > 1000)
    throw new Error('Invalid invite policy');
  return { expiresAt: expiresAt.toISOString(), maxUses };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const courseId = event.pathParameters?.courseId;
  if (!courseId) return response(400, { success: false, message: 'Missing courseId' });
  const member = await requireCourseTeamMember(event, courseId);
  if (!member) return response(401, { success: false, message: 'Unauthorized' });
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath || '';
  const inviteId = event.pathParameters?.inviteId;
  try {
    if (method === 'GET' && path.endsWith('/invites')) {
      const [invites, stats] = await Promise.all([listCourseInvites(courseId), listCourseInviteAuditStats(courseId)]);
      const activity = new Map<string, Record<string, unknown>>();
      for (const row of stats) {
        const current = activity.get(row.inviteId) || {
          previewedCount: 0,
          acceptedCount: 0,
          emailSentCount: 0,
          emailFailedCount: 0,
          lastPreviewedAt: null,
          lastAcceptedAt: null,
          lastEmailSentAt: null
        };
        const key =
          row.eventType === 'PREVIEWED'
            ? 'previewedCount'
            : row.eventType === 'ACCEPTED'
              ? 'acceptedCount'
              : row.eventType === 'EMAIL_SENT'
                ? 'emailSentCount'
                : row.eventType === 'EMAIL_FAILED'
                  ? 'emailFailedCount'
                  : '';
        if (key) current[key] = row.count;
        activity.set(row.inviteId, current);
      }
      return response(200, {
        success: true,
        data: invites.map((invite) => ({
          ...invite,
          status: status(invite),
          usesRemaining: Math.max(invite.maxUses - invite.usedCount, 0),
          activity: activity.get(invite.id) || {
            previewedCount: 0,
            acceptedCount: 0,
            emailSentCount: 0,
            emailFailedCount: 0,
            lastPreviewedAt: null,
            lastAcceptedAt: null,
            lastEmailSentAt: null
          }
        }))
      });
    }
    if (method === 'POST' && path.endsWith('/invites')) {
      const validation = ZCreateCourseInvite.safeParse(parseBody(event));
      if (!validation.success)
        return response(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
      const [course] = await getCourseById(courseId);
      const org = await getCourseWithOrgData(courseId);
      if (!course || !org) return response(404, { success: false, message: 'Course not found' });
      const inviteToken = token();
      const values = validation.data;
      const invitePolicy = policy(values);
      const allowedEmails = values.allowedEmails?.map((email) => email.toLowerCase().trim()) ?? null;
      const allowedDomains =
        values.allowedDomains?.map((domain) => domain.toLowerCase().replace(/^@/, '').trim()) ?? null;
      const created = await createCourseInvite({
        courseId,
        roleId: ROLE.STUDENT,
        tokenHash: hash(inviteToken),
        createdByProfileId: member.userId,
        expiresAt: invitePolicy.expiresAt,
        maxUses: invitePolicy.maxUses,
        usedCount: 0,
        isRevoked: false,
        allowedEmails,
        allowedDomains,
        metadata: values.metadata || {}
      });
      await createCourseInviteAudit({
        inviteId: created.id,
        courseId,
        eventType: 'CREATED',
        actorProfileId: member.userId,
        targetEmail: values.recipientEmails?.[0] ?? null,
        ipAddress: null,
        userAgent: null,
        metadata: {}
      });
      const baseUrl = getDashboardBaseUrl({
        siteName: org.orgSiteName,
        customDomain: org.orgCustomDomain,
        isCustomDomainVerified: org.orgIsCustomDomainVerified
      });
      const inviteLink = `${baseUrl}/course/${encodeURIComponent(course.slug || course.title)}/enroll?invite_token=${encodeURIComponent(inviteToken)}`;
      const recipientEmail = values.recipientEmails?.[0];
      let sent = 0;
      const failures: Array<{ email: string; error: string }> = [];
      if (values.sendEmail && recipientEmail) {
        try {
          const branding = buildEmailBranding({ name: org.orgName, avatarUrl: org.orgAvatarUrl, theme: org.orgTheme });
          await enqueueTemplateEmail({
            kind: 'template',
            template: 'studentCourseInvite',
            to: recipientEmail,
            fields: {
              orgName: org.orgName || 'ClassroomIO',
              courseName: course.title,
              inviteLink,
              expiresAt: new Date(created.expiresAt).toLocaleString('en-US', { timeZone: 'UTC' }),
              branding
            },
            from: buildEmailFromName(`${org.orgName || 'ClassroomIO'} (via ClassroomIO.com)`)
          });
          await createCourseInviteAudit({
            inviteId: created.id,
            courseId,
            eventType: 'EMAIL_SENT',
            actorProfileId: member.userId,
            targetEmail: recipientEmail,
            ipAddress: null,
            userAgent: null,
            metadata: {}
          });
          sent = 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to enqueue invite email';
          failures.push({ email: recipientEmail, error: message });
          await createCourseInviteAudit({
            inviteId: created.id,
            courseId,
            eventType: 'EMAIL_FAILED',
            actorProfileId: member.userId,
            targetEmail: recipientEmail,
            ipAddress: null,
            userAgent: null,
            metadata: { error: message }
          });
        }
      }
      return response(201, {
        success: true,
        data: {
          mode: 'single',
          invites: [{ ...created, inviteLink, status: status(created) }],
          inviteLink,
          duplicatesSkipped: [],
          delivery: { requested: recipientEmail ? 1 : 0, sent, failed: failures.length, failures }
        }
      });
    }
    if (!inviteId) return response(404, { success: false, message: 'Not Found' });
    if (method === 'GET' && path.endsWith('/audit')) {
      const validation = ZCourseInviteAuditParam.safeParse({ courseId, inviteId });
      if (!validation.success) return response(400, { success: false, message: 'Invalid route parameters' });
      const invite = await getCourseInviteById(courseId, inviteId);
      if (!invite) return response(404, { success: false, message: 'Invite not found' });
      return response(200, { success: true, data: await listCourseInviteAudit(courseId, inviteId, 200) });
    }
    if (method === 'POST' && path.endsWith('/revoke')) {
      const validation = ZCourseInviteRevokeParam.safeParse({ courseId, inviteId });
      if (!validation.success) return response(400, { success: false, message: 'Invalid route parameters' });
      const invite = await getCourseInviteById(courseId, inviteId);
      if (!invite) return response(404, { success: false, message: 'Invite not found' });
      if (invite.isRevoked)
        return response(200, { success: true, data: { id: invite.id, status: status(invite), isRevoked: true } });
      const revoked = await revokeCourseInvite(courseId, inviteId, member.userId);
      if (!revoked) return response(404, { success: false, message: 'Invite not found' });
      await createCourseInviteAudit({
        inviteId,
        courseId,
        eventType: 'REVOKED',
        actorProfileId: member.userId,
        targetEmail: null,
        ipAddress: null,
        userAgent: null,
        metadata: {}
      });
      return response(200, {
        success: true,
        data: { id: revoked.id, status: status(revoked), isRevoked: revoked.isRevoked }
      });
    }
  } catch (error) {
    console.error('[course-invite-handler] error:', error);
    return response(500, {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to manage course invite'
    });
  }
  return response(404, { success: false, message: 'Not Found' });
}
