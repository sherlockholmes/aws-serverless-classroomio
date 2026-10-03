/**
 * Course people Lambda. Email delivery, org-stat invalidation, and analytics
 * side effects remain outside this first serverless port.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  getCourseMembers,
  getCourseMember,
  addCourseMember,
  updateCourseMember,
  deleteCourseMember,
  getCourseTeachers
} from '@cio/db/queries/course';
import { getCourseWithOrgData } from '@cio/db/queries/course';
import { getProfileById } from '@cio/db/queries/auth';
import { resetStudentCourseProgress } from '@cio/db/queries/course';
import { getDashboardBaseUrl } from '@cio/core/config/dashboard-url';
import { buildEmailBranding, buildEmailFromName } from '@cio/email';
import { getUserCourseAnalytics } from '@cio/core/services/course/course';
import { requireCourseTeamMember } from '../_shared/course-membership';
import { enqueueTemplateEmail } from '../_shared/email-enqueue';
import {
  ZAddCourseMembers,
  ZCourseMembersMemberParam,
  ZCourseMembersParam,
  ZResetCourseMemberProgressParam,
  ZUpdateCourseMember
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

async function sendMemberEmails(
  courseId: string,
  member: { profileId?: string; roleId: number; email?: string; name?: string }
): Promise<void> {
  const course = await getCourseWithOrgData(courseId);
  if (!course) return;

  const orgName = course.orgName || 'ClassroomIO';
  const branding = buildEmailBranding({ name: course.orgName, avatarUrl: course.orgAvatarUrl, theme: course.orgTheme });
  const studentProfile = member.profileId ? await getProfileById(member.profileId) : null;
  const email = studentProfile?.email || member.email;
  const name = studentProfile?.fullname || member.name || email || 'Student';

  if (member.roleId === 3 && email) {
    const loginUrl = getDashboardBaseUrl({
      siteName: course.orgSiteName,
      customDomain: course.orgCustomDomain,
      isCustomDomainVerified: course.orgIsCustomDomainVerified
    });
    await enqueueTemplateEmail({
      kind: 'template',
      template: 'studentCourseWelcome',
      to: email,
      fields: {
        orgName,
        courseName: course.courseTitle || '',
        loginUrl,
        customMessage: course.welcomeEmailMessage ?? undefined,
        branding
      },
      from: buildEmailFromName(`${orgName} (via ClassroomIO.com)`)
    });
    const teachers = await getCourseTeachers({ courseId });
    await Promise.all(
      teachers.map((teacher) =>
        teacher.email
          ? enqueueTemplateEmail({
              kind: 'template',
              template: 'teacherStudentJoined',
              to: teacher.email,
              fields: { courseName: course.courseTitle || '', studentName: name, studentEmail: email, branding },
              from: buildEmailFromName('ClassroomIO')
            })
          : undefined
      )
    );
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const courseId = event.pathParameters?.courseId;
  if (!courseId) return response(400, { success: false, message: 'Missing courseId' });
  const member = await requireCourseTeamMember(event, courseId);
  if (!member) return response(401, { success: false, message: 'Unauthorized' });
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath || '';
  const memberId = event.pathParameters?.memberId;

  try {
    if (method === 'GET' && path.endsWith('/members'))
      return response(200, { success: true, data: await getCourseMembers(courseId) });
    if (method === 'POST' && path.endsWith('/members')) {
      const validation = ZAddCourseMembers.safeParse(parseBody(event));
      if (!validation.success)
        return response(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
      const added = [];
      for (const item of validation.data) {
        const created = await addCourseMember(courseId, item);
        added.push(created);
        void sendMemberEmails(courseId, item).catch((error) =>
          console.error('[course-people-handler] email error:', error)
        );
      }
      return response(201, { success: true, data: added });
    }
    if (method === 'GET' && path.endsWith('/analytics')) {
      const userId = event.pathParameters?.userId;
      if (!userId) return response(400, { success: false, message: 'Missing userId' });
      const query = Object.fromEntries(
        new URL(event.rawQueryString ? `https://local/?${event.rawQueryString}` : 'https://local/').searchParams
      );
      const includeProgressImpact = query.includeProgressImpact === 'true';
      return response(200, {
        success: true,
        data: await getUserCourseAnalytics(courseId, userId, { includeProgressImpact })
      });
    }
    if (!memberId) return response(404, { success: false, message: 'Not Found' });
    if (method === 'POST' && path.endsWith('/reset-progress')) {
      const params = ZResetCourseMemberProgressParam.safeParse({ courseId, memberId });
      if (!params.success)
        return response(400, { success: false, message: 'Invalid route parameters', errors: params.error.issues });
      const target = await getCourseMember(courseId, memberId);
      if (!target?.profileId) return response(404, { success: false, message: 'Course member not found' });
      if (target.roleId !== 3) return response(400, { success: false, message: 'Only student progress can be reset' });
      return response(200, {
        success: true,
        data: await resetStudentCourseProgress({ courseId, groupMemberId: memberId, profileId: target.profileId })
      });
    }
    const params = ZCourseMembersMemberParam.safeParse({ courseId, memberId });
    if (!params.success)
      return response(400, { success: false, message: 'Invalid route parameters', errors: params.error.issues });
    if (method === 'PUT') {
      const validation = ZUpdateCourseMember.safeParse(parseBody(event));
      if (!validation.success)
        return response(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
      const data = await updateCourseMember(courseId, memberId, validation.data);
      return data
        ? response(200, { success: true, data })
        : response(404, { success: false, message: 'Course member not found' });
    }
    if (method === 'DELETE') {
      const data = await deleteCourseMember(courseId, memberId);
      return data
        ? response(200, { success: true, data })
        : response(404, { success: false, message: 'Course member not found' });
    }
  } catch (error) {
    console.error('[course-people-handler] error:', error);
    return response(500, {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to manage course members'
    });
  }
  return response(404, { success: false, message: 'Not Found' });
}
