/**
 * Course Exercise Handler Lambda
 *
 * Mirrors apps/api/src/routes/course/exercise.ts's `exerciseRouter`
 * (mounted at `/course/:courseId/exercise`). Prior to this handler there
 * was NO Lambda for any `/course/{courseId}/exercise*` route, so students
 * could not take an exercise/quiz at all via AWS — this closes that gap.
 *
 * Handles:
 * - GET    /course/{courseId}/exercise                                   (list)
 * - GET    /course/{courseId}/exercise/{exerciseId}/submissions           (overview)
 * - POST   /course/{courseId}/exercise/{exerciseId}/notify                (KNOWN GAP -> 404)
 * - GET    /course/{courseId}/exercise/{exerciseId}/notify/{jobId}        (KNOWN GAP -> 404)
 * - GET    /course/{courseId}/exercise/{exerciseId}                      (get one)
 * - POST   /course/{courseId}/exercise                                    (create)
 * - POST   /course/{courseId}/exercise/from-template                     (create from template)
 * - PUT    /course/{courseId}/exercise/{exerciseId}                      (update)
 * - DELETE /course/{courseId}/exercise/{exerciseId}                      (delete)
 * - POST   /course/{courseId}/exercise/{exerciseId}/submission            (student submits — the core "take a quiz" action)
 * - POST   /course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/init
 * - POST   /course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/complete
 * - GET    /course/{courseId}/exercise/{exerciseId}/submission/{submissionId}/question/{questionId}/video-recording/playback
 * - GET    /course/{courseId}/exercise/template                          (template metadata)
 * - GET    /course/{courseId}/exercise/template/{id}                     (template by id)
 * - GET    /course/{courseId}/exercise/template/tag/{tag}                (templates by tag)
 *
 * Auth: checked route-by-route in the real Hono router rather than
 * assumed uniform (several routes are asymmetric):
 * - Exercise CRUD/list/get and submission/video-recording/template routes
 *   use `courseMemberMiddleware`/`courseMemberOrAutomationKeyMiddleware`
 *   (any course member, or org admin) -> `requireCourseMember` here.
 * - `PUT /:exerciseId` only escalates to a team-check
 *   (`isCourseTeamMemberOrOrgAdmin`) when the payload sets
 *   `isUnlocked !== undefined` — ported verbatim below, NOT a blanket
 *   `requireCourseTeamMember` gate.
 * - `DELETE /:exerciseId` uses plain `courseMemberMiddleware` in the real
 *   router (not team-only) — ported as `requireCourseMember`, matching
 *   the Hono route exactly even though this looks surprising for a
 *   delete.
 *
 * KNOWN GAPS (documented, not silently dropped — dispatcher returns a
 * clean 404/no-op rather than crashing):
 *
 * (a) Automation-key/MCP auth (`authOrAutomationKeyMiddleware`,
 *     `courseMemberOrAutomationKeyMiddleware`,
 *     `assertMcpAutomationUsageAllowed`/`recordMcpAutomationUsage`) is NOT
 *     ported. Every route that supports it falls back to session-only
 *     auth (`requireCourseMember`) here — same established pattern as
 *     course-content-handler's documented automation-key gap.
 *
 * (b) `POST /:exerciseId/notify` and `GET /:exerciseId/notify/:jobId`
 *     depend on `@cio/jobs`'s BullMQ-based `notifyCourseExerciseService`/
 *     `getNotifyCourseExerciseStatusService`
 *     (apps/api/src/services/course/notify-exercise.ts). BullMQ/Redis is
 *     local-dev-only infra (AWS uses SQS + email-worker + SES instead) —
 *     same established gap category as lesson-mutation-handler's
 *     notify-session-update gap. Both routes return a clean 404 here.
 *
 * (c) `syncComplianceProgressFromSubmission`
 *     (apps/api/src/services/course/compliance.ts) is NOT fired after a
 *     successful submission. This is the compliance-cycle subsystem for
 *     COMPLIANCE-type courses — already documented as a narrower,
 *     intentionally-skipped gap in organization-audience-handler's module
 *     doc ("ensureComplianceEnrollmentRecordsForProfiles... narrower gap
 *     (f)"). Regular, non-COMPLIANCE-type exercise submission (the vast
 *     majority of exercises) works fully; only compliance-cycle progress
 *     tracking rows are not updated.
 *
 * (d) `triggerCertificationIfExerciseComplete` and
 *     `evaluateCourseCertification` are NOW IMPLEMENTED via
 *     `../_shared/course-certification.ts`. After a graded submission,
 *     `triggerCertificationIfExerciseComplete` is called fire-and-forget,
 *     which in turn invokes `evaluateCourseCertification` if the student
 *     has completed the exercise. This was previously a KNOWN GAP; it is
 *     now resolved.
 *
 * Service layer:
 * - `createExercise`/`createExerciseFromTemplate`/
 *   `deleteExerciseForCourseService`/`getExercise`/`listExercises`/
 *   `updateExerciseService` are imported directly from
 *   `@cio/core/services/exercise/exercise` (already resolvable outside
 *   `@api/*`, no porting needed).
 * - `listExerciseSubmissionsOverview`, `createSubmissionService`,
 *   `fetchAllTemplatesMetadata`/`fetchTemplateById`/`fetchTemplatesByTag`,
 *   and `initVideoRecordingUpload`/`completeVideoRecordingUpload`/
 *   `getVideoRecordingPlaybackUrl` are PORTED below (originals live behind
 *   the `@api/*` alias in apps/api/src/services/submission/submission.ts,
 *   apps/api/src/services/exercise/template.ts, and
 *   apps/api/src/services/exercise/video-recording.ts respectively) using
 *   only `@cio/core`/`@cio/db`/`@cio/utils`/`@cio/question-types` imports,
 *   which are all resolvable from a standalone Lambda bundle.
 * - `sendExerciseSubmissionUpdateEmail` (teacher-facing `submissionReceived`
 *   notification fired from `createSubmissionService`) is ported using
 *   `enqueueTemplateEmail` from `../_shared/email-enqueue` (the SQS-based
 *   helper already used by organization-team-handler/
 *   organization-audience-handler/onboarding-handler) instead of
 *   `apps/api/src/services/jobs`'s `enqueueTransactionalEmail` (which is
 *   `@api/*`-only). Needs `EMAIL_QUEUE_URL` env var + SQS
 *   `grantSendMessages` permission (added in api-stack.ts).
 * - `assertEnrolledStudentContentAccess`
 *   (apps/api/src/services/course/access.ts) is reimplemented locally as
 *   `assertEnrolledStudentContentAccessLocal` below, using
 *   `ContentType.Exercise` — same shape as lesson-extended-handler's
 *   `assertEnrolledStudentContentAccessLocal` (which used
 *   `ContentType.Lesson`). All of its actual dependencies
 *   (`assertStudentCanAccessContent` from
 *   `@cio/core/services/course/progression`, `getCourseById`/
 *   `getCourseProgress` from `@cio/db/queries/course`,
 *   `getCourseContentItems` from `@cio/db/queries/course/content`) are
 *   importable from a standalone Lambda bundle.
 *
 * externalNodeModules: `@cio/core/services/exercise/exercise` imports
 * `sanitizeHtml`/`sanitizeOptionalHtml`/`sanitizeUnknownStrings` at module
 * scope (isomorphic-dompurify -> jsdom), which reads its default
 * stylesheet relative to its own on-disk package location at import time
 * — esbuild's single-file bundling breaks that (ENOENT on cold start,
 * confirmed for course-mutation-handler/lesson-extended-handler/
 * lesson-mutation-handler). This Lambda needs the same
 * `externalNodeModules: ['isomorphic-dompurify']` workaround in
 * api-stack.ts.
 *
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/core + @cio/db +
 * @cio/question-types + better-auth.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  createExercise,
  createExerciseFromTemplate,
  deleteExerciseForCourseService,
  getExercise,
  listExercises,
  updateExerciseService
} from '@cio/core/services/exercise/exercise';
import { assertStudentCanAccessContent } from '@cio/core/services/course/progression';
import { getCourseById, getCourseContentItems, getCourseProgress } from '@cio/db/queries/course';
import { getGroupMemberIdByCourseAndProfile, isCourseTeamMemberOrOrgAdmin } from '@cio/db/queries/group';
import { getExerciseById, getExerciseWithRelationsOptimized } from '@cio/db/queries/exercise';
import { getAllTemplates, getTemplateById, getTemplateByTag } from '@cio/db/queries/template';
import { createAsset, createAssetUsage, getAssetById, updateAsset } from '@cio/db/queries/assets';
import { getCourseOrganizationId } from '@cio/db/queries/tag';
import { getCourseTeachers, getCourseWithOrgData, getProfileByGroupMemberId } from '@cio/db/queries/course';
import {
  createSubmission,
  getQuestionAnswersBySubmissionId,
  getSubmissionById,
  getSubmissionsByCourseIdWithDetails,
  hasSubmission,
  insertQuestionAnswersBatch,
  updateSubmissionGrades
} from '@cio/db/queries/submission';
import { getStorageConfig } from '@cio/core/config/storage';
import {
  generateDocumentDownloadPresignedUrls,
  generateVideoDownloadPresignedUrls,
  generateVideoUploadPresignedUrl
} from '@cio/core/utils/s3';
import { getDashboardBaseUrl } from '@cio/core/config/dashboard-url';
import { buildEmailBranding, buildEmailFromName } from '@cio/email';
import type { TExercise, TExerciseTemplate, TNewExerciseTemplate, TNewQuestionAnswer } from '@cio/db/types';
import type {
  AnswerData,
  FileUploadAnswerData,
  ScoreSubmissionResult,
  VideoRecordingAnswerData
} from '@cio/question-types';
import {
  QUESTION_TYPE_IDS,
  QUESTION_TYPE_ID_TO_KEY,
  VIDEO_RECORDING_MIN_DURATION_SECONDS,
  fromApiPayload,
  getQuestionTypeByTypename,
  getVideoRecordingMaxDurationSeconds,
  requiresManualGrading,
  scoreSubmissionAnswers,
  validateTextareaAnswer
} from '@cio/question-types';
import { AppError, ErrorCodes } from '@cio/utils/errors';
import { ContentType } from '@cio/utils/constants';
import {
  ZExerciseCreate,
  ZExerciseFromTemplate,
  ZExerciseGetParam,
  ZExerciseListQuery,
  ZExerciseSubmissionCreate,
  ZExerciseUpdate,
  ZExerciseVideoRecordingParam,
  ZExerciseVideoRecordingPlaybackParam,
  ZExerciseVideoRecordingUploadComplete,
  ZExerciseVideoRecordingUploadInit
} from '@cio/utils/validation/exercise';
import { ZTemplateById, ZTemplateByTag } from '@cio/utils/validation/mocks';
import { randomUUID } from 'node:crypto';
import { requireCourseMember } from '../_shared/course-membership';
import { enqueueTemplateEmail } from '../_shared/email-enqueue';
import { triggerCertificationIfExerciseComplete } from '../_shared/course-certification';

const DEFAULT_CONTENT_GROUPING = true;

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

  console.error('[course-exercise-handler] unexpected error:', error);
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

/**
 * Reimplements apps/api/src/services/course/access.ts's
 * `assertEnrolledStudentContentAccess` for exercises, using only
 * `@cio/core`/`@cio/db` imports — see module doc. Mirrors
 * lesson-extended-handler's `assertEnrolledStudentContentAccessLocal` but
 * with `ContentType.Exercise`.
 */
async function assertEnrolledStudentContentAccessLocal(params: {
  courseId: string;
  profileId: string;
  contentId: string;
  type: ContentType.Exercise;
}): Promise<void> {
  const [courseRows, progress, contentItems] = await Promise.all([
    getCourseById(params.courseId),
    getCourseProgress(params.courseId, params.profileId),
    getCourseContentItems(params.courseId, params.profileId)
  ]);

  const course = courseRows[0];
  if (!course) return;

  const isContentGroupingEnabled = course.metadata?.isContentGroupingEnabled ?? DEFAULT_CONTENT_GROUPING;
  const progressionMode = course.metadata?.progressionMode ?? 'free';

  await assertStudentCanAccessContent({
    courseId: params.courseId,
    profileId: params.profileId,
    roleId: progress.roleId,
    contentId: params.contentId,
    type: params.type,
    progressionMode,
    contentRows: contentItems,
    isContentGroupingEnabled
  });
}

// ---------------------------------------------------------------------------
// Submission helpers (ported from apps/api/src/services/submission/submission.ts)
// ---------------------------------------------------------------------------

type SubmissionGradingState = 'queued' | 'processing' | 'awaiting_manual' | 'completed' | 'failed';
type SubmissionOverallStatus = 'auto_graded' | 'manual_required' | 'hybrid';

const GRADING_STATE_TO_LEGACY_STATUS: Record<SubmissionGradingState, number> = {
  queued: 1,
  processing: 2,
  awaiting_manual: 2,
  failed: 2,
  completed: 3
};

function projectLegacyStatusId(gradingState: SubmissionGradingState): number {
  return GRADING_STATE_TO_LEGACY_STATUS[gradingState];
}

function isFileUpload(data: unknown): data is FileUploadAnswerData {
  return !!data && typeof data === 'object' && (data as { type: string }).type === 'FILE_UPLOAD';
}

function isVideoRecording(data: unknown): data is VideoRecordingAnswerData {
  return !!data && typeof data === 'object' && (data as { type: string }).type === 'VIDEO_RECORDING';
}

function resolveOverallStatusFromTypenames(typenames: string[]): SubmissionOverallStatus {
  const manualFlags = typenames.map((typename) => {
    const metadata = getQuestionTypeByTypename(typename);
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
 * Enriches FILE_UPLOAD/VIDEO_RECORDING answers from DB rows with presigned
 * download URLs. Mirrors `enrichFileUploadAnswersArray` in the real service.
 */
async function enrichFileUploadAnswersArray<T extends { answerData?: unknown }>(answers: T[]): Promise<T[]> {
  const fileKeys = answers
    .map((a) => a.answerData)
    .filter(isFileUpload)
    .map((d) => d.fileKey);
  const videoKeys = answers
    .map((a) => a.answerData)
    .filter(isVideoRecording)
    .map((d) => d.storageKey);

  if (fileKeys.length === 0 && videoKeys.length === 0) return answers;

  try {
    const [documentUrls, videoUrls] = await Promise.all([
      generateDocumentDownloadPresignedUrls(fileKeys),
      generateVideoDownloadPresignedUrls(videoKeys)
    ]);
    return answers.map((answer) => {
      if (isFileUpload(answer.answerData)) {
        const url = documentUrls[answer.answerData.fileKey];
        return url ? { ...answer, answerData: { ...answer.answerData, fileUrl: url } } : answer;
      }

      if (!isVideoRecording(answer.answerData)) return answer;
      const url = videoUrls[answer.answerData.storageKey];
      return url ? { ...answer, answerData: { ...answer.answerData, playbackUrl: url } } : answer;
    });
  } catch (error) {
    console.error('[course-exercise-handler] enrichFileUploadAnswersArray error:', error);
    return answers;
  }
}

async function createVideoRecordingAssetUsages(answers: Array<TNewQuestionAnswer & { id?: number }>): Promise<void> {
  const videoAnswers = answers.filter((answer) => isVideoRecording(answer.answerData));
  if (videoAnswers.length === 0) return;

  await Promise.all(
    videoAnswers.map(async (answer) => {
      if (!answer.id || !isVideoRecording(answer.answerData)) return;

      const asset = await getAssetById(answer.answerData.assetId);
      if (!asset) return;

      await createAssetUsage({
        organizationId: asset.organizationId,
        assetId: answer.answerData.assetId,
        targetType: 'submission_answer',
        targetId: String(answer.id),
        slotType: 'video_recording_answer',
        slotKey: String(answer.questionId),
        createdByProfileId: null
      });
    })
  );
}

/**
 * Ports `listSubmissionsByExercise` from the real submission service.
 */
async function listSubmissionsByExercise(courseId: string, exerciseId: string, submittedBy?: string) {
  const submissions = await getSubmissionsByCourseIdWithDetails(courseId, exerciseId, submittedBy);
  const enriched = await Promise.all(
    submissions.map(async (s) =>
      s.answers?.length ? { ...s, answers: await enrichFileUploadAnswersArray(s.answers) } : s
    )
  );
  enriched.sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
  return enriched;
}

/**
 * Ports `listExerciseSubmissionsOverview` from the real submission service.
 */
async function listExerciseSubmissionsOverview(courseId: string, exerciseId: string, profileId: string) {
  const [groupMemberId, isInstructor] = await Promise.all([
    getGroupMemberIdByCourseAndProfile(courseId, profileId),
    isCourseTeamMemberOrOrgAdmin(courseId, profileId)
  ]);

  const mySubmission = groupMemberId ? await listSubmissionsByExercise(courseId, exerciseId, groupMemberId) : [];

  if (!isInstructor) {
    return { mySubmission, allSubmissions: [] };
  }

  const allSubmissions = await listSubmissionsByExercise(courseId, exerciseId);

  return { mySubmission, allSubmissions };
}

/**
 * Ports `sendExerciseSubmissionUpdateEmail` from the real submission
 * service, replacing `enqueueTransactionalEmail` (apps/api's `@api/*`-only
 * queue helper) with `enqueueTemplateEmail` (SQS, see module doc).
 */
async function sendExerciseSubmissionUpdateEmail(courseId: string, exerciseId: string, submittedBy: string) {
  const course = (await getCourseById(courseId))[0];
  if (!course) return;

  const exercise = await getExerciseById(exerciseId);
  if (!exercise) return;

  const student = await getProfileByGroupMemberId(submittedBy);
  if (!student) return;

  const tutorsResult = await getCourseTeachers({ courseId });
  if (tutorsResult.length === 0) return;

  const orgResult = await getCourseWithOrgData(courseId);
  const orgName = orgResult?.orgName || 'ClassroomIO';

  const baseUrl = getDashboardBaseUrl({
    siteName: orgResult?.orgSiteName,
    customDomain: orgResult?.orgCustomDomain,
    isCustomDomainVerified: orgResult?.orgIsCustomDomainVerified
  });
  const exerciseLink = `${baseUrl}/courses/${courseId}/exercises/${exerciseId}`;
  const submissionLink = `${baseUrl}/courses/${courseId}/submissions`;

  const studentName = student.fullname || student.username || 'A student';

  const tutorEmails = tutorsResult.map((tutor) => tutor.email).filter((email): email is string => Boolean(email));
  if (tutorEmails.length === 0) return;

  const from = buildEmailFromName(`${orgName} (via ClassroomIO.com)`);
  const branding = buildEmailBranding({
    name: orgResult?.orgName,
    avatarUrl: orgResult?.orgAvatarUrl,
    theme: orgResult?.orgTheme
  });

  await Promise.all(
    tutorEmails.map(async (to) => {
      try {
        await enqueueTemplateEmail({
          kind: 'template',
          template: 'submissionReceived',
          to,
          fields: {
            orgName,
            studentName,
            exerciseTitle: exercise.title,
            exerciseLink,
            submissionLink,
            branding
          },
          from
        });
      } catch (emailError) {
        console.error('[course-exercise-handler] Failed to enqueue submission received email:', emailError);
      }
    })
  );
}

/**
 * Ports `createSubmissionService` from the real submission service — this
 * is the core "take a quiz" action. `syncComplianceProgressFromSubmission`
 * and `triggerCertificationIfExerciseComplete` are intentionally NOT
 * called — see module doc gaps (c)/(d).
 */
async function createSubmissionService(
  courseId: string,
  exerciseId: string,
  submittedBy: string,
  answers: Array<{ questionId: number; optionId?: number; answer?: string }>
) {
  const [exerciseWithRelations, courseRows] = await Promise.all([
    getExerciseWithRelationsOptimized(exerciseId),
    getCourseById(courseId)
  ]);
  const course = courseRows[0];
  void course;

  if (!exerciseWithRelations.exercise.allowMultipleAttempts) {
    const alreadySubmitted = await hasSubmission(exerciseId, submittedBy);
    if (alreadySubmitted) {
      throw new AppError('This exercise allows only one submission', ErrorCodes.VALIDATION_ERROR, 400);
    }
  }

  const overallStatus = resolveOverallStatusFromTypenames(
    exerciseWithRelations.questions
      .map((question) => question.questionType?.typename ?? '')
      .filter((typename) => typename.length > 0)
  );
  const gradingState: SubmissionGradingState =
    overallStatus === 'manual_required' || overallStatus === 'hybrid' ? 'awaiting_manual' : 'queued';

  const submissionData = {
    courseId,
    exerciseId,
    submittedBy,
    statusId: projectLegacyStatusId(gradingState),
    gradingState,
    overallStatus,
    total: 0
  };

  let submission = await createSubmission(submissionData);

  const questionById = new Map(
    exerciseWithRelations.questions.map((q) => {
      const questionTypeKey = QUESTION_TYPE_ID_TO_KEY[q.questionTypeId] ?? 'TEXTAREA';
      return [
        q.id,
        {
          id: q.id,
          title: String(q.title ?? ''),
          questionType: questionTypeKey,
          points: Number(q.points ?? 0),
          settings:
            q.settings && typeof q.settings === 'object' && !Array.isArray(q.settings)
              ? (q.settings as Record<string, unknown>)
              : {},
          options: (q.options ?? []).map((o) => ({
            id: o.id,
            label: o.label ?? '',
            value: o.value ?? undefined,
            isCorrect: o.isCorrect
          }))
        }
      ];
    })
  );

  const answerByQuestionId = new Map<number, AnswerData>();
  const answerRows: TNewQuestionAnswer[] = [];

  for (const ans of answers) {
    const question = questionById.get(ans.questionId);
    if (!question) continue;

    const answerData = fromApiPayload(
      question.questionType,
      { questionId: ans.questionId, optionId: ans.optionId, answer: ans.answer },
      question
    );
    if (!answerData) continue;

    if (answerData.type === 'TEXTAREA') {
      const validation = validateTextareaAnswer(answerData.text, question);

      if (!validation.isValid) {
        throw new AppError(
          validation.minCharacters !== undefined && validation.maxCharacters !== undefined
            ? `Paragraph answer must be between ${validation.minCharacters} and ${validation.maxCharacters} characters`
            : validation.reason === 'below_min' && validation.minCharacters !== undefined
              ? `Paragraph answer must be at least ${validation.minCharacters} characters`
              : `Paragraph answer must be at most ${validation.maxCharacters} characters`,
          ErrorCodes.VALIDATION_ERROR,
          400
        );
      }
    }

    if (answerData.type === 'VIDEO_RECORDING') {
      const maxDurationSeconds = getVideoRecordingMaxDurationSeconds(question.settings);
      if (answerData.durationSeconds > maxDurationSeconds + 2) {
        throw new AppError('Recording exceeds the configured duration', ErrorCodes.VALIDATION_ERROR, 400);
      }
    }

    answerByQuestionId.set(ans.questionId, answerData);

    answerRows.push({
      submissionId: submission.id,
      questionId: ans.questionId,
      groupMemberId: submittedBy,
      answerData
    });
  }

  const shouldAutoGrade = overallStatus === 'auto_graded' && exerciseWithRelations.questions.length > 0;

  if (shouldAutoGrade) {
    const answeredIds = new Set(answerByQuestionId.keys());
    for (const q of exerciseWithRelations.questions) {
      if (q.id == null) continue;
      if (!answeredIds.has(q.id)) {
        answerRows.push({
          submissionId: submission.id,
          questionId: q.id,
          groupMemberId: submittedBy,
          answerData: null
        });
      }
    }
  }

  const insertedAnswers = answerRows.length > 0 ? await insertQuestionAnswersBatch(answerRows) : [];
  await createVideoRecordingAssetUsages(insertedAnswers);

  if (shouldAutoGrade) {
    const dbQuestions = exerciseWithRelations.questions
      .filter((q): q is typeof q & { id: number } => q.id != null)
      .map((q) => ({
        id: q.id,
        title: q.title,
        questionTypeId: q.questionTypeId,
        points: q.points != null ? Number(q.points) : 0,
        settings: (q.settings as Record<string, unknown>) ?? {},
        options: q.options ?? []
      }));

    const { scores, total }: ScoreSubmissionResult = scoreSubmissionAnswers(dbQuestions, answerByQuestionId);

    const graded = await updateSubmissionGrades(submission.id, {
      answers: scores.map((s: ScoreSubmissionResult['scores'][number]) => ({
        questionId: s.questionId,
        points: s.points
      })),
      total,
      statusId: 3,
      gradingState: 'completed'
    });

    if (graded) {
      submission = graded;

      const pointByQuestionId = new Map(
        scores.map((s: ScoreSubmissionResult['scores'][number]) => [s.questionId, s.points])
      );
      const answersWithPoints = insertedAnswers.map((row) => ({
        ...row,
        point: pointByQuestionId.get(row.questionId) ?? row.point
      }));

      void sendExerciseSubmissionUpdateEmail(courseId, exerciseId, submittedBy).catch((emailError) => {
        console.error('[course-exercise-handler] Failed to send exercise submission update email:', emailError);
      });

      void triggerCertificationIfExerciseComplete(courseId, exerciseId, submittedBy);

      const enrichedAnswers =
        answersWithPoints.length > 0 ? await enrichFileUploadAnswersArray(answersWithPoints) : answersWithPoints;
      return { ...submission, answers: enrichedAnswers };
    }
  }

  void sendExerciseSubmissionUpdateEmail(courseId, exerciseId, submittedBy).catch((emailError) => {
    console.error('[course-exercise-handler] Failed to send exercise submission update email:', emailError);
  });

  if (submission.gradingState === 'completed') {
    void triggerCertificationIfExerciseComplete(courseId, exerciseId, submittedBy);
  }

  return submission;
}

// ---------------------------------------------------------------------------
// Template helpers (ported from apps/api/src/services/exercise/template.ts
// and apps/api/src/utils/template.ts)
// ---------------------------------------------------------------------------

function calculateTotalPoints(template: TNewExerciseTemplate): number {
  let totalPoints = 0;

  if (!template.questionnaire) {
    return 0;
  }

  template.questionnaire.questions.forEach((question) => {
    totalPoints += question.points;
  });

  return totalPoints;
}

function mapTemplateToMetadata(templates: TNewExerciseTemplate[]) {
  return templates.map((template) => {
    const questionnaire = template.questionnaire;
    if (!questionnaire) {
      throw new Error(`Template ${template.id} is missing questionnaire`);
    }

    return {
      id: template.id,
      title: template.title,
      description: template.description,
      questions: questionnaire.questions.length,
      points: calculateTotalPoints(template),
      tag: template.tag
    };
  });
}

async function fetchAllTemplatesMetadata() {
  const templates = await getAllTemplates();
  return mapTemplateToMetadata(templates);
}

async function fetchTemplateById(id: number): Promise<TExerciseTemplate | undefined> {
  return getTemplateById(id);
}

async function fetchTemplatesByTag(tag: string) {
  const templates = await getTemplateByTag(tag);
  return mapTemplateToMetadata(templates);
}

// ---------------------------------------------------------------------------
// Video-recording helpers (ported from
// apps/api/src/services/exercise/video-recording.ts)
// ---------------------------------------------------------------------------

type RecordingContext = {
  organizationId: string;
  groupMemberId: string;
  maxDurationSeconds: number;
};

function getExtensionFromMimeType(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('quicktime')) return 'mov';
  return 'webm';
}

async function getCourseOrganizationIdResolved(courseId: string): Promise<string> {
  const organizationId = await getCourseOrganizationId(courseId);

  if (!organizationId) {
    throw new AppError('Course organization not found', ErrorCodes.NOT_FOUND, 404);
  }

  return organizationId;
}

async function getRecordingContext(
  courseId: string,
  exerciseId: string,
  questionId: number,
  profileId: string
): Promise<RecordingContext> {
  const [organizationId, groupMemberId, exerciseWithRelations] = await Promise.all([
    getCourseOrganizationIdResolved(courseId),
    getGroupMemberIdByCourseAndProfile(courseId, profileId),
    getExerciseWithRelationsOptimized(exerciseId)
  ]);

  if (!groupMemberId) {
    throw new AppError('User is not a member of this course', ErrorCodes.UNAUTHORIZED, 403);
  }

  const question = exerciseWithRelations.questions.find((item) => item.id === questionId);
  if (!question) {
    throw new AppError('Question not found for this exercise', ErrorCodes.NOT_FOUND, 404);
  }

  if (question.questionTypeId !== QUESTION_TYPE_IDS.VIDEO_RECORDING) {
    throw new AppError('Question is not a video recording question', ErrorCodes.VALIDATION_ERROR, 400);
  }

  return {
    organizationId,
    groupMemberId,
    maxDurationSeconds: getVideoRecordingMaxDurationSeconds(question.settings as Record<string, unknown> | null)
  };
}

async function initVideoRecordingUpload(
  courseId: string,
  exerciseId: string,
  questionId: number,
  profileId: string,
  input: { fileName: string; mimeType: string; size: number }
) {
  const context = await getRecordingContext(courseId, exerciseId, questionId, profileId);
  const extension = getExtensionFromMimeType(input.mimeType);
  const storageKey = [
    'exercise-recordings',
    context.organizationId,
    courseId,
    exerciseId,
    String(questionId),
    context.groupMemberId,
    `${randomUUID()}.${extension}`
  ].join('/');

  const asset = await createAsset({
    organizationId: context.organizationId,
    kind: 'video',
    provider: 'upload',
    storageProvider: 's3',
    storageKey,
    mimeType: input.mimeType,
    byteSize: input.size,
    title: input.fileName,
    status: 'pending',
    metadata: {
      source: 'exercise_video_recording',
      courseId,
      exerciseId,
      questionId,
      groupMemberId: context.groupMemberId,
      maxDurationSeconds: context.maxDurationSeconds
    },
    createdByProfileId: profileId
  });

  const uploadUrl = await generateVideoUploadPresignedUrl(storageKey, input.mimeType);
  const expiresAt = new Date(Date.now() + getStorageConfig().presignUploadExpiresSeconds * 1000).toISOString();

  return {
    assetId: asset.id,
    uploadUrl,
    storageKey,
    expiresAt
  };
}

async function completeVideoRecordingUpload(
  courseId: string,
  exerciseId: string,
  questionId: number,
  profileId: string,
  input: {
    assetId: string;
    storageKey: string;
    fileName: string;
    mimeType: string;
    size: number;
    durationSeconds: number;
    recordedAt: string;
    retakeCount?: number;
  }
): Promise<VideoRecordingAnswerData> {
  const context = await getRecordingContext(courseId, exerciseId, questionId, profileId);
  if (input.durationSeconds < VIDEO_RECORDING_MIN_DURATION_SECONDS) {
    throw new AppError('Recording is too short', ErrorCodes.VALIDATION_ERROR, 400);
  }
  if (input.durationSeconds > context.maxDurationSeconds + 2) {
    throw new AppError('Recording exceeds the configured duration', ErrorCodes.VALIDATION_ERROR, 400);
  }

  const asset = await getAssetById(input.assetId, context.organizationId);
  if (!asset || asset.storageKey !== input.storageKey) {
    throw new AppError('Recording asset not found', ErrorCodes.NOT_FOUND, 404);
  }

  const uploadedAt = new Date().toISOString();

  await updateAsset(input.assetId, context.organizationId, {
    status: 'active',
    storageKey: input.storageKey,
    mimeType: input.mimeType,
    byteSize: input.size,
    title: input.fileName,
    durationSeconds: Math.ceil(input.durationSeconds),
    metadata: {
      ...(asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata) ? asset.metadata : {}),
      recordedAt: input.recordedAt,
      uploadedAt,
      retakeCount: input.retakeCount ?? 0
    }
  });

  return {
    type: 'VIDEO_RECORDING',
    assetId: input.assetId,
    storageKey: input.storageKey,
    fileName: input.fileName,
    mimeType: input.mimeType,
    size: input.size,
    durationSeconds: Math.ceil(input.durationSeconds),
    recordedAt: input.recordedAt,
    uploadedAt,
    provider: 'cloudflare',
    retakeCount: input.retakeCount ?? 0
  };
}

async function getVideoRecordingPlaybackUrl(
  courseId: string,
  exerciseId: string,
  submissionId: string,
  questionId: number,
  profileId: string
) {
  const [submission, groupMemberId, isReviewer] = await Promise.all([
    getSubmissionById(submissionId),
    getGroupMemberIdByCourseAndProfile(courseId, profileId),
    isCourseTeamMemberOrOrgAdmin(courseId, profileId)
  ]);

  if (!submission || submission.courseId !== courseId || submission.exerciseId !== exerciseId) {
    throw new AppError('Submission not found', ErrorCodes.NOT_FOUND, 404);
  }

  if (!isReviewer && (!groupMemberId || submission.submittedBy !== groupMemberId)) {
    throw new AppError('Unauthorized', ErrorCodes.UNAUTHORIZED, 403);
  }

  const answers = await getQuestionAnswersBySubmissionId(submissionId);
  const answer = answers.find((item) => item.questionId === questionId);
  const answerData = answer?.answerData;
  if (!answerData || answerData.type !== 'VIDEO_RECORDING') {
    throw new AppError('Video recording answer not found', ErrorCodes.NOT_FOUND, 404);
  }

  const urls = await generateVideoDownloadPresignedUrls([answerData.storageKey]);
  const playbackUrl = urls[answerData.storageKey];
  if (!playbackUrl) {
    throw new AppError('Video recording is unavailable', ErrorCodes.INTERNAL_ERROR, 500);
  }

  return {
    assetId: answerData.assetId,
    playbackUrl,
    expiresAt: new Date(Date.now() + getStorageConfig().presignDownloadExpiresSeconds * 1000).toISOString()
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /course/{courseId}/exercise */
async function handleListExercises(event: APIGatewayProxyEventV2, courseId: string): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const queryValidation = ZExerciseListQuery.safeParse(event.queryStringParameters ?? {});
  if (!queryValidation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid query parameters',
      errors: queryValidation.error.issues
    });
  }

  try {
    const { lessonId, sectionId } = queryValidation.data;
    const exercises = await listExercises(courseId, { lessonId, sectionId }, member.userId);
    return jsonResponse(200, { success: true, data: exercises });
  } catch (error) {
    return errorResponse(error, 'Failed to list exercises');
  }
}

/** GET /course/{courseId}/exercise/{exerciseId}/submissions */
async function handleGetSubmissionsOverview(
  event: APIGatewayProxyEventV2,
  courseId: string,
  exerciseId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const data = await listExerciseSubmissionsOverview(courseId, exerciseId, member.userId);
    return jsonResponse(200, { success: true, data });
  } catch (error) {
    return errorResponse(error, 'Failed to fetch exercise submissions overview');
  }
}

/** GET /course/{courseId}/exercise/{exerciseId} */
async function handleGetExercise(
  event: APIGatewayProxyEventV2,
  courseId: string,
  exerciseId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZExerciseGetParam.safeParse({ exerciseId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid exerciseId' });
  }

  try {
    await assertEnrolledStudentContentAccessLocal({
      courseId,
      profileId: member.userId,
      contentId: exerciseId,
      type: ContentType.Exercise
    });

    const exercise = await getExercise(exerciseId, undefined, member.userId);
    return jsonResponse(200, { success: true, data: exercise });
  } catch (error) {
    return errorResponse(error, 'Failed to fetch exercise');
  }
}

/** POST /course/{courseId}/exercise */
async function handleCreateExercise(event: APIGatewayProxyEventV2, courseId: string): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZExerciseCreate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const exercise = await createExercise(validation.data);
    return jsonResponse(201, { success: true, data: exercise });
  } catch (error) {
    return errorResponse(error, 'Failed to create exercise');
  }
}

/** POST /course/{courseId}/exercise/from-template */
async function handleCreateExerciseFromTemplate(
  event: APIGatewayProxyEventV2,
  courseId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZExerciseFromTemplate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const { lessonId, sectionId, order, templateId } = validation.data;

    const template = await fetchTemplateById(templateId);
    if (!template) {
      return jsonResponse(404, { success: false, error: 'Template not found' });
    }

    if (!template.questionnaire) {
      return jsonResponse(400, { success: false, error: 'Template is missing questionnaire data' });
    }

    const exercise: TExercise = await createExerciseFromTemplate(courseId, lessonId, sectionId, order, template);
    return jsonResponse(201, { success: true, data: exercise });
  } catch (error) {
    return errorResponse(error, 'Failed to create exercise from template');
  }
}

/** PUT /course/{courseId}/exercise/{exerciseId} */
async function handleUpdateExercise(
  event: APIGatewayProxyEventV2,
  courseId: string,
  exerciseId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZExerciseGetParam.safeParse({ exerciseId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid exerciseId' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZExerciseUpdate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const data = validation.data;

    if (data.isUnlocked !== undefined) {
      const isAuthorized = await isCourseTeamMemberOrOrgAdmin(courseId, member.userId);
      if (!isAuthorized) {
        return jsonResponse(403, { success: false, error: 'Unauthorized', code: ErrorCodes.UNAUTHORIZED });
      }
    }

    const exercise = await updateExerciseService(exerciseId, data);
    return jsonResponse(200, { success: true, data: exercise });
  } catch (error) {
    return errorResponse(error, 'Failed to update exercise');
  }
}

/** DELETE /course/{courseId}/exercise/{exerciseId} */
async function handleDeleteExercise(
  event: APIGatewayProxyEventV2,
  courseId: string,
  exerciseId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZExerciseGetParam.safeParse({ exerciseId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid exerciseId' });
  }

  try {
    const exercise = await deleteExerciseForCourseService(courseId, exerciseId);
    return jsonResponse(200, { success: true, data: exercise });
  } catch (error) {
    return errorResponse(error, 'Failed to delete exercise');
  }
}

/** POST /course/{courseId}/exercise/{exerciseId}/submission — the core "take a quiz" action */
async function handleSubmitExercise(
  event: APIGatewayProxyEventV2,
  courseId: string,
  exerciseId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZExerciseGetParam.safeParse({ exerciseId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid exerciseId' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZExerciseSubmissionCreate.safeParse({ exerciseId, ...(body as Record<string, unknown>) });
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const groupMemberId = await getGroupMemberIdByCourseAndProfile(courseId, member.userId);
    if (!groupMemberId) {
      return jsonResponse(403, { success: false, error: 'User is not a member of this course' });
    }

    await assertEnrolledStudentContentAccessLocal({
      courseId,
      profileId: member.userId,
      contentId: exerciseId,
      type: ContentType.Exercise
    });

    const submission = await createSubmissionService(courseId, exerciseId, groupMemberId, validation.data.answers);
    return jsonResponse(201, { success: true, data: submission });
  } catch (error) {
    return errorResponse(error, 'Failed to submit exercise');
  }
}

/** POST /course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/init */
async function handleVideoUploadInit(
  event: APIGatewayProxyEventV2,
  courseId: string,
  exerciseId: string,
  questionIdRaw: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZExerciseVideoRecordingParam.safeParse({ exerciseId, questionId: questionIdRaw });
  if (!paramValidation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid path parameters',
      errors: paramValidation.error.issues
    });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZExerciseVideoRecordingUploadInit.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const upload = await initVideoRecordingUpload(
      courseId,
      exerciseId,
      paramValidation.data.questionId,
      member.userId,
      validation.data
    );
    return jsonResponse(200, { success: true, data: upload });
  } catch (error) {
    return errorResponse(error, 'Failed to initialize video recording upload');
  }
}

/** POST /course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/complete */
async function handleVideoUploadComplete(
  event: APIGatewayProxyEventV2,
  courseId: string,
  exerciseId: string,
  questionIdRaw: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZExerciseVideoRecordingParam.safeParse({ exerciseId, questionId: questionIdRaw });
  if (!paramValidation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid path parameters',
      errors: paramValidation.error.issues
    });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZExerciseVideoRecordingUploadComplete.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const answer = await completeVideoRecordingUpload(
      courseId,
      exerciseId,
      paramValidation.data.questionId,
      member.userId,
      validation.data
    );
    return jsonResponse(200, { success: true, data: answer });
  } catch (error) {
    return errorResponse(error, 'Failed to complete video recording upload');
  }
}

/** GET /course/{courseId}/exercise/{exerciseId}/submission/{submissionId}/question/{questionId}/video-recording/playback */
async function handleVideoPlayback(
  event: APIGatewayProxyEventV2,
  courseId: string,
  exerciseId: string,
  submissionId: string,
  questionIdRaw: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZExerciseVideoRecordingPlaybackParam.safeParse({
    exerciseId,
    submissionId,
    questionId: questionIdRaw
  });
  if (!paramValidation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid path parameters',
      errors: paramValidation.error.issues
    });
  }

  try {
    const playback = await getVideoRecordingPlaybackUrl(
      courseId,
      exerciseId,
      submissionId,
      paramValidation.data.questionId,
      member.userId
    );
    return jsonResponse(200, { success: true, data: playback });
  } catch (error) {
    return errorResponse(error, 'Failed to get video recording playback URL');
  }
}

/** GET /course/{courseId}/exercise/template */
async function handleListTemplateMetadata(
  event: APIGatewayProxyEventV2,
  courseId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const result = await fetchAllTemplatesMetadata();
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    return errorResponse(error, 'Failed to load template metadata');
  }
}

/** GET /course/{courseId}/exercise/template/{id} */
async function handleGetTemplateById(
  event: APIGatewayProxyEventV2,
  courseId: string,
  idRaw: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZTemplateById.safeParse({ id: idRaw });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid template id' });
  }

  try {
    const result = await fetchTemplateById(paramValidation.data.id);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    return errorResponse(error, 'Failed to load template');
  }
}

/** GET /course/{courseId}/exercise/template/tag/{tag} */
async function handleGetTemplatesByTag(
  event: APIGatewayProxyEventV2,
  courseId: string,
  tag: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZTemplateByTag.safeParse({ tag });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid tag' });
  }

  try {
    const result = await fetchTemplatesByTag(paramValidation.data.tag);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    return errorResponse(error, 'Failed to load template');
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  // Most-specific literal suffixes are matched first so `submissions`,
  // `notify[/:jobId]`, `submission`, `question/.../video-recording/...`,
  // and `template[...]` are never mistaken for a `:exerciseId` segment.

  // /template/tag/{tag}
  const templateTagMatch = /^\/course\/([^/]+)\/exercise\/template\/tag\/([^/]+)$/.exec(path);
  if (templateTagMatch && method === 'GET') {
    const [, courseId, tag] = templateTagMatch;
    return handleGetTemplatesByTag(event, courseId, tag);
  }

  // /template/{id}
  const templateByIdMatch = /^\/course\/([^/]+)\/exercise\/template\/([^/]+)$/.exec(path);
  if (templateByIdMatch && method === 'GET') {
    const [, courseId, id] = templateByIdMatch;
    return handleGetTemplateById(event, courseId, id);
  }

  // /template (bare)
  const templateMatch = /^\/course\/([^/]+)\/exercise\/template$/.exec(path);
  if (templateMatch && method === 'GET') {
    const [, courseId] = templateMatch;
    return handleListTemplateMetadata(event, courseId);
  }

  // /from-template
  const fromTemplateMatch = /^\/course\/([^/]+)\/exercise\/from-template$/.exec(path);
  if (fromTemplateMatch && method === 'POST') {
    const [, courseId] = fromTemplateMatch;
    return handleCreateExerciseFromTemplate(event, courseId);
  }

  // /{exerciseId}/submissions (overview)
  const submissionsMatch = /^\/course\/([^/]+)\/exercise\/([^/]+)\/submissions$/.exec(path);
  if (submissionsMatch && method === 'GET') {
    const [, courseId, exerciseId] = submissionsMatch;
    return handleGetSubmissionsOverview(event, courseId, exerciseId);
  }

  // /{exerciseId}/notify/{jobId} — KNOWN GAP, see module doc (b)
  const notifyStatusMatch = /^\/course\/([^/]+)\/exercise\/([^/]+)\/notify\/([^/]+)$/.exec(path);
  if (notifyStatusMatch && method === 'GET') {
    return jsonResponse(404, { success: false, message: 'Not Found' });
  }

  // /{exerciseId}/notify — KNOWN GAP, see module doc (b)
  const notifyMatch = /^\/course\/([^/]+)\/exercise\/([^/]+)\/notify$/.exec(path);
  if (notifyMatch && method === 'POST') {
    return jsonResponse(404, { success: false, message: 'Not Found' });
  }

  // /{exerciseId}/submission/{submissionId}/question/{questionId}/video-recording/playback
  const playbackMatch =
    /^\/course\/([^/]+)\/exercise\/([^/]+)\/submission\/([^/]+)\/question\/([^/]+)\/video-recording\/playback$/.exec(
      path
    );
  if (playbackMatch && method === 'GET') {
    const [, courseId, exerciseId, submissionId, questionId] = playbackMatch;
    return handleVideoPlayback(event, courseId, exerciseId, submissionId, questionId);
  }

  // /{exerciseId}/question/{questionId}/video-recording/upload/init
  const uploadInitMatch =
    /^\/course\/([^/]+)\/exercise\/([^/]+)\/question\/([^/]+)\/video-recording\/upload\/init$/.exec(path);
  if (uploadInitMatch && method === 'POST') {
    const [, courseId, exerciseId, questionId] = uploadInitMatch;
    return handleVideoUploadInit(event, courseId, exerciseId, questionId);
  }

  // /{exerciseId}/question/{questionId}/video-recording/upload/complete
  const uploadCompleteMatch =
    /^\/course\/([^/]+)\/exercise\/([^/]+)\/question\/([^/]+)\/video-recording\/upload\/complete$/.exec(path);
  if (uploadCompleteMatch && method === 'POST') {
    const [, courseId, exerciseId, questionId] = uploadCompleteMatch;
    return handleVideoUploadComplete(event, courseId, exerciseId, questionId);
  }

  // /{exerciseId}/submission (create)
  const submissionMatch = /^\/course\/([^/]+)\/exercise\/([^/]+)\/submission$/.exec(path);
  if (submissionMatch && method === 'POST') {
    const [, courseId, exerciseId] = submissionMatch;
    return handleSubmitExercise(event, courseId, exerciseId);
  }

  // /{exerciseId} (get one / update / delete)
  const exerciseIdMatch = /^\/course\/([^/]+)\/exercise\/([^/]+)$/.exec(path);
  if (exerciseIdMatch) {
    const [, courseId, exerciseId] = exerciseIdMatch;
    if (method === 'GET') return handleGetExercise(event, courseId, exerciseId);
    if (method === 'PUT') return handleUpdateExercise(event, courseId, exerciseId);
    if (method === 'DELETE') return handleDeleteExercise(event, courseId, exerciseId);
  }

  // / (list / create)
  const rootMatch = /^\/course\/([^/]+)\/exercise$/.exec(path);
  if (rootMatch) {
    const [, courseId] = rootMatch;
    if (method === 'GET') return handleListExercises(event, courseId);
    if (method === 'POST') return handleCreateExercise(event, courseId);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
