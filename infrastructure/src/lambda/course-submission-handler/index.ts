/**
 * Course Submission Handler Lambda
 *
 * Mirrors apps/api/src/routes/course/submission.ts's `submissionRouter`
 * (mounted at `/course/:courseId/submission`). All five routes are
 * `courseTeamMemberMiddleware`-gated in the real Hono router (course
 * ADMIN/TUTOR or org admin only — grading/submission management, not
 * student-facing), so this handler uses `requireCourseTeamMember`
 * uniformly for all of them.
 *
 * Handles:
 * - GET    /course/{courseId}/submission/for-grading           (grading board data)
 * - PUT    /course/{courseId}/submission/{submissionId}        (update status/workflow)
 * - DELETE /course/{courseId}/submission/{submissionId}        (delete)
 * - PUT    /course/{courseId}/submission/{submissionId}/answer (update a single answer's points)
 * - PUT    /course/{courseId}/submission/{submissionId}/grades (batch-grade -> marks Graded)
 *
 * Service layer: `listSubmissionsForGrading`, `updateSubmissionService`,
 * `deleteSubmissionService`, `updateSubmissionAnswer`,
 * `updateSubmissionGradesBatch` are PORTED below (the originals live
 * behind the `@api/*` alias in
 * apps/api/src/services/submission/submission.ts) using only
 * `@cio/db`/`@cio/utils` imports, which are resolvable from a standalone
 * Lambda bundle. This module intentionally does NOT import
 * `@cio/core/services/exercise/exercise` (unlike course-exercise-handler),
 * so it has no isomorphic-dompurify/jsdom dependency and does not need
 * the `externalNodeModules` workaround.
 *
 * `sendSubmissionUpdateEmail` (student-facing `submissionGraded`
 * notification, fired when a submission's status changes) is ported using
 * `enqueueTemplateEmail` from `../_shared/email-enqueue` (the same
 * SQS-based helper used by course-exercise-handler for
 * `submissionReceived`) instead of `apps/api/src/services/jobs`'s
 * `enqueueTransactionalEmail` (`@api/*`-only). Needs `EMAIL_QUEUE_URL` env
 * var + SQS `grantSendMessages` permission (added in api-stack.ts).
 *
 * KNOWN GAPS (documented, not silently dropped):
 *
 * (a) `syncComplianceProgressFromSubmission`
 *     (apps/api/src/services/course/compliance.ts) is NOT fired after a
 *     submission's grading state transitions to `completed` (via
 *     `updateSubmissionService` or `updateSubmissionGradesBatch`). Same
 *     narrower, intentionally-skipped compliance-cycle gap already
 *     documented in organization-audience-handler's module doc and
 *     course-exercise-handler's module doc gap (c). Regular
 *     (non-COMPLIANCE-type) grading works fully.
 *
 * This handler has no `evaluateCourseCertification`
 * (certificate-issuance) call to skip — that call only happens in
 * `createSubmissionService` (course-exercise-handler), not in any of
 * this router's five routes.
 *
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/db + better-auth.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { TSubmission } from '@cio/db/types';
import {
  deleteSubmission,
  getSubmissionById,
  getSubmissionsForGrading,
  updateQuestionAnswer,
  updateSubmission,
  updateSubmissionGrades
} from '@cio/db/queries/submission';
import { getCourseById, getCourseWithOrgData } from '@cio/db/queries/course';
import { getDashboardBaseUrl } from '@cio/core/config/dashboard-url';
import { generateDocumentDownloadPresignedUrls, generateVideoDownloadPresignedUrls } from '@cio/core/utils/s3';
import { buildEmailBranding, buildEmailFromName } from '@cio/email';
import type { AnswerData, FileUploadAnswerData, VideoRecordingAnswerData } from '@cio/question-types';
import { getQuestionTypeById, requiresManualGrading } from '@cio/question-types';
import { AppError, ErrorCodes } from '@cio/utils/errors';
import {
  ZSubmissionAnswerUpdate,
  ZSubmissionGetParam,
  ZSubmissionGradesUpdate,
  ZSubmissionUpdate,
  type TSubmissionUpdate
} from '@cio/utils/validation/submission';
import { requireCourseTeamMember } from '../_shared/course-membership';
import { enqueueTemplateEmail } from '../_shared/email-enqueue';

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

  console.error('[course-submission-handler] unexpected error:', error);
  return jsonResponse(500, { success: false, message: fallbackMessage });
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

// ---------------------------------------------------------------------------
// Grading-state helpers (ported from
// apps/api/src/services/submission/submission.ts)
// ---------------------------------------------------------------------------

type SubmissionGradingState = 'queued' | 'processing' | 'awaiting_manual' | 'completed' | 'failed';

const LEGACY_BOARD_STATUS_LABELS: Record<number, string> = {
  1: 'Submitted',
  2: 'In Progress',
  3: 'Graded'
};

const LEGACY_STATUS_TO_GRADING_STATE: Record<number, SubmissionGradingState> = {
  1: 'queued',
  2: 'processing',
  3: 'completed'
};

const GRADING_STATE_TO_LEGACY_STATUS: Record<SubmissionGradingState, number> = {
  queued: 1,
  processing: 2,
  awaiting_manual: 2,
  failed: 2,
  completed: 3
};

const ALLOWED_GRADING_TRANSITIONS: Record<SubmissionGradingState, SubmissionGradingState[]> = {
  queued: ['processing'],
  processing: ['completed', 'awaiting_manual', 'failed'],
  awaiting_manual: ['completed'],
  failed: ['queued'],
  completed: []
};

function projectLegacyStatusId(gradingState: SubmissionGradingState): number {
  return GRADING_STATE_TO_LEGACY_STATUS[gradingState];
}

function resolveSubmissionGradingState(submission: Partial<TSubmission>): SubmissionGradingState {
  const rawState = typeof submission.gradingState === 'string' ? submission.gradingState : '';
  if (rawState && rawState in GRADING_STATE_TO_LEGACY_STATUS) {
    return rawState as SubmissionGradingState;
  }

  const legacyStatusId = Number(submission.statusId ?? 1);
  return LEGACY_STATUS_TO_GRADING_STATE[legacyStatusId] ?? 'queued';
}

function resolveRequestedGradingState(data: TSubmissionUpdate): SubmissionGradingState | null {
  if (data.gradingState) {
    return data.gradingState;
  }

  if (data.statusId === undefined) {
    return null;
  }

  const mapped = LEGACY_STATUS_TO_GRADING_STATE[Number(data.statusId)];
  if (!mapped) {
    throw new AppError('Invalid submission status', ErrorCodes.VALIDATION_ERROR, 400);
  }

  return mapped;
}

function isAllowedGradingTransition(from: SubmissionGradingState, to: SubmissionGradingState): boolean {
  if (from === to) return true;
  return ALLOWED_GRADING_TRANSITIONS[from]?.includes(to) ?? false;
}

function isFileUpload(data: unknown): data is FileUploadAnswerData {
  return !!data && typeof data === 'object' && (data as { type: string }).type === 'FILE_UPLOAD';
}

function isVideoRecording(data: unknown): data is VideoRecordingAnswerData {
  return !!data && typeof data === 'object' && (data as { type: string }).type === 'VIDEO_RECORDING';
}

/**
 * Enriches FILE_UPLOAD entries in a { questionName -> AnswerData } map with
 * presigned download URLs. Mirrors `enrichFileUploadAnswersObject` in the
 * real service — used to build the grading-board answer payload.
 */
async function enrichFileUploadAnswersObject(answers: Record<string, AnswerData>): Promise<Record<string, AnswerData>> {
  const fileKeys = Object.values(answers)
    .filter(isFileUpload)
    .map((d) => d.fileKey);
  const videoKeys = Object.values(answers)
    .filter(isVideoRecording)
    .map((d) => d.storageKey);

  if (fileKeys.length === 0 && videoKeys.length === 0) return answers;

  try {
    const [documentUrls, videoUrls] = await Promise.all([
      generateDocumentDownloadPresignedUrls(fileKeys),
      generateVideoDownloadPresignedUrls(videoKeys)
    ]);
    return Object.fromEntries(
      Object.entries(answers).map(([key, data]) => {
        if (isFileUpload(data)) {
          const url = documentUrls[data.fileKey];
          return url ? [key, { ...data, fileUrl: url }] : [key, data];
        }

        if (!isVideoRecording(data)) return [key, data];
        const url = videoUrls[data.storageKey];
        return url ? [key, { ...data, playbackUrl: url }] : [key, data];
      })
    );
  } catch (error) {
    console.error('[course-submission-handler] enrichFileUploadAnswersObject error:', error);
    return answers;
  }
}

function resolveOverallStatusFromQuestionTypeIds(
  questionTypeIds: number[]
): 'auto_graded' | 'manual_required' | 'hybrid' {
  const manualFlags = questionTypeIds.map((questionTypeId) => {
    const metadata = getQuestionTypeById(questionTypeId);
    if (!metadata) return true;
    return requiresManualGrading(metadata.key);
  });

  const hasManual = manualFlags.some(Boolean);
  const hasAuto = manualFlags.some((value) => !value);

  if (hasManual && hasAuto) return 'hybrid';
  if (hasManual) return 'manual_required';
  return 'auto_graded';
}

/**
 * Sends email notification to the student when submission status changes.
 * Ports `sendSubmissionUpdateEmail` from the real submission service,
 * replacing `enqueueTransactionalEmail` with `enqueueTemplateEmail` (SQS).
 */
async function sendSubmissionUpdateEmail(submissionId: string, newStatusId: number) {
  const submission = await getSubmissionById(submissionId);
  if (!submission || !submission.courseId) {
    return;
  }

  const submissionData = await getSubmissionsForGrading(submission.courseId);
  const fullSubmission = submissionData.find((s) => s.id === submissionId);
  if (!fullSubmission || !fullSubmission.groupmember?.profile?.email) {
    return;
  }

  const courseResult = await getCourseById(fullSubmission.courseId || '');
  const course = courseResult[0];
  if (!course) {
    return;
  }

  const orgResult = await getCourseWithOrgData(fullSubmission.courseId || '');
  const orgName = orgResult?.orgName || 'ClassroomIO';

  const statusText = LEGACY_BOARD_STATUS_LABELS[newStatusId] || 'Updated';
  const baseUrl = getDashboardBaseUrl({
    siteName: orgResult?.orgSiteName,
    customDomain: orgResult?.orgCustomDomain,
    isCustomDomainVerified: orgResult?.orgIsCustomDomainVerified
  });
  const exerciseLink = `${baseUrl}/courses/${fullSubmission.courseId}/exercises/${fullSubmission.exercise.id}`;

  const answers = fullSubmission.answers || [];
  const totalMark = answers.reduce((sum: number, a: { point?: number | null }) => sum + (a.point || 0), 0);
  const maxMark = (fullSubmission.exercise.questions || []).reduce(
    (sum: number, q: { points?: number | null }) => sum + (q.points || 0),
    0
  );

  const isGraded = newStatusId === 3;
  const score = isGraded ? `${totalMark}/${maxMark}` : undefined;

  try {
    await enqueueTemplateEmail({
      kind: 'template',
      template: 'submissionGraded',
      to: fullSubmission.groupmember.profile.email,
      fields: {
        orgName,
        studentName: fullSubmission.groupmember.profile.fullname || 'Student',
        exerciseTitle: fullSubmission.exercise.title,
        courseName: course.title,
        statusText,
        exerciseLink,
        score,
        lessonTitle: fullSubmission.lesson?.title,
        branding: buildEmailBranding({
          name: orgResult?.orgName,
          avatarUrl: orgResult?.orgAvatarUrl,
          theme: orgResult?.orgTheme
        })
      },
      from: buildEmailFromName(`${orgName} (via ClassroomIO.com)`)
    });
  } catch (error) {
    console.error('[course-submission-handler] Failed to enqueue submission graded email:', error);
  }
}

// ---------------------------------------------------------------------------
// Service functions (ported from
// apps/api/src/services/submission/submission.ts)
// ---------------------------------------------------------------------------

/**
 * Ports `listSubmissionsForGrading` — builds the grading-board sections +
 * per-submission detail payload.
 */
async function listSubmissionsForGradingLocal(courseId: string) {
  const rawSubmissions = await getSubmissionsForGrading(courseId);

  type SubmissionItem = {
    id: string;
    statusId: number;
    gradingState: SubmissionGradingState;
    overallStatus: 'auto_graded' | 'manual_required' | 'hybrid';
    isEarly: boolean;
    feedback: string | null;
    submittedAt: string;
    exercise: { id: string; title: string };
    answers: unknown[];
    student: unknown | null;
    lesson: { id: string; title: string } | null;
  };

  const sections: Array<{ id: number; title: string; value: number; items: SubmissionItem[] }> = [
    { id: 1, title: LEGACY_BOARD_STATUS_LABELS[1], value: 0, items: [] },
    { id: 2, title: LEGACY_BOARD_STATUS_LABELS[2], value: 0, items: [] },
    { id: 3, title: LEGACY_BOARD_STATUS_LABELS[3], value: 0, items: [] }
  ];

  const submissionIdData: Record<string, unknown> = {};

  for (const submission of rawSubmissions) {
    const gradingState = resolveSubmissionGradingState(submission);
    const statusId = projectLegacyStatusId(gradingState);
    const storedOverallStatus = typeof submission.overallStatus === 'string' ? submission.overallStatus : '';
    const fallbackOverallStatus = resolveOverallStatusFromQuestionTypeIds(
      (submission.exercise.questions || [])
        .map((question: { questionTypeId?: number }) => Number(question.questionTypeId))
        .filter((questionTypeId: number) => Number.isFinite(questionTypeId))
    );
    const overallStatus: 'auto_graded' | 'manual_required' | 'hybrid' =
      storedOverallStatus === 'auto_graded' ||
      storedOverallStatus === 'manual_required' ||
      storedOverallStatus === 'hybrid'
        ? (storedOverallStatus as 'auto_graded' | 'manual_required' | 'hybrid')
        : fallbackOverallStatus;
    const isEarly = submission.exercise.dueBy
      ? new Date(submission.createdAt!).getTime() <= new Date(submission.exercise.dueBy).getTime()
      : true;

    const submittedAt = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'full',
      timeStyle: 'medium'
    }).format(new Date(submission.createdAt!));

    const questionKeyById: Record<number, string> = {};
    for (const question of submission.exercise.questions || []) {
      questionKeyById[question.id] = question.name ? String(question.name) : String(question.id);
    }

    const formattedAnswers: Record<string, AnswerData> = {};
    const questionAnswerByPoint: Record<number, number> = {};

    for (const answer of submission.answers || []) {
      const questionKey = questionKeyById[answer.questionId];
      if (
        questionKey &&
        answer.answerData &&
        typeof answer.answerData === 'object' &&
        answer.answerData !== null &&
        'type' in answer.answerData
      ) {
        formattedAnswers[questionKey] = answer.answerData as AnswerData;
      }
      questionAnswerByPoint[answer.questionId] = answer.point || 0;
    }

    const enrichedFormattedAnswers = await enrichFileUploadAnswersObject(formattedAnswers);

    const submissionItem: SubmissionItem = {
      id: submission.id,
      statusId,
      gradingState,
      overallStatus,
      isEarly,
      feedback: submission.feedback,
      submittedAt,
      exercise: { id: submission.exercise.id, title: submission.exercise.title },
      answers: submission.answers || [],
      student: submission.groupmember?.profile || null,
      lesson: submission.lesson ? { id: submission.lesson.id, title: submission.lesson.title } : null
    };

    const sectionIndex = statusId - 1;
    if (sectionIndex >= 0 && sectionIndex < sections.length) {
      sections[sectionIndex].items.push(submissionItem);
      sections[sectionIndex].value = sections[sectionIndex].items.length;
    }

    submissionIdData[submission.id] = {
      id: submission.id,
      statusId,
      gradingState,
      overallStatus,
      feedback: submission.feedback,
      isEarly,
      title: submission.exercise.title,
      student: submission.groupmember?.profile || null,
      questions: (submission.exercise.questions || []).map(
        (q: {
          id: number;
          title?: string;
          name?: string | null;
          order?: number;
          points?: number | null;
          questionTypeId: number;
          settings?: unknown;
          options?: Array<{ id: number; label?: string; value?: string; isCorrect: boolean; settings?: unknown }>;
        }) => ({
          id: q.id,
          title: q.title,
          name: q.name,
          order: q.order,
          points: q.points,
          questionTypeId: q.questionTypeId,
          settings: q.settings ?? {},
          options: (q.options || []).map((opt) => ({
            id: opt.id,
            label: opt.label,
            value: opt.value,
            isCorrect: opt.isCorrect,
            settings: opt.settings ?? {}
          }))
        })
      ),
      answers: enrichedFormattedAnswers,
      questionAnswers: (submission.answers || []).map((answer: { questionId: number; answerData: unknown }) => ({
        questionId: answer.questionId,
        answerData: answer.answerData
      })),
      questionAnswerByPoint
    };
  }

  return { sections, submissionIdData };
}

/** Ports `updateSubmissionService`. */
async function updateSubmissionServiceLocal(submissionId: string, data: TSubmissionUpdate): Promise<TSubmission> {
  const submission = await getSubmissionById(submissionId);
  if (!submission) {
    throw new AppError('Submission not found', ErrorCodes.SUBMISSION_NOT_FOUND, 404);
  }

  const currentGradingState = resolveSubmissionGradingState(submission);
  const requestedGradingState = resolveRequestedGradingState(data);
  if (requestedGradingState && !isAllowedGradingTransition(currentGradingState, requestedGradingState)) {
    throw new AppError('Invalid submission workflow transition', ErrorCodes.VALIDATION_ERROR, 400);
  }

  const previousLegacyStatusId = projectLegacyStatusId(currentGradingState);
  const updatePayload: Partial<TSubmission> = { ...data };
  if (requestedGradingState) {
    updatePayload.gradingState = requestedGradingState;
    updatePayload.statusId = projectLegacyStatusId(requestedGradingState);
  }

  const nextLegacyStatusId = Number(updatePayload.statusId ?? previousLegacyStatusId);
  const statusChanged = nextLegacyStatusId !== previousLegacyStatusId;

  const updated = await updateSubmission(submissionId, updatePayload);
  if (!updated) {
    throw new AppError('Failed to update submission', ErrorCodes.INTERNAL_ERROR, 500);
  }

  if (statusChanged) {
    void sendSubmissionUpdateEmail(submissionId, nextLegacyStatusId).catch((emailError) => {
      console.error('[course-submission-handler] Failed to send submission update email:', emailError);
    });
  }

  // NOTE: syncComplianceProgressFromSubmission is intentionally not
  // ported here — see module doc gap (a).

  return updated;
}

/** Ports `updateSubmissionAnswer`. */
async function updateSubmissionAnswerLocal(
  submissionId: string,
  questionId: number,
  points: number | undefined
): Promise<unknown> {
  const submission = await getSubmissionById(submissionId);
  if (!submission) {
    throw new AppError('Submission not found', ErrorCodes.SUBMISSION_NOT_FOUND, 404);
  }

  if (points === undefined) return null;

  const updated = await updateQuestionAnswer(submissionId, questionId, { point: points });
  if (!updated) {
    throw new AppError('Question answer not found', ErrorCodes.INTERNAL_ERROR, 404);
  }

  return updated;
}

/** Ports `updateSubmissionGradesBatch`. */
async function updateSubmissionGradesBatchLocal(
  submissionId: string,
  data: { answers: Array<{ questionId: number; points: number }>; total: number; feedback?: string; statusId?: number }
): Promise<TSubmission> {
  const submission = await getSubmissionById(submissionId);
  if (!submission) {
    throw new AppError('Submission not found', ErrorCodes.SUBMISSION_NOT_FOUND, 404);
  }

  const currentGradingState = resolveSubmissionGradingState(submission);
  const targetGradingState: SubmissionGradingState = 'completed';
  const targetStatusId = projectLegacyStatusId(targetGradingState);
  if (!isAllowedGradingTransition(currentGradingState, targetGradingState)) {
    throw new AppError('Invalid submission workflow transition', ErrorCodes.VALIDATION_ERROR, 400);
  }

  const previousLegacyStatusId = projectLegacyStatusId(currentGradingState);
  const statusChanged = targetStatusId !== previousLegacyStatusId;

  const updated = await updateSubmissionGrades(submissionId, {
    answers: data.answers,
    total: data.total,
    feedback: data.feedback,
    statusId: targetStatusId,
    gradingState: targetGradingState
  });

  if (!updated) {
    throw new AppError('Failed to update grades', ErrorCodes.INTERNAL_ERROR, 500);
  }

  if (statusChanged) {
    void sendSubmissionUpdateEmail(submissionId, targetStatusId).catch((emailError) => {
      console.error('[course-submission-handler] Failed to send submission update email:', emailError);
    });
  }

  // NOTE: syncComplianceProgressFromSubmission is intentionally not
  // ported here — see module doc gap (a).

  return updated;
}

/** Ports `deleteSubmissionService`. */
async function deleteSubmissionServiceLocal(submissionId: string): Promise<TSubmission> {
  const submission = await getSubmissionById(submissionId);
  if (!submission) {
    throw new AppError('Submission not found', ErrorCodes.SUBMISSION_NOT_FOUND, 404);
  }

  const deleted = await deleteSubmission(submissionId);
  if (!deleted) {
    throw new AppError('Failed to delete submission', ErrorCodes.INTERNAL_ERROR, 500);
  }

  return deleted;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /course/{courseId}/submission/for-grading */
async function handleListForGrading(event: APIGatewayProxyEventV2, courseId: string): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const data = await listSubmissionsForGradingLocal(courseId);
    return jsonResponse(200, { success: true, data });
  } catch (error) {
    return errorResponse(error, 'Failed to list submissions for grading');
  }
}

/** PUT /course/{courseId}/submission/{submissionId} */
async function handleUpdateSubmission(
  event: APIGatewayProxyEventV2,
  courseId: string,
  submissionId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZSubmissionGetParam.safeParse({ submissionId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid submissionId' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZSubmissionUpdate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const submission = await updateSubmissionServiceLocal(submissionId, validation.data);
    return jsonResponse(200, { success: true, data: submission });
  } catch (error) {
    return errorResponse(error, 'Failed to update submission');
  }
}

/** DELETE /course/{courseId}/submission/{submissionId} */
async function handleDeleteSubmission(
  event: APIGatewayProxyEventV2,
  courseId: string,
  submissionId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZSubmissionGetParam.safeParse({ submissionId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid submissionId' });
  }

  try {
    const submission = await deleteSubmissionServiceLocal(submissionId);
    return jsonResponse(200, { success: true, data: submission });
  } catch (error) {
    return errorResponse(error, 'Failed to delete submission');
  }
}

/** PUT /course/{courseId}/submission/{submissionId}/answer */
async function handleUpdateAnswer(
  event: APIGatewayProxyEventV2,
  courseId: string,
  submissionId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZSubmissionGetParam.safeParse({ submissionId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid submissionId' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZSubmissionAnswerUpdate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const { questionId, points } = validation.data;
    const answer = await updateSubmissionAnswerLocal(submissionId, questionId, points);
    return jsonResponse(200, { success: true, data: answer });
  } catch (error) {
    return errorResponse(error, 'Failed to update submission answer');
  }
}

/** PUT /course/{courseId}/submission/{submissionId}/grades */
async function handleUpdateGrades(
  event: APIGatewayProxyEventV2,
  courseId: string,
  submissionId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZSubmissionGetParam.safeParse({ submissionId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid submissionId' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZSubmissionGradesUpdate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const submission = await updateSubmissionGradesBatchLocal(submissionId, validation.data);
    return jsonResponse(200, { success: true, data: submission });
  } catch (error) {
    return errorResponse(error, 'Failed to update submission grades');
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  // /for-grading — most-specific literal segment checked first so it's
  // never mistaken for a `:submissionId` path segment.
  const forGradingMatch = /^\/course\/([^/]+)\/submission\/for-grading$/.exec(path);
  if (forGradingMatch && method === 'GET') {
    const [, courseId] = forGradingMatch;
    return handleListForGrading(event, courseId);
  }

  // /{submissionId}/answer
  const answerMatch = /^\/course\/([^/]+)\/submission\/([^/]+)\/answer$/.exec(path);
  if (answerMatch && method === 'PUT') {
    const [, courseId, submissionId] = answerMatch;
    return handleUpdateAnswer(event, courseId, submissionId);
  }

  // /{submissionId}/grades
  const gradesMatch = /^\/course\/([^/]+)\/submission\/([^/]+)\/grades$/.exec(path);
  if (gradesMatch && method === 'PUT') {
    const [, courseId, submissionId] = gradesMatch;
    return handleUpdateGrades(event, courseId, submissionId);
  }

  // /{submissionId} (update / delete)
  const submissionIdMatch = /^\/course\/([^/]+)\/submission\/([^/]+)$/.exec(path);
  if (submissionIdMatch) {
    const [, courseId, submissionId] = submissionIdMatch;
    if (method === 'PUT') return handleUpdateSubmission(event, courseId, submissionId);
    if (method === 'DELETE') return handleDeleteSubmission(event, courseId, submissionId);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
