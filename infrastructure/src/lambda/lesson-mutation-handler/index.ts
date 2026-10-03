/**
 * Lesson Mutation Handler Lambda
 *
 * Handles the lesson CRUD routes NOT covered by lesson-details (GET
 * /course/{courseId}/lesson/{lessonId}, an alias for GET /lesson/{id}) or
 * lesson-extended-handler (comment/completion/watch-progress/history/
 * language sub-routes):
 *
 * - GET    /course/{courseId}/lesson              (list, optional
 *          sectionId query filter)
 * - POST   /course/{courseId}/lesson               (create)
 * - PUT    /course/{courseId}/lesson/{lessonId}    (update)
 * - DELETE /course/{courseId}/lesson/{lessonId}    (delete)
 * - POST   /course/{courseId}/lesson/reorder        (reorder)
 *
 * Mirrors the "Lesson CRUD routes" section at the top of
 * apps/api/src/routes/course/lesson.ts (the `.get('/', ...)`,
 * `.post('/reorder', ...)`, `.post('/', ...)`, `.put('/:lessonId', ...)`,
 * `.delete('/:lessonId', ...)` handlers). Note that the real Hono
 * `GET /:lessonId` route (which enriches the lesson with
 * assertEnrolledStudentContentAccess + watchProgress) is intentionally NOT
 * duplicated here — it's already covered by lesson-details/its
 * `/course/{courseId}/lesson/{lessonId}` GET alias.
 *
 * ALL FIVE routes use `authMiddleware` + `courseMemberMiddleware` in the
 * real Hono router (no team-member-only writes in this group), so this
 * handler uses `requireCourseMember` uniformly for all five routes below.
 *
 * Reuses the real service-layer functions from
 * `@cio/core/services/lesson/lesson` (`createLesson`,
 * `updateLessonService`, `deleteLessonService`, `listLessons`,
 * `reorderLessons`) so behavior and error shapes stay identical to the
 * monolith. Validation reuses the real Zod schemas from
 * `@cio/utils/validation/lesson` (`ZLessonCreate`, `ZLessonUpdate`,
 * `ZLessonListQuery`, `ZLessonReorder`, `ZLessonGetParam`) via
 * `.safeParse()` rather than hand-rolling, since `ZLessonUpdate` in
 * particular has a fairly large shape (videos/documents arrays, url
 * fields, completion-policy enum) that would be easy to drift from if
 * reimplemented by hand.
 *
 * NOTE: while `createLesson`/`updateLessonService`/`deleteLessonService`/
 * `listLessons`/`reorderLessons` themselves never call `sanitizeHtml`,
 * they live in the same module (`@cio/core/services/lesson/lesson`) as the
 * comment services that do (`createLessonCommentService`/
 * `updateLessonCommentService`), which import `sanitizeHtml` from
 * `isomorphic-dompurify` at module scope. esbuild bundles the whole module
 * regardless of which exports are used, which pulls in jsdom. jsdom reads
 * its default stylesheet relative to its own `__dirname` at import time,
 * which esbuild's single-file bundle breaks (ENOENT
 * ".../default-stylesheet.css" on cold start — confirmed for this
 * handler). This Lambda therefore DOES need the same
 * `externalNodeModules: ['isomorphic-dompurify']` workaround used by
 * course-mutation-handler / lesson-extended-handler, even though it never
 * calls sanitizeHtml itself.
 *
 * KNOWN GAP (a): `POST /:lessonId/notify-session-update` — the real Hono
 * handler (`notifyCourseSessionUpdateService`, apps/api/src/services/
 * course/notify-session.ts) enqueues a BullMQ job via `@cio/jobs`'s
 * `enqueueNotifyCourseSessionUpdate`. BullMQ/Redis is local-dev-only
 * infrastructure (AWS uses SQS + email-worker + SES instead), and there is
 * no SQS queue provisioned for this specific job type. Not ported — the
 * dispatcher below returns a clean 404 for this sub-route rather than
 * crashing.
 *
 * KNOWN GAP (b): `POST /download/pdf` — the real Hono handler
 * (`generateLessonPdf`, apps/api/src/utils/lesson.ts) lives behind the
 * `@api/*` alias (unresolvable from a standalone Lambda bundle), and its
 * PDF-rendering logic is non-trivial to port. Not ported — the dispatcher
 * below returns a clean 404 for this sub-route rather than crashing.
 *
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/core + @cio/db + better-auth.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  createLesson,
  deleteLessonService,
  listLessons,
  reorderLessons,
  updateLessonService
} from '@cio/core/services/lesson/lesson';
import { AppError } from '@cio/utils/errors';
import {
  ZLessonCreate,
  ZLessonGetParam,
  ZLessonListQuery,
  ZLessonReorder,
  ZLessonUpdate
} from '@cio/utils/validation/lesson';
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

function errorResponse(error: unknown, fallbackMessage: string): APIGatewayProxyResultV2 {
  if (error instanceof AppError) {
    return jsonResponse(error.statusCode, { success: false, message: error.message });
  }

  return jsonResponse(500, { success: false, message: fallbackMessage });
}

/**
 * GET /course/{courseId}/lesson
 */
async function handleListLessons(event: APIGatewayProxyEventV2, courseId: string): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const queryValidation = ZLessonListQuery.safeParse({
    ...(event.queryStringParameters ?? {}),
    courseId
  });
  if (!queryValidation.success) {
    return jsonResponse(400, {
      success: false,
      message: 'Invalid query parameters',
      errors: queryValidation.error.issues
    });
  }

  try {
    const { sectionId } = queryValidation.data;
    const lessons = await listLessons(courseId, sectionId);
    return jsonResponse(200, { success: true, data: lessons });
  } catch (error) {
    console.error('[lesson-mutation-handler] listLessons error:', error);
    return errorResponse(error, 'Failed to list lessons');
  }
}

/**
 * POST /course/{courseId}/lesson
 */
async function handleCreateLesson(event: APIGatewayProxyEventV2, courseId: string): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZLessonCreate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const lesson = await createLesson(courseId, { ...validation.data, courseId });
    return jsonResponse(201, { success: true, data: lesson });
  } catch (error) {
    console.error('[lesson-mutation-handler] createLesson error:', error);
    return errorResponse(error, 'Failed to create lesson');
  }
}

/**
 * PUT /course/{courseId}/lesson/{lessonId}
 */
async function handleUpdateLesson(
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

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZLessonUpdate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const lesson = await updateLessonService(lessonId, validation.data);
    return jsonResponse(200, { success: true, data: lesson });
  } catch (error) {
    console.error('[lesson-mutation-handler] updateLessonService error:', error);
    return errorResponse(error, 'Failed to update lesson');
  }
}

/**
 * DELETE /course/{courseId}/lesson/{lessonId}
 */
async function handleDeleteLesson(
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

  try {
    const lesson = await deleteLessonService(lessonId);
    return jsonResponse(200, { success: true, data: lesson });
  } catch (error) {
    console.error('[lesson-mutation-handler] deleteLessonService error:', error);
    return errorResponse(error, 'Failed to delete lesson');
  }
}

/**
 * POST /course/{courseId}/lesson/reorder
 */
async function handleReorderLessons(event: APIGatewayProxyEventV2, courseId: string): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZLessonReorder.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const updated = await reorderLessons(validation.data.lessons);
    return jsonResponse(200, { success: true, data: updated });
  } catch (error) {
    console.error('[lesson-mutation-handler] reorderLessons error:', error);
    return errorResponse(error, 'Failed to reorder lessons');
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  // Most-specific literal suffixes are checked first so `reorder`,
  // `notify-session-update`, and `download/pdf` are never mistaken for a
  // `{lessonId}` path segment.

  // /reorder — literal suffix, checked before the {lessonId} route.
  const reorderMatch = /^\/course\/([^/]+)\/lesson\/reorder$/.exec(path);
  if (reorderMatch && method === 'POST') {
    return handleReorderLessons(event, reorderMatch[1]);
  }

  // KNOWN GAP (a): notify-session-update — not ported, clean 404.
  const notifySessionUpdateMatch = /^\/course\/([^/]+)\/lesson\/([^/]+)\/notify-session-update$/.exec(path);
  if (notifySessionUpdateMatch && method === 'POST') {
    return jsonResponse(404, { success: false, message: 'Not Found' });
  }

  // KNOWN GAP (b): download/pdf — not ported, clean 404.
  const downloadPdfMatch = /^\/course\/([^/]+)\/lesson\/download\/pdf$/.exec(path);
  if (downloadPdfMatch && method === 'POST') {
    return jsonResponse(404, { success: false, message: 'Not Found' });
  }

  // /course/{courseId}/lesson (list, create)
  const lessonBaseMatch = /^\/course\/([^/]+)\/lesson$/.exec(path);
  if (lessonBaseMatch) {
    const [, courseId] = lessonBaseMatch;
    if (method === 'GET') return handleListLessons(event, courseId);
    if (method === 'POST') return handleCreateLesson(event, courseId);
  }

  // /course/{courseId}/lesson/{lessonId} (update, delete)
  const lessonIdMatch = /^\/course\/([^/]+)\/lesson\/([^/]+)$/.exec(path);
  if (lessonIdMatch) {
    const [, courseId, lessonId] = lessonIdMatch;
    if (method === 'PUT') return handleUpdateLesson(event, courseId, lessonId);
    if (method === 'DELETE') return handleDeleteLesson(event, courseId, lessonId);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
