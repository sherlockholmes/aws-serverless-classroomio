/**
 * Lesson Extended Handler Lambda
 *
 * Handles the lesson sub-routes NOT covered by lesson-details (GET
 * /lesson/{id}), lesson-progress (POST /lesson/{id}/progress, a separate
 * hand-rolled mechanism), or video-url-generator (GET
 * /lesson/{id}/video-url):
 *
 * - GET    /course/{courseId}/lesson/{lessonId}/comment
 * - POST   /course/{courseId}/lesson/{lessonId}/comment
 * - PUT    /course/{courseId}/lesson/comment/{commentId}
 * - DELETE /course/{courseId}/lesson/comment/{commentId}
 * - GET    /course/{courseId}/lesson/{lessonId}/completion
 * - PUT    /course/{courseId}/lesson/{lessonId}/completion
 * - GET    /course/{courseId}/lesson/{lessonId}/watch-progress
 * - PUT    /course/{courseId}/lesson/{lessonId}/watch-progress
 * - GET    /course/{courseId}/lesson/{lessonId}/history
 * - GET    /course/{courseId}/lesson/{lessonId}/language
 * - GET    /course/{courseId}/lesson/{lessonId}/language/{locale}
 * - POST   /course/{courseId}/lesson/{lessonId}/language
 * - PUT    /course/{courseId}/lesson/{lessonId}/language/{locale}
 *
 * Mirrors apps/api/src/routes/course/lesson.ts's comment/completion/
 * watch-progress/history sub-routes plus
 * apps/api/src/routes/course/lesson-language.ts's `lessonLanguageRouter`.
 * Note the comment update/delete routes have no `:lessonId` segment in the
 * real Hono router (`.put('/comment/:commentId', ...)`,
 * `.delete('/comment/:commentId', ...)` mounted directly on the lesson
 * router, not under `/:lessonId`), so their AWS path is
 * `/course/{courseId}/lesson/comment/{commentId}` — no lessonId at all.
 *
 * Auth: every one of these routes uses `courseMemberMiddleware` in Hono (no
 * team-member-only writes in this group), so this handler uses
 * `requireCourseMember` uniformly for all 13 routes.
 *
 * Reuses the real service-layer functions from
 * `@cio/core/services/lesson/lesson` (comment/completion/watch-progress/
 * history) and `@cio/core/services/lesson-language` (language CRUD) so
 * response shapes stay identical to the monolith. Validation reuses the
 * real Zod schemas from `@cio/utils/validation/lesson` via `.safeParse()`
 * rather than hand-rolling, since several of them (ZLessonCommentsQuery,
 * ZLessonHistoryQuery, ZUpdateLessonWatchProgress) have non-trivial
 * `.coerce`/`.transform`/`.pipe` rules that are easy to drift from if
 * reimplemented by hand.
 *
 * externalNodeModules: the comment services (createLessonCommentService /
 * updateLessonCommentService) and the language services
 * (upsertLessonLanguageService / updateLessonLanguageService) both call
 * into `sanitizeHtml`/`sanitizeOptionalHtml`, which depend on
 * isomorphic-dompurify -> jsdom. jsdom reads its default stylesheet
 * relative to its own package location at import time, which esbuild's
 * single-file bundling breaks (ENOENT on cold start — confirmed for
 * course-mutation-handler). This Lambda needs the same
 * `externalNodeModules: ['isomorphic-dompurify']` workaround in
 * api-stack.ts.
 *
 * b64 envelope handling (REPLICATED, not a known gap): the dashboard's
 * fetch wrapper (`apps/dashboard/src/lib/utils/services/api/index.ts`'s
 * `requiresB64Envelope`) base64-wraps the JSON body and sets
 * `Content-Type: application/x-cio-agent` for any request whose *path*
 * matches `/lesson/[^/]+/language` — this check is purely path-based and
 * fires regardless of which backend (Render or this Lambda) serves the
 * request. The real Hono `lessonLanguageRouter` unwraps that envelope via
 * `b64EnvelopeRewrite` before `zValidator` runs. Skipping it here would
 * make every real POST/PUT `.../language[/…]` call from the dashboard fail
 * body validation (it would receive `{"b64":"..."}"` instead of
 * `{locale, content}`), so `parseJsonBody` below replicates the same
 * unwrap: if the request's content-type is `application/x-cio-agent`, it
 * base64-decodes the `b64` field before JSON-parsing the inner body.
 * (Render's Cloudflare WAF is the actual reason the envelope exists; AWS
 * API Gateway has no such WAF, but the client doesn't know which backend
 * it's talking to, so the unwrap still has to happen here.)
 *
 * `evaluateCourseCertification` is now implemented via the shared helper
 * `../_shared/course-certification.ts` and is called fire-and-forget after
 * a lesson is marked complete (PUT .../completion with isComplete=true) and
 * after watch-progress reports `didJustComplete`. This was previously a
 * KNOWN GAP; it is now resolved. The shared helper uses only
 * `@cio/db`/`@cio/core`/`@cio/utils`/`@cio/email` imports, all resolvable
 * from a standalone Lambda bundle. Requires EMAIL_QUEUE_URL env var and
 * SQS grantSendMessages permission (both added in api-stack.ts).
 *
 * The `assertEnrolledStudentContentAccess` check
 * (apps/api/src/services/course/access.ts) that gates PUT .../completion
 * and GET/PUT .../watch-progress IS ported here (see
 * `assertEnrolledStudentContentAccessLocal` below) — all of its actual
 * dependencies (`assertStudentCanAccessContent` from
 * `@cio/core/services/course/progression`, `getCourseById`/
 * `getCourseProgress` from `@cio/db/queries/course/course`,
 * `getCourseContentItems` from `@cio/db/queries/course/content`) are
 * importable from a standalone Lambda bundle, so this is a real business
 * rule (progression locking for students), not a documented cut corner.
 *
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/core + @cio/db + better-auth.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  createLessonCommentService,
  deleteLessonCommentService,
  getLessonCommentsPaginated,
  getLessonCompletionService,
  getLessonHistoryService,
  getLessonWatchProgressService,
  updateLessonCommentService,
  updateLessonWatchProgressService,
  upsertLessonCompletionService
} from '@cio/core/services/lesson/lesson';
import {
  getLessonLanguage,
  listLessonLanguages,
  updateLessonLanguageService,
  upsertLessonLanguageService
} from '@cio/core/services/lesson-language';
import { assertStudentCanAccessContent } from '@cio/core/services/course/progression';
import { getCourseById, getCourseContentItems, getCourseProgress } from '@cio/db/queries/course';
import { getGroupMemberIdByCourseAndProfile } from '@cio/db/queries/group';
import type { TLocale } from '@cio/db/types';
import { AppError, ErrorCodes } from '@cio/utils/errors';
import { CIO_ENVELOPE_CONTENT_TYPE, ContentType } from '@cio/utils/constants';
import {
  ZLessonCommentCreate,
  ZLessonCommentGetParam,
  ZLessonCommentUpdate,
  ZLessonCommentsQuery,
  ZLessonCompletionUpdate,
  ZLessonGetParam,
  ZLessonHistoryParam,
  ZLessonHistoryQuery,
  ZLessonLanguageCreate,
  ZLessonLanguageGetByLocaleParam,
  ZLessonLanguageGetParam,
  ZLessonLanguageUpdate,
  ZUpdateLessonWatchProgress
} from '@cio/utils/validation/lesson';
import { requireCourseMember } from '../_shared/course-membership';
import { evaluateCourseCertification } from '../_shared/course-certification';

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

  return jsonResponse(500, { success: false, message: fallbackMessage });
}

/**
 * Parses the request body, unwrapping the b64 envelope
 * (`Content-Type: application/x-cio-agent`) if present. See module doc.
 */
function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};

  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;

    const contentType = (event.headers?.['content-type'] || event.headers?.['Content-Type'] || '').toLowerCase();
    if (contentType.startsWith(CIO_ENVELOPE_CONTENT_TYPE)) {
      const envelope = JSON.parse(raw) as { b64?: string };
      const innerJson = typeof envelope.b64 === 'string' ? Buffer.from(envelope.b64, 'base64').toString('utf-8') : raw;
      return JSON.parse(innerJson);
    }

    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Reimplements apps/api/src/services/course/access.ts's
 * `assertEnrolledStudentContentAccess` using only `@cio/core`/`@cio/db`
 * imports (that file itself lives behind the `@api/*` alias and is not
 * resolvable from this standalone bundle — see module doc). Throws
 * `AppError` (404 content not found / 403 locked) exactly like the
 * original when a student attempts to access locked-by-progression
 * content; no-ops for non-students or missing courses, matching the
 * original's early returns.
 */
async function assertEnrolledStudentContentAccessLocal(params: {
  courseId: string;
  profileId: string;
  contentId: string;
  type: ContentType.Lesson;
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
// Comment routes
// ---------------------------------------------------------------------------

/**
 * GET /course/{courseId}/lesson/{lessonId}/comment
 */
async function handleGetComments(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZLessonGetParam.safeParse({ lessonId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid lessonId' });
  }

  const queryValidation = ZLessonCommentsQuery.safeParse(event.queryStringParameters ?? {});
  if (!queryValidation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid query parameters',
      errors: queryValidation.error.issues
    });
  }

  try {
    const { cursor, limit } = queryValidation.data;
    const result = await getLessonCommentsPaginated(lessonId, { cursor, limit });
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[lesson-extended-handler] getLessonCommentsPaginated error:', error);
    return errorResponse(error, 'Failed to get lesson comments');
  }
}

/**
 * POST /course/{courseId}/lesson/{lessonId}/comment
 */
async function handleCreateComment(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZLessonCommentCreate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const groupMemberId = await getGroupMemberIdByCourseAndProfile(courseId, member.userId);
    if (!groupMemberId) {
      // Exact parity with the Hono route's own response shape (`error`, not
      // `message`) — see module doc.
      return jsonResponse(403, { success: false, error: 'User is not a member of this course' });
    }

    const commentData = await createLessonCommentService(lessonId, groupMemberId, validation.data.comment);
    return jsonResponse(201, { success: true, data: commentData });
  } catch (error) {
    console.error('[lesson-extended-handler] createLessonCommentService error:', error);
    return errorResponse(error, 'Failed to create lesson comment');
  }
}

/**
 * PUT /course/{courseId}/lesson/comment/{commentId}
 */
async function handleUpdateComment(
  event: APIGatewayProxyEventV2,
  courseId: string,
  commentId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZLessonCommentGetParam.safeParse({ commentId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid commentId' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZLessonCommentUpdate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const updated = await updateLessonCommentService(Number(commentId), validation.data.comment);
    return jsonResponse(200, { success: true, data: updated });
  } catch (error) {
    console.error('[lesson-extended-handler] updateLessonCommentService error:', error);
    return errorResponse(error, 'Failed to update lesson comment');
  }
}

/**
 * DELETE /course/{courseId}/lesson/comment/{commentId}
 */
async function handleDeleteComment(
  event: APIGatewayProxyEventV2,
  courseId: string,
  commentId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZLessonCommentGetParam.safeParse({ commentId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid commentId' });
  }

  try {
    const comment = await deleteLessonCommentService(Number(commentId));
    return jsonResponse(200, { success: true, data: comment });
  } catch (error) {
    console.error('[lesson-extended-handler] deleteLessonCommentService error:', error);
    return errorResponse(error, 'Failed to delete lesson comment');
  }
}

// ---------------------------------------------------------------------------
// Completion routes
// ---------------------------------------------------------------------------

/**
 * GET /course/{courseId}/lesson/{lessonId}/completion
 */
async function handleGetCompletion(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const completion = await getLessonCompletionService(lessonId, member.userId);
    return jsonResponse(200, { success: true, data: completion });
  } catch (error) {
    console.error('[lesson-extended-handler] getLessonCompletionService error:', error);
    return errorResponse(error, 'Failed to get lesson completion');
  }
}

/**
 * PUT /course/{courseId}/lesson/{lessonId}/completion
 *
 * Fires evaluateCourseCertification fire-and-forget when isComplete is true.
 */
async function handleUpdateCompletion(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZLessonCompletionUpdate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    await assertEnrolledStudentContentAccessLocal({
      courseId,
      profileId: member.userId,
      contentId: lessonId,
      type: ContentType.Lesson
    });

    const completion = await upsertLessonCompletionService(lessonId, member.userId, validation.data.isComplete);

    if (validation.data.isComplete) {
      void evaluateCourseCertification(courseId, member.userId).catch((error) => {
        console.error('[lesson-extended-handler] certification evaluation failed:', error);
      });
    }

    return jsonResponse(200, { success: true, data: completion });
  } catch (error) {
    console.error('[lesson-extended-handler] upsertLessonCompletionService error:', error);
    return errorResponse(error, 'Failed to update lesson completion');
  }
}

// ---------------------------------------------------------------------------
// Watch-progress routes
// ---------------------------------------------------------------------------

/**
 * GET /course/{courseId}/lesson/{lessonId}/watch-progress
 */
async function handleGetWatchProgress(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    await assertEnrolledStudentContentAccessLocal({
      courseId,
      profileId: member.userId,
      contentId: lessonId,
      type: ContentType.Lesson
    });

    const watchProgress = await getLessonWatchProgressService(lessonId, member.userId);
    return jsonResponse(200, { success: true, data: watchProgress });
  } catch (error) {
    console.error('[lesson-extended-handler] getLessonWatchProgressService error:', error);
    return errorResponse(error, 'Failed to get lesson watch progress');
  }
}

/**
 * PUT /course/{courseId}/lesson/{lessonId}/watch-progress
 *
 * Fires evaluateCourseCertification fire-and-forget when watchProgress.didJustComplete is true.
 */
async function handleUpdateWatchProgress(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZUpdateLessonWatchProgress.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    await assertEnrolledStudentContentAccessLocal({
      courseId,
      profileId: member.userId,
      contentId: lessonId,
      type: ContentType.Lesson
    });

    const watchProgress = await updateLessonWatchProgressService(lessonId, member.userId, validation.data);

    if (watchProgress.didJustComplete) {
      void evaluateCourseCertification(courseId, member.userId).catch((error) => {
        console.error('[lesson-extended-handler] certification evaluation failed:', error);
      });
    }

    return jsonResponse(200, { success: true, data: watchProgress });
  } catch (error) {
    console.error('[lesson-extended-handler] updateLessonWatchProgressService error:', error);
    return errorResponse(error, 'Failed to update lesson watch progress');
  }
}

// ---------------------------------------------------------------------------
// History route
// ---------------------------------------------------------------------------

/**
 * GET /course/{courseId}/lesson/{lessonId}/history
 */
async function handleGetHistory(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZLessonHistoryParam.safeParse({ courseId, lessonId });
  if (!paramValidation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid courseId/lessonId' });
  }

  const queryValidation = ZLessonHistoryQuery.safeParse(event.queryStringParameters ?? {});
  if (!queryValidation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid query parameters',
      errors: queryValidation.error.issues
    });
  }

  try {
    const { locale, endRange } = queryValidation.data;
    const history = await getLessonHistoryService(lessonId, locale, endRange);
    return jsonResponse(200, { success: true, data: history });
  } catch (error) {
    console.error('[lesson-extended-handler] getLessonHistoryService error:', error);
    return errorResponse(error, 'Failed to fetch lesson history');
  }
}

// ---------------------------------------------------------------------------
// Language routes
// ---------------------------------------------------------------------------

/**
 * GET /course/{courseId}/lesson/{lessonId}/language
 */
async function handleListLanguages(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZLessonLanguageGetParam.safeParse({ courseId, lessonId });
  if (!paramValidation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid courseId/lessonId',
      errors: paramValidation.error.issues
    });
  }

  try {
    const languages = await listLessonLanguages(lessonId);
    return jsonResponse(200, { success: true, data: languages });
  } catch (error) {
    console.error('[lesson-extended-handler] listLessonLanguages error:', error);
    return errorResponse(error, 'Failed to fetch lesson languages');
  }
}

/**
 * GET /course/{courseId}/lesson/{lessonId}/language/{locale}
 */
async function handleGetLanguage(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string,
  locale: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZLessonLanguageGetByLocaleParam.safeParse({ courseId, lessonId, locale });
  if (!paramValidation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid path parameters',
      errors: paramValidation.error.issues
    });
  }

  try {
    const language = await getLessonLanguage(lessonId, paramValidation.data.locale as TLocale);
    if (!language) {
      // Exact parity with the Hono route's own response shape (`error`, not
      // `message`) — see module doc.
      return jsonResponse(404, { success: false, error: 'Lesson language not found' });
    }

    return jsonResponse(200, { success: true, data: language });
  } catch (error) {
    console.error('[lesson-extended-handler] getLessonLanguage error:', error);
    return errorResponse(error, 'Failed to fetch lesson language');
  }
}

/**
 * POST /course/{courseId}/lesson/{lessonId}/language
 */
async function handleCreateLanguage(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZLessonLanguageGetParam.safeParse({ courseId, lessonId });
  if (!paramValidation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid courseId/lessonId',
      errors: paramValidation.error.issues
    });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZLessonLanguageCreate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const language = await upsertLessonLanguageService(lessonId, validation.data);
    return jsonResponse(201, { success: true, data: language });
  } catch (error) {
    console.error('[lesson-extended-handler] upsertLessonLanguageService error:', error);
    return errorResponse(error, 'Failed to create or update lesson language');
  }
}

/**
 * PUT /course/{courseId}/lesson/{lessonId}/language/{locale}
 */
async function handleUpdateLanguage(
  event: APIGatewayProxyEventV2,
  courseId: string,
  lessonId: string,
  locale: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const paramValidation = ZLessonLanguageGetByLocaleParam.safeParse({ courseId, lessonId, locale });
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

  const validation = ZLessonLanguageUpdate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const language = await updateLessonLanguageService(
      lessonId,
      paramValidation.data.locale as TLocale,
      validation.data
    );
    return jsonResponse(200, { success: true, data: language });
  } catch (error) {
    console.error('[lesson-extended-handler] updateLessonLanguageService error:', error);
    return errorResponse(error, 'Failed to update lesson language');
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  // Most-specific literal suffixes are checked first so `comment`,
  // `completion`, `watch-progress`, `history`, and `language[/:locale]` are
  // never mistaken for a `:lessonId` path segment.

  // /comment/{commentId} — literal 'comment' segment, no lessonId at all.
  const commentIdMatch = /^\/course\/([^/]+)\/lesson\/comment\/([^/]+)$/.exec(path);
  if (commentIdMatch) {
    const [, courseId, commentId] = commentIdMatch;
    if (method === 'PUT') return handleUpdateComment(event, courseId, commentId);
    if (method === 'DELETE') return handleDeleteComment(event, courseId, commentId);
  }

  // /{lessonId}/comment
  const commentMatch = /^\/course\/([^/]+)\/lesson\/([^/]+)\/comment$/.exec(path);
  if (commentMatch) {
    const [, courseId, lessonId] = commentMatch;
    if (method === 'GET') return handleGetComments(event, courseId, lessonId);
    if (method === 'POST') return handleCreateComment(event, courseId, lessonId);
  }

  // /{lessonId}/completion
  const completionMatch = /^\/course\/([^/]+)\/lesson\/([^/]+)\/completion$/.exec(path);
  if (completionMatch) {
    const [, courseId, lessonId] = completionMatch;
    if (method === 'GET') return handleGetCompletion(event, courseId, lessonId);
    if (method === 'PUT') return handleUpdateCompletion(event, courseId, lessonId);
  }

  // /{lessonId}/watch-progress
  const watchProgressMatch = /^\/course\/([^/]+)\/lesson\/([^/]+)\/watch-progress$/.exec(path);
  if (watchProgressMatch) {
    const [, courseId, lessonId] = watchProgressMatch;
    if (method === 'GET') return handleGetWatchProgress(event, courseId, lessonId);
    if (method === 'PUT') return handleUpdateWatchProgress(event, courseId, lessonId);
  }

  // /{lessonId}/history
  const historyMatch = /^\/course\/([^/]+)\/lesson\/([^/]+)\/history$/.exec(path);
  if (historyMatch && method === 'GET') {
    const [, courseId, lessonId] = historyMatch;
    return handleGetHistory(event, courseId, lessonId);
  }

  // /{lessonId}/language/{locale} — checked before the bare /language route
  // so the locale segment is never mistaken for a missing suffix.
  const languageLocaleMatch = /^\/course\/([^/]+)\/lesson\/([^/]+)\/language\/([^/]+)$/.exec(path);
  if (languageLocaleMatch) {
    const [, courseId, lessonId, locale] = languageLocaleMatch;
    if (method === 'GET') return handleGetLanguage(event, courseId, lessonId, locale);
    if (method === 'PUT') return handleUpdateLanguage(event, courseId, lessonId, locale);
  }

  // /{lessonId}/language
  const languageMatch = /^\/course\/([^/]+)\/lesson\/([^/]+)\/language$/.exec(path);
  if (languageMatch) {
    const [, courseId, lessonId] = languageMatch;
    if (method === 'GET') return handleListLanguages(event, courseId, lessonId);
    if (method === 'POST') return handleCreateLanguage(event, courseId, lessonId);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
