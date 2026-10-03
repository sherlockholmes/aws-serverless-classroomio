/**
 * Course Section Handler Lambda
 *
 * Handles course section CRUD:
 * - POST   /course/:courseId/section
 * - POST   /course/:courseId/section/promote-ungrouped
 * - PUT    /course/:courseId/section/:sectionId
 * - DELETE /course/:courseId/section/:sectionId
 * - POST   /course/:courseId/section/reorder
 *
 * Mirrors apps/api/src/routes/course/section.ts's `sectionRouter` exactly.
 * Note that ALL five routes in the Hono router use `courseMemberMiddleware`
 * (not the team-member middleware) — including the write operations — so
 * this handler uses `requireCourseMember` for every route below rather than
 * "upgrading" writes to team-member-only.
 *
 * Reuses the real service-layer functions from
 * `@cio/core/services/course/section` (`createCourseSection`,
 * `promoteUngroupedSection`, `updateCourseSectionService`,
 * `deleteCourseSectionService`, `reorderCourseSections`) so behavior and
 * error shapes stay identical to the monolith.
 *
 * Neither `@cio/core/services/course/section` nor the `@cio/db/queries`
 * modules it depends on import `sanitize-html`/`isomorphic-dompurify`
 * (confirmed by grep), so this handler does NOT need the
 * `externalNodeModules: ['isomorphic-dompurify']` workaround used by
 * course-mutation-handler / course-details.
 *
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/core + @cio/db + better-auth.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  createCourseSection,
  deleteCourseSectionService,
  promoteUngroupedSection,
  reorderCourseSections,
  updateCourseSectionService
} from '@cio/core/services/course/section';
import { AppError } from '@cio/utils/errors';
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
 * Mirrors ZCourseSectionCreate: title (non-empty string), order (optional
 * non-negative int). courseId is taken from the path, not the body, then
 * merged in — matching the Hono route's `createCourseSection(courseId, {
 * ...data, courseId })` call.
 */
function validateSectionCreate(
  body: unknown
): { success: true; data: { title: string; order?: number } } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { title, order } = body as Record<string, unknown>;

  if (typeof title !== 'string' || title.length < 1) {
    return { success: false, message: 'title must be a non-empty string' };
  }
  if (order !== undefined && (typeof order !== 'number' || !Number.isInteger(order) || order < 0)) {
    return { success: false, message: 'order must be a non-negative integer' };
  }

  return { success: true, data: order === undefined ? { title } : { title, order } };
}

/**
 * Mirrors ZCourseSectionUpdate: title and order both optional.
 */
function validateSectionUpdate(
  body: unknown
): { success: true; data: { title?: string; order?: number } } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { title, order } = body as Record<string, unknown>;
  const data: { title?: string; order?: number } = {};

  if (title !== undefined) {
    if (typeof title !== 'string' || title.length < 1) {
      return { success: false, message: 'title must be a non-empty string' };
    }
    data.title = title;
  }

  if (order !== undefined) {
    if (typeof order !== 'number' || !Number.isInteger(order) || order < 0) {
      return { success: false, message: 'order must be a non-negative integer' };
    }
    data.order = order;
  }

  return { success: true, data };
}

/**
 * Mirrors ZCourseSectionPromoteUngrouped: title (non-empty string).
 */
function validatePromoteUngrouped(
  body: unknown
): { success: true; data: { title: string } } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { title } = body as Record<string, unknown>;

  if (typeof title !== 'string' || title.length < 1) {
    return { success: false, message: 'title must be a non-empty string' };
  }

  return { success: true, data: { title } };
}

/**
 * Mirrors ZCourseSectionReorder: sections is a non-empty array of
 * { id: string, order: non-negative int }.
 */
function validateSectionReorder(
  body: unknown
): { success: true; data: { sections: { id: string; order: number }[] } } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { sections } = body as Record<string, unknown>;

  if (!Array.isArray(sections) || sections.length < 1) {
    return { success: false, message: 'sections must be a non-empty array' };
  }

  const parsed: { id: string; order: number }[] = [];
  for (const entry of sections) {
    if (typeof entry !== 'object' || entry === null) {
      return { success: false, message: 'Each section entry must be an object' };
    }

    const { id, order } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id.length < 1) {
      return { success: false, message: 'Each section entry requires a non-empty id' };
    }
    if (typeof order !== 'number' || !Number.isInteger(order) || order < 0) {
      return { success: false, message: 'Each section entry requires a non-negative integer order' };
    }

    parsed.push({ id, order });
  }

  return { success: true, data: { sections: parsed } };
}

/**
 * POST /course/:courseId/section
 */
async function handleCreateSection(event: APIGatewayProxyEventV2, courseId: string): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateSectionCreate(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const section = await createCourseSection(courseId, { ...validation.data, courseId });
    return jsonResponse(201, { success: true, data: section });
  } catch (error) {
    console.error('[course-section-handler] createCourseSection error:', error);
    return errorResponse(error, 'Failed to create course section');
  }
}

/**
 * POST /course/:courseId/section/promote-ungrouped
 */
async function handlePromoteUngrouped(
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

  const validation = validatePromoteUngrouped(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const result = await promoteUngroupedSection(courseId, validation.data);
    return jsonResponse(201, { success: true, data: result });
  } catch (error) {
    console.error('[course-section-handler] promoteUngroupedSection error:', error);
    return errorResponse(error, 'Failed to promote ungrouped section');
  }
}

/**
 * PUT /course/:courseId/section/:sectionId
 */
async function handleUpdateSection(
  event: APIGatewayProxyEventV2,
  courseId: string,
  sectionId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateSectionUpdate(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const section = await updateCourseSectionService(sectionId, validation.data);
    return jsonResponse(200, { success: true, data: section });
  } catch (error) {
    console.error('[course-section-handler] updateCourseSectionService error:', error);
    return errorResponse(error, 'Failed to update course section');
  }
}

/**
 * DELETE /course/:courseId/section/:sectionId
 */
async function handleDeleteSection(
  event: APIGatewayProxyEventV2,
  courseId: string,
  sectionId: string
): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const section = await deleteCourseSectionService(sectionId);
    return jsonResponse(200, { success: true, data: section });
  } catch (error) {
    console.error('[course-section-handler] deleteCourseSectionService error:', error);
    return errorResponse(error, 'Failed to delete course section');
  }
}

/**
 * POST /course/:courseId/section/reorder
 */
async function handleReorderSections(
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

  const validation = validateSectionReorder(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const updated = await reorderCourseSections(validation.data.sections);
    return jsonResponse(200, { success: true, data: updated });
  } catch (error) {
    console.error('[course-section-handler] reorderCourseSections error:', error);
    return errorResponse(error, 'Failed to reorder course sections');
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  // Most-specific literal suffixes are checked first so `promote-ungrouped`
  // and `reorder` are never mistaken for a `:sectionId` path segment.
  const promoteUngroupedMatch = /^\/course\/([^/]+)\/section\/promote-ungrouped$/.exec(path);
  if (promoteUngroupedMatch && method === 'POST') {
    return handlePromoteUngrouped(event, promoteUngroupedMatch[1]);
  }

  const reorderMatch = /^\/course\/([^/]+)\/section\/reorder$/.exec(path);
  if (reorderMatch && method === 'POST') {
    return handleReorderSections(event, reorderMatch[1]);
  }

  const sectionBaseMatch = /^\/course\/([^/]+)\/section$/.exec(path);
  if (sectionBaseMatch && method === 'POST') {
    return handleCreateSection(event, sectionBaseMatch[1]);
  }

  const sectionIdMatch = /^\/course\/([^/]+)\/section\/([^/]+)$/.exec(path);
  if (sectionIdMatch) {
    const [, courseId, sectionId] = sectionIdMatch;
    if (method === 'PUT') return handleUpdateSection(event, courseId, sectionId);
    if (method === 'DELETE') return handleDeleteSection(event, courseId, sectionId);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
