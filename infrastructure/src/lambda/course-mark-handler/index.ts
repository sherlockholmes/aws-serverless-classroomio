import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getCourseMembers, getCourseWithRelations } from '@cio/db/queries/course';
import { getMarksByCourseId } from '@cio/db/queries/mark';
import type { Mark } from '@cio/db/queries/mark';
import { ContentType, ROLE } from '@cio/utils/constants';
import { requireCourseMember } from '../_shared/course-membership';

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function buildStudentMarksByExerciseId(marks: Mark[]): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};

  for (const mark of marks) {
    if (!mark.groupmemberId || !mark.exerciseId) continue;

    result[mark.groupmemberId] ??= {};
    result[mark.groupmemberId][mark.exerciseId] = mark.totalPointsGotten?.toString() ?? '0';
  }

  return result;
}

function buildExercises(marks: Mark[], contentItems: Array<{ id: string; type: string; title?: string | null }>) {
  const marksByExerciseId = new Map<string, { title: string; points: number }>();
  const exerciseOrder: string[] = [];

  for (const mark of marks) {
    if (!mark.exerciseId || marksByExerciseId.has(mark.exerciseId)) continue;

    exerciseOrder.push(mark.exerciseId);
    marksByExerciseId.set(mark.exerciseId, {
      title: mark.exerciseTitle ?? '',
      points: mark.exercisePoints ?? 0
    });
  }

  const exerciseItems = contentItems.filter((item) => item.type === ContentType.Exercise);
  if (exerciseItems.length > 0) {
    return exerciseItems.map((item) => ({
      id: item.id,
      title: item.title ?? marksByExerciseId.get(item.id)?.title ?? '',
      points: marksByExerciseId.get(item.id)?.points ?? 0
    }));
  }

  return exerciseOrder.map((id) => ({
    id,
    title: marksByExerciseId.get(id)?.title ?? '',
    points: marksByExerciseId.get(id)?.points ?? 0
  }));
}

async function getMarks(courseId: string) {
  return getMarksByCourseId(courseId);
}

async function getGradebook(courseId: string) {
  const [marks, members, course] = await Promise.all([
    getMarksByCourseId(courseId),
    getCourseMembers(courseId),
    getCourseWithRelations(courseId)
  ]);

  const students = members.filter((member) => Number(member.roleId) === ROLE.STUDENT);
  const contentItems = (course?.contentItems ?? []) as Array<{ id: string; type: string; title?: string | null }>;

  return {
    students,
    exercises: buildExercises(marks, contentItems),
    studentMarksByExerciseId: buildStudentMarksByExerciseId(marks)
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const courseId = event.pathParameters?.courseId;
  if (!courseId) return jsonResponse(400, { success: false, message: 'Missing courseId' });

  const member = await requireCourseMember(event, courseId);
  if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });

  try {
    const isGradebook = event.rawPath.endsWith('/gradebook');
    const data = isGradebook ? await getGradebook(courseId) : await getMarks(courseId);
    return jsonResponse(200, { success: true, data });
  } catch (error) {
    console.error('[course-mark-handler] error:', error);
    return jsonResponse(500, {
      success: false,
      message: isError(error) ? error.message : 'Failed to fetch course marks'
    });
  }
}

function isError(error: unknown): error is Error {
  return error instanceof Error;
}
