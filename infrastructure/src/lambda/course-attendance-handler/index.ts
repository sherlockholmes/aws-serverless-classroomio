import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { upsertAttendance } from '@cio/db/queries/attendance';
import { ZAttendanceUpsert } from '@cio/utils/validation/attendance';
import { requireCourseMember } from '../_shared/course-membership';

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

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const courseId = event.pathParameters?.courseId;
  if (!courseId) return jsonResponse(400, { success: false, message: 'Missing courseId' });

  const member = await requireCourseMember(event, courseId);
  if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });

  const validation = ZAttendanceUpsert.safeParse(parseJsonBody(event));
  if (!validation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid request body',
      errors: validation.error.issues
    });
  }

  try {
    const attendance = await upsertAttendance(validation.data);
    return jsonResponse(201, { success: true, data: attendance });
  } catch (error) {
    console.error('[course-attendance-handler] upsertAttendance error:', error);
    return jsonResponse(500, {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to upsert attendance'
    });
  }
}
