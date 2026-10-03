/**
 * Course compliance Lambda.
 *
 * Mirrors apps/api/src/routes/course/compliance.ts. The API service lives
 * behind the @api alias, so the portable database-backed service logic is kept
 * here using the same @cio/db query functions and response shapes.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { ROLE } from '@cio/utils/constants';
import {
  ZCourseComplianceExtend,
  ZCourseComplianceLearnerParam,
  ZCourseComplianceParam,
  ZCourseComplianceReset,
  ZCourseComplianceWaive,
  type TCourseComplianceExtend,
  type TCourseComplianceReset,
  type TCourseComplianceWaive
} from '@cio/utils/validation/course';
import { db } from '@cio/db/drizzle';
import { getCourseById } from '@cio/db/queries/course';
import {
  createCourseCompletionRecord,
  getCourseComplianceHistoryRows,
  getCourseCurrentComplianceRows,
  getLatestComplianceRecordsByProfiles,
  getStudentCourseMembersForCompliance,
  updateCourseCompletionRecord
} from '@cio/db/queries/course';
import { getUserCourseRole } from '@cio/db/queries/group';
import { requireCourseMember, requireCourseTeamMember } from '../_shared/course-membership';

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

function errorResponse(error: unknown, fallbackMessage: string): APIGatewayProxyResultV2 {
  if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number') {
    return jsonResponse(error.statusCode, { success: false, message: error.message });
  }

  return jsonResponse(500, { success: false, message: fallbackMessage });
}

function ensureFutureOrPresentIsoDate(dateIso: string): void {
  if (Number.isNaN(new Date(dateIso).getTime())) {
    throw new Error('Invalid date provided');
  }
}

type ComplianceStatus =
  | 'not_started'
  | 'in_progress'
  | 'compliant'
  | 'expiring_soon'
  | 'in_grace_period'
  | 'non_compliant'
  | 'waived';

async function getComplianceCourseOrThrow(courseId: string) {
  const [course] = await getCourseById(courseId);
  if (!course) throw new Error('Course not found');
  if (course.type !== 'COMPLIANCE' || !course.compliance) {
    throw new Error('Course is not a compliance course');
  }
  return course;
}

function getStatusCounts(records: Array<{ record: { status: string } | null }>) {
  const counts: Record<ComplianceStatus | 'no_record', number> = {
    no_record: 0,
    not_started: 0,
    in_progress: 0,
    compliant: 0,
    expiring_soon: 0,
    in_grace_period: 0,
    non_compliant: 0,
    waived: 0
  };

  for (const row of records) {
    if (!row.record) {
      counts.no_record += 1;
      continue;
    }

    const status = row.record.status as ComplianceStatus;
    counts[status] = (counts[status] ?? 0) + 1;
  }

  return counts;
}

async function assertHistoryAccess(courseId: string, currentProfileId: string, targetProfileId: string) {
  if (currentProfileId === targetProfileId) return;

  const roleId = await getUserCourseRole(courseId, currentProfileId);
  if (roleId !== ROLE.ADMIN && roleId !== ROLE.TUTOR) {
    throw new Error('You do not have permission to view this learner');
  }
}

async function getTargetStudents(courseId: string, profileIds?: string[]) {
  const students = await getStudentCourseMembersForCompliance(courseId, profileIds);
  if (profileIds && students.length !== profileIds.length) {
    throw new Error('One or more learners were not found in this course');
  }
  return students;
}

function getIncompleteRecord(
  record: Awaited<ReturnType<typeof getLatestComplianceRecordsByProfiles>>[number] | undefined
) {
  if (!record || record.completedAt) return null;
  return record;
}

async function getOverview(courseId: string) {
  const course = await getComplianceCourseOrThrow(courseId);
  const rows = await getCourseCurrentComplianceRows(courseId);
  const counts = getStatusCounts(rows);

  return {
    courseId: course.id,
    compliance: course.compliance,
    summary: {
      totalLearners: rows.length,
      noRecord: counts.no_record,
      notStarted: counts.not_started,
      inProgress: counts.in_progress,
      compliant: counts.compliant,
      expiringSoon: counts.expiring_soon,
      inGracePeriod: counts.in_grace_period,
      nonCompliant: counts.non_compliant,
      waived: counts.waived
    },
    learners: rows.map((row) => ({
      groupMemberId: row.member.id,
      profileId: row.member.profileId,
      fullname: row.profile?.fullname ?? null,
      username: row.profile?.username ?? null,
      email: row.profile?.email ?? row.member.email ?? null,
      status: row.record?.status ?? 'not_started',
      cycleNumber: row.record?.cycleNumber ?? null,
      dueDate: row.record?.dueDate ?? null,
      completedAt: row.record?.completedAt ?? null,
      validUntil: row.record?.validUntil ?? null,
      score: row.record?.score ?? null,
      attempts: row.record?.attempts ?? 0,
      waiverExpiresAt: row.record?.waiverExpiresAt ?? null
    }))
  };
}

async function getHistory(courseId: string, currentProfileId: string, targetProfileId: string) {
  await getComplianceCourseOrThrow(courseId);
  await assertHistoryAccess(courseId, currentProfileId, targetProfileId);

  const history = await getCourseComplianceHistoryRows(courseId, targetProfileId);
  if (!history.member) throw new Error('Learner not found in this course');

  return {
    learner: {
      groupMemberId: history.member.id,
      profileId: history.member.profileId,
      fullname: history.profile?.fullname ?? null,
      username: history.profile?.username ?? null,
      avatarUrl: history.profile?.avatarUrl ?? null,
      email: history.profile?.email ?? history.member.email ?? null
    },
    currentRecord: history.records[0] ?? null,
    history: history.records
  };
}

async function resetCompliance(courseId: string, payload: TCourseComplianceReset) {
  await getComplianceCourseOrThrow(courseId);
  ensureFutureOrPresentIsoDate(payload.dueDate);

  const students = await getTargetStudents(courseId, payload.profileIds);
  const profileIds = students.flatMap((student) => (student.member.profileId ? [student.member.profileId] : []));
  const records = await getLatestComplianceRecordsByProfiles(courseId, profileIds);
  const recordsByProfileId = new Map(records.map((record) => [record.profileId, record]));
  let createdCount = 0;
  let updatedCount = 0;

  await db.transaction(async (tx) => {
    for (const student of students) {
      const profileId = student.member.profileId;
      if (!profileId) continue;

      const existingRecord = recordsByProfileId.get(profileId);
      if (!existingRecord) {
        await createCourseCompletionRecord(
          {
            courseId,
            groupMemberId: student.member.id,
            profileId,
            cycleNumber: 1,
            status: 'not_started',
            dueDate: payload.dueDate,
            attempts: 0,
            timeSpentMinutes: 0
          },
          tx
        );
        createdCount += 1;
        continue;
      }

      await updateCourseCompletionRecord(
        existingRecord.id,
        {
          status: 'not_started',
          dueDate: payload.dueDate,
          startedAt: null,
          completedAt: null,
          validUntil: null,
          expiredAt: null,
          score: null,
          attempts: 0,
          timeSpentMinutes: 0,
          waivedBy: null,
          waiverReason: null,
          waiverExpiresAt: null
        },
        tx
      );
      updatedCount += 1;
    }
  });

  return { createdCount, updatedCount, learnerCount: students.length, dueDate: payload.dueDate };
}

async function extendCompliance(courseId: string, payload: TCourseComplianceExtend) {
  await getComplianceCourseOrThrow(courseId);
  ensureFutureOrPresentIsoDate(payload.dueDate);

  const students = await getTargetStudents(courseId, payload.profileIds);
  const profileIds = students.flatMap((student) => (student.member.profileId ? [student.member.profileId] : []));
  const records = await getLatestComplianceRecordsByProfiles(courseId, profileIds);
  const recordsByProfileId = new Map(records.map((record) => [record.profileId, record]));
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  await db.transaction(async (tx) => {
    for (const student of students) {
      const profileId = student.member.profileId;
      if (!profileId) continue;

      const latestRecord = recordsByProfileId.get(profileId);
      const existingRecord = getIncompleteRecord(latestRecord);
      if (!existingRecord) {
        if (latestRecord?.completedAt) {
          skippedCount += 1;
          continue;
        }

        await createCourseCompletionRecord(
          {
            courseId,
            groupMemberId: student.member.id,
            profileId,
            cycleNumber: latestRecord ? latestRecord.cycleNumber + 1 : 1,
            status: 'not_started',
            dueDate: payload.dueDate,
            attempts: 0,
            timeSpentMinutes: 0
          },
          tx
        );
        createdCount += 1;
        continue;
      }

      await updateCourseCompletionRecord(existingRecord.id, { dueDate: payload.dueDate }, tx);
      updatedCount += 1;
    }
  });

  return { createdCount, updatedCount, skippedCount, learnerCount: students.length, dueDate: payload.dueDate };
}

async function waiveCompliance(courseId: string, actorProfileId: string, payload: TCourseComplianceWaive) {
  await getComplianceCourseOrThrow(courseId);
  if (payload.waiverExpiresAt) ensureFutureOrPresentIsoDate(payload.waiverExpiresAt);

  const students = await getTargetStudents(courseId, payload.profileIds);
  const profileIds = students.flatMap((student) => (student.member.profileId ? [student.member.profileId] : []));
  const records = await getLatestComplianceRecordsByProfiles(courseId, profileIds);
  const recordsByProfileId = new Map(records.map((record) => [record.profileId, record]));
  let updatedCount = 0;
  let skippedCount = 0;

  await db.transaction(async (tx) => {
    for (const student of students) {
      const profileId = student.member.profileId;
      if (!profileId) continue;

      const existingRecord = getIncompleteRecord(recordsByProfileId.get(profileId));
      if (!existingRecord) {
        skippedCount += 1;
        continue;
      }

      await updateCourseCompletionRecord(
        existingRecord.id,
        {
          status: 'waived',
          waivedBy: actorProfileId,
          waiverReason: payload.waiverReason ?? null,
          waiverExpiresAt: payload.waiverExpiresAt ?? null
        },
        tx
      );
      updatedCount += 1;
    }
  });

  return {
    updatedCount,
    skippedCount,
    learnerCount: students.length,
    waiverExpiresAt: payload.waiverExpiresAt ?? null
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const courseId = event.pathParameters?.courseId;
  if (!courseId) return jsonResponse(400, { success: false, message: 'Missing courseId' });

  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  const overviewMatch = new RegExp(`/course/${courseId}/compliance$`).test(path);
  if (overviewMatch && method === 'GET') {
    const member = await requireCourseTeamMember(event, courseId);
    if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });

    try {
      return jsonResponse(200, { success: true, data: await getOverview(courseId) });
    } catch (error) {
      console.error('[course-compliance-handler] overview error:', error);
      return errorResponse(error, 'Failed to fetch course compliance overview');
    }
  }

  const historyMatch = new RegExp(`/course/${courseId}/compliance/learners/([^/]+)$`).exec(path);
  if (historyMatch && method === 'GET') {
    const member = await requireCourseMember(event, courseId);
    if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });

    const paramValidation = ZCourseComplianceLearnerParam.safeParse({ courseId, profileId: historyMatch[1] });
    if (!paramValidation.success) {
      return jsonResponse(400, {
        success: false,
        message: 'Invalid route parameters',
        errors: paramValidation.error.issues
      });
    }

    try {
      return jsonResponse(200, { success: true, data: await getHistory(courseId, member.userId, historyMatch[1]) });
    } catch (error) {
      console.error('[course-compliance-handler] history error:', error);
      return errorResponse(error, 'Failed to fetch learner compliance history');
    }
  }

  const action = path.match(new RegExp(`/course/${courseId}/compliance/(reset|extend|waive)$`))?.[1];
  if (action && method === 'POST') {
    const member = await requireCourseTeamMember(event, courseId);
    if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });

    const paramValidation = ZCourseComplianceParam.safeParse({ courseId });
    if (!paramValidation.success) {
      return jsonResponse(400, {
        success: false,
        message: 'Invalid route parameters',
        errors: paramValidation.error.issues
      });
    }

    const body = parseJsonBody(event);
    if (body === undefined) return jsonResponse(400, { success: false, message: 'Invalid JSON body' });

    const schemas = {
      reset: ZCourseComplianceReset,
      extend: ZCourseComplianceExtend,
      waive: ZCourseComplianceWaive
    } as const;
    const validation = schemas[action].safeParse(body);
    if (!validation.success) {
      return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
    }

    try {
      const data =
        action === 'reset'
          ? await resetCompliance(courseId, validation.data as TCourseComplianceReset)
          : action === 'extend'
            ? await extendCompliance(courseId, validation.data as TCourseComplianceExtend)
            : await waiveCompliance(courseId, member.userId, validation.data as TCourseComplianceWaive);
      return jsonResponse(200, { success: true, data });
    } catch (error) {
      console.error(`[course-compliance-handler] ${action} error:`, error);
      return errorResponse(error, `Failed to ${action} course compliance`);
    }
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
