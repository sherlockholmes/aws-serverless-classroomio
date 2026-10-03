/**
 * Course Content Handler Lambda
 *
 * Handles course content bulk operations:
 * - PUT    /course/:courseId/content/reorder
 * - PUT    /course/:courseId/content
 * - DELETE /course/:courseId/content
 *
 * Mirrors apps/api/src/routes/course/content.ts's `contentRouter`, with one
 * documented gap:
 *
 * KNOWN GAP: `PUT /content/reorder`'s real Hono handler accepts EITHER a
 * Better Auth session (`authOrAutomationKeyMiddleware` +
 * `courseTeamMemberOrAutomationKeyMiddleware`) OR an MCP/automation API key,
 * and records MCP usage via `assertMcpAutomationUsageAllowed` /
 * `recordMcpAutomationUsage`. Automation-key auth is infrastructure that
 * lives under `@api/*` (organization automation-usage service) and has not
 * been ported to any Lambda in this migration (same documented pattern as
 * course-mutation-handler's tag-replacement/clone gaps and other handlers
 * in this directory). This handler only supports the session-based branch
 * via `requireCourseTeamMember` for all three routes below — MCP
 * automation-key callers of `/content/reorder` are not yet supported from
 * AWS.
 *
 * The `/content/reorder` and `/content` (update) and `/content` (delete)
 * validation constraints involve non-trivial `superRefine` rules (at least
 * one of sections/items; unique IDs; sectionId XOR items), so this handler
 * imports and reuses the real Zod schemas (`ZCourseContentReorder`,
 * `ZCourseContentUpdate`, `ZCourseContentDelete`) via `.safeParse()` rather
 * than hand-rolling the refinement logic, to avoid duplicating/drifting
 * from those rules.
 *
 * Reuses the real service-layer functions from
 * `@cio/core/services/course/content` (`updateCourseContent`,
 * `reorderCourseContent`, `deleteCourseContent`). Neither that module nor
 * the `@cio/db/queries` modules it depends on import
 * `sanitize-html`/`isomorphic-dompurify` (confirmed by grep), so this
 * handler does NOT need the `externalNodeModules: ['isomorphic-dompurify']`
 * workaround used by course-mutation-handler / course-details.
 *
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/core + @cio/db + better-auth.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { deleteCourseContent, reorderCourseContent, updateCourseContent } from '@cio/core/services/course/content';
import { ZCourseContentDelete, ZCourseContentReorder, ZCourseContentUpdate } from '@cio/utils/validation/course';
import { AppError } from '@cio/utils/errors';
import { requireCourseTeamMember } from '../_shared/course-membership';

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
 * PUT /course/:courseId/content/reorder
 */
async function handleReorderContent(event: APIGatewayProxyEventV2, courseId: string): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZCourseContentReorder.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    const result = await reorderCourseContent(courseId, validation.data);
    return jsonResponse(200, { success: true, data: result });
  } catch (error) {
    console.error('[course-content-handler] reorderCourseContent error:', error);
    return errorResponse(error, 'Failed to reorder course content');
  }
}

/**
 * PUT /course/:courseId/content
 */
async function handleUpdateContent(event: APIGatewayProxyEventV2, courseId: string): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZCourseContentUpdate.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    await updateCourseContent(courseId, validation.data.items);
    return jsonResponse(200, { success: true });
  } catch (error) {
    console.error('[course-content-handler] updateCourseContent error:', error);
    return errorResponse(error, 'Failed to update course content');
  }
}

/**
 * DELETE /course/:courseId/content
 */
async function handleDeleteContent(event: APIGatewayProxyEventV2, courseId: string): Promise<APIGatewayProxyResultV2> {
  const member = await requireCourseTeamMember(event, courseId);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = ZCourseContentDelete.safeParse(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
  }

  try {
    await deleteCourseContent(courseId, validation.data);
    return jsonResponse(200, { success: true });
  } catch (error) {
    console.error('[course-content-handler] deleteCourseContent error:', error);
    return errorResponse(error, 'Failed to delete course content');
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  const reorderMatch = /^\/course\/([^/]+)\/content\/reorder$/.exec(path);
  if (reorderMatch && method === 'PUT') {
    return handleReorderContent(event, reorderMatch[1]);
  }

  const contentBaseMatch = /^\/course\/([^/]+)\/content$/.exec(path);
  if (contentBaseMatch) {
    if (method === 'PUT') return handleUpdateContent(event, contentBaseMatch[1]);
    if (method === 'DELETE') return handleDeleteContent(event, contentBaseMatch[1]);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
