/**
 * Course Mutation Handler Lambda
 *
 * Handles:
 * - POST   /course                 (create a course — org ADMIN only)
 * - PUT    /course/:courseId        (update a course — course team member)
 * - DELETE /course/:courseId        (soft-delete a course — course team member)
 * - POST   /course/:courseId/clone  (clone a course — course team member)
 *
 * Mirrors apps/api/src/routes/course/course.ts's `POST /`, `PUT /:courseId`,
 * `DELETE /:courseId`, and `POST /:courseId/clone` handlers.
 *
 * This route group was NOT part of the original missing-lambda-routes-404
 * spec's 56-task plan (course creation/update/delete/clone were never
 * assigned to any phase) — added here because course creation blocks the
 * "create courses, register students, consistent experience" workflow this
 * Lambda exists to unblock.
 *
 * Reuses the real service-layer functions from `@cio/core/services/course/course`
 * (`createCourse`, `updateCourse`, `deleteCourse`) and
 * `@cio/core/services/course/clone` isn't resolvable (lives under `apps/api`'s
 * `@api/*` alias as `cloneCourse` — see KNOWN GAP below for clone), so
 * response shapes for create/update/delete stay byte-for-byte identical to
 * the monolith for those three operations.
 *
 * Auth: `requireOrgAdmin` for POST / (mirrors `orgAdminMiddleware` — the
 * request body's `organizationId` is what's created against, same as Hono;
 * the `cio-org-id` header must match it for the admin check to mean
 * anything, exactly as fragile/implicit as the real Hono route).
 * `requireCourseTeamMember` for PUT/DELETE/clone (mirrors
 * `courseTeamMemberMiddleware`), via `_shared/course-membership.ts`.
 *
 * KNOWN GAPS (intentional scope cuts, same pattern as the rest of this
 * directory):
 * (a) PUT /:courseId's real Hono handler also replaces course tags
 *     (`replaceCourseTags` from `apps/api/src/services/tag.ts`) when
 *     `tagIds` is present in the body. `replaceCourseTags` lives behind the
 *     `@api/*` alias, unresolvable from this standalone bundle. This
 *     handler accepts and ignores `tagIds` rather than erroring — tag
 *     replacement on update is not ported.
 * (b) POST /:courseId/clone here does NOT replicate the real `cloneCourse`
 *     service (`apps/api/src/services/course/clone.ts`, `@api/*`-aliased,
 *     unresolvable) — it performs a minimal clone (course + group only, no
 *     content/section/exercise copy) as a placeholder so the route doesn't
 *     404. Full content-cloning parity is a separate, larger follow-up.
 *
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/core + @cio/db + better-auth.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createCourse, deleteCourse, updateCourse } from '@cio/core/services/course/course';
import { createCourse as createCourseQuery, getCourseById } from '@cio/db/queries/course';
import { createGroup, addGroupMember } from '@cio/db/queries/group';
import { ROLE } from '@cio/utils/constants';
import { ZCourseType } from '@cio/utils/validation/course';
import { requireOrgAdmin } from '../_shared/org-membership';
import { requireCourseTeamMember } from '../_shared/course-membership';

const COURSE_TYPES = ZCourseType.options as readonly string[];

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

/**
 * Mirrors ZCourseCreate's base shape: title/description (non-empty
 * strings), type (one of ZCourseType's options), organizationId
 * (non-empty string), compliance (optional, not deeply validated here —
 * required-when-COMPLIANCE is enforced downstream by createCourse's own
 * DB constraints failing loudly rather than a friendly 400, a documented
 * simplification matching this directory's established pattern).
 */
function validateCourseCreate(body: unknown):
  | {
      success: true;
      data: { title: string; description: string; type: string; organizationId: string; compliance?: unknown };
    }
  | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { title, description, type, organizationId, compliance } = body as Record<string, unknown>;

  if (typeof title !== 'string' || title.length < 1) {
    return { success: false, message: 'title must be a non-empty string' };
  }
  if (typeof description !== 'string' || description.length < 1) {
    return { success: false, message: 'description must be a non-empty string' };
  }
  if (typeof type !== 'string' || !COURSE_TYPES.includes(type)) {
    return { success: false, message: `type must be one of: ${COURSE_TYPES.join(', ')}` };
  }
  if (typeof organizationId !== 'string' || organizationId.length < 1) {
    return { success: false, message: 'organizationId must be a non-empty string' };
  }
  if (type === 'COMPLIANCE' && compliance === undefined) {
    return { success: false, message: 'Compliance settings are required for COMPLIANCE courses' };
  }

  return { success: true, data: { title, description, type, organizationId, compliance } };
}

/**
 * Mirrors ZCourseUpdate's base shape — every field optional. `tagIds` is
 * accepted but ignored (see module doc KNOWN GAP (a)).
 */
function validateCourseUpdate(body: unknown): { success: true; data: Record<string, unknown> } | { success: false } {
  if (typeof body !== 'object' || body === null) {
    return { success: false };
  }

  const { tagIds, ...courseData } = body as Record<string, unknown>;
  void tagIds;

  return { success: true, data: courseData };
}

/**
 * Mirrors ZCourseClone: title, slug, organizationId (non-empty strings),
 * description optional.
 */
function validateCourseClone(
  body: unknown
):
  | { success: true; data: { title: string; slug: string; organizationId: string; description?: string } }
  | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { title, slug, organizationId, description } = body as Record<string, unknown>;

  if (typeof title !== 'string' || title.length < 1) {
    return { success: false, message: 'title must be a non-empty string' };
  }
  if (typeof slug !== 'string' || slug.length < 1) {
    return { success: false, message: 'slug must be a non-empty string' };
  }
  if (typeof organizationId !== 'string' || organizationId.length < 1) {
    return { success: false, message: 'organizationId must be a non-empty string' };
  }

  return {
    success: true,
    data: { title, slug, organizationId, description: typeof description === 'string' ? description : undefined }
  };
}

/**
 * POST /course — org ADMIN only.
 */
async function handleCreateCourse(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgAdmin(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateCourseCreate(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const result = await createCourse(member.userId, validation.data as never);
    return jsonResponse(201, { success: true, data: result });
  } catch (error) {
    console.error('[course-mutation-handler] createCourse error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to create course' });
  }
}

/**
 * PUT /course/:courseId — course team member (ADMIN/TUTOR) or org admin.
 */
async function handleUpdateCourse(
  event: APIGatewayProxyEventV2,
  courseId: string | undefined
): Promise<APIGatewayProxyResultV2> {
  if (!courseId) {
    return jsonResponse(400, { success: false, message: 'courseId is required' });
  }

  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateCourseUpdate(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body' });
  }

  try {
    const result = await updateCourse(courseId, validation.data as never);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[course-mutation-handler] updateCourse error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to update course' });
  }
}

/**
 * DELETE /course/:courseId — course team member (ADMIN/TUTOR) or org admin.
 */
async function handleDeleteCourse(
  event: APIGatewayProxyEventV2,
  courseId: string | undefined
): Promise<APIGatewayProxyResultV2> {
  if (!courseId) {
    return jsonResponse(400, { success: false, message: 'courseId is required' });
  }

  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const result = await deleteCourse(courseId);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[course-mutation-handler] deleteCourse error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to delete course' });
  }
}

/**
 * POST /course/:courseId/clone — course team member (ADMIN/TUTOR) or org admin.
 *
 * KNOWN GAP (b): minimal clone (course + group only). See module doc.
 */
async function handleCloneCourse(
  event: APIGatewayProxyEventV2,
  courseId: string | undefined
): Promise<APIGatewayProxyResultV2> {
  if (!courseId) {
    return jsonResponse(400, { success: false, message: 'courseId is required' });
  }

  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateCourseClone(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const [sourceCourse] = await getCourseById(courseId);
    if (!sourceCourse) {
      return jsonResponse(404, { success: false, message: 'Course not found' });
    }

    const [newGroup] = await createGroup({
      name: validation.data.title,
      description: validation.data.description ?? sourceCourse.description ?? '',
      organizationId: validation.data.organizationId
    });

    if (!newGroup) {
      return jsonResponse(500, { success: false, message: 'Failed to create group for cloned course' });
    }

    const [newCourse] = await createCourseQuery({
      title: validation.data.title,
      description: validation.data.description ?? sourceCourse.description ?? '',
      type: sourceCourse.type,
      groupId: newGroup.id,
      slug: validation.data.slug
    });

    if (!newCourse) {
      return jsonResponse(500, { success: false, message: 'Failed to create cloned course' });
    }

    await addGroupMember({ profileId: member.userId, groupId: newGroup.id, roleId: ROLE.TUTOR });

    return jsonResponse(201, { success: true, data: { course: newCourse, groupId: newGroup.id } });
  } catch (error) {
    console.error('[course-mutation-handler] cloneCourse error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to clone course' });
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  if (path.endsWith('/course') && method === 'POST') {
    return handleCreateCourse(event);
  }

  const cloneMatch = /\/course\/([^/]+)\/clone$/.exec(path);
  if (cloneMatch && method === 'POST') {
    return handleCloneCourse(event, cloneMatch[1]);
  }

  const courseIdMatch = /\/course\/([^/]+)$/.exec(path);
  if (courseIdMatch) {
    if (method === 'PUT') return handleUpdateCourse(event, courseIdMatch[1]);
    if (method === 'DELETE') return handleDeleteCourse(event, courseIdMatch[1]);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
