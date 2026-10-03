import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getCourseTeachers } from '@cio/db/queries/course';
import { getCourseWithOrgData } from '@cio/db/queries/course';
import { buildEmailBranding, buildEmailFromName } from '@cio/email';
import { getAppBaseUrl } from '@cio/core/config/dashboard-url';
import { enqueueTemplateEmail } from '../_shared/email-enqueue';

function parsePaymentRequest(value: unknown): { studentEmail: string; studentFullname: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (typeof data.studentEmail !== 'string' || !/^\S+@\S+\.\S+$/.test(data.studentEmail)) return null;
  if (typeof data.studentFullname !== 'string' || data.studentFullname.length < 1) return null;
  return { studentEmail: data.studentEmail, studentFullname: data.studentFullname };
}

function response(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function body(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const courseId = event.pathParameters?.courseId;
  if (!courseId) return response(400, { success: false, message: 'Missing courseId' });
  const parsed = parsePaymentRequest(body(event));
  if (!parsed) return response(400, { success: false, message: 'Invalid request body' });

  try {
    const course = await getCourseWithOrgData(courseId);
    if (!course) return response(404, { success: false, message: 'Course not found' });
    if (!course.groupId) return response(404, { success: false, message: 'Course group not found' });
    const teachers = await getCourseTeachers({ groupId: course.groupId, limit: 1 });
    const teacherEmail = teachers[0]?.email;
    if (!teacherEmail) return response(404, { success: false, message: 'No teacher found for this course' });

    const orgName = course.orgName || 'ClassroomIO';
    const branding = buildEmailBranding({
      name: course.orgName,
      avatarUrl: course.orgAvatarUrl,
      theme: course.orgTheme
    });
    const appBaseUrl = getAppBaseUrl();
    const courseUrl = `${appBaseUrl}/courses/${courseId}`;
    const autoEnrollUrl = `${appBaseUrl}/courses/${courseId}/people?grantAccess=${encodeURIComponent(parsed.studentEmail)}`;

    await Promise.all([
      enqueueTemplateEmail({
        kind: 'template',
        template: 'teacherStudentBuyRequest',
        to: teacherEmail,
        fields: {
          courseName: course.courseTitle || '',
          studentEmail: parsed.studentEmail,
          studentFullname: parsed.studentFullname,
          courseUrl,
          autoEnrollUrl,
          branding
        },
        from: buildEmailFromName('ClassroomIO')
      }).catch((error) => console.error('[course-payment-request-handler] teacher email error:', error)),
      enqueueTemplateEmail({
        kind: 'template',
        template: 'studentProvePayment',
        to: parsed.studentEmail,
        fields: {
          courseName: course.courseTitle || '',
          teacherEmail,
          studentFullname: parsed.studentFullname,
          orgName,
          branding
        },
        from: buildEmailFromName(`${orgName} - ClassroomIO`),
        replyTo: teacherEmail
      }).catch((error) => console.error('[course-payment-request-handler] student email error:', error))
    ]);

    return response(200, {
      success: true,
      data: { success: true, courseName: course.courseTitle || '', teacherEmail }
    });
  } catch (error) {
    console.error('[course-payment-request-handler] error:', error);
    return response(500, {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to create payment request'
    });
  }
}
