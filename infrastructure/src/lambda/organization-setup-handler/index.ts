/**
 * Organization Setup Handler Lambda
 *
 * Handles:
 * - GET /organization/setup   (query: siteName — public, no auth)
 *
 * Mirrors apps/api/src/routes/organization/organization.ts's `.get('/setup', ...)`
 * handler (backed by apps/api/src/services/organization.ts's getOrgSetupData,
 * which itself is a Promise.all over getOrganizationBySiteName,
 * getCoursesBySiteNameForSetup, getLessonsBySiteName, and getExercisesBySiteName).
 *
 * Required by the dashboard: `apps/dashboard/src/lib/features/setup/api/setup-progress.svelte.ts`'s
 * `fetchSetupProgress` calls this route to drive the org onboarding checklist
 * (has a published course, has an avatar, has a lesson/exercise created, etc.)
 * shown right after an admin creates an organization.
 *
 * Reuses the real query-layer functions from @cio/db (not hand-rolled SQL or
 * a copy of apps/api's service) so the response shape stays in sync with the
 * monolith — same pattern as organization-handler / organization-courses-handler.
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in api-stack.ts)
 * so esbuild can resolve @cio/db.
 *
 * Auth: none — matches Hono, which registers no middleware on this route.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getOrganizationBySiteName } from '@cio/db/queries/organization';
import { getCoursesBySiteNameForSetup, getExercisesBySiteName, getLessonsBySiteName } from '@cio/db/queries/course';

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

/**
 * GET /organization/setup — no auth, mirrors getOrgSetupData(siteName).
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const query = event.queryStringParameters || {};
  const siteName = query.siteName;

  if (!siteName) {
    return jsonResponse(400, { success: false, message: 'siteName is required' });
  }

  try {
    const [organization, courses, lessons, exercises] = await Promise.all([
      getOrganizationBySiteName(siteName),
      getCoursesBySiteNameForSetup(siteName),
      getLessonsBySiteName(siteName),
      getExercisesBySiteName(siteName)
    ]);

    const publishedCourse = courses.find((course) => course.isPublished === true);
    const orgHasAvatarUrl = !!organization?.avatarUrl;

    return jsonResponse(200, {
      success: true,
      data: {
        isCoursePublished: !!publishedCourse,
        isCourseCreated: courses.length > 0,
        orgHasAvatarUrl,
        courseData: courses,
        lessonData: lessons,
        isLessonCreated: lessons.length > 0,
        isExerciseCreated: exercises.length > 0
      }
    });
  } catch (error) {
    console.error('[organization-setup-handler] getOrgSetupData error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch setup data' });
  }
}
