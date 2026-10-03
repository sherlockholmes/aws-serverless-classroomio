/**
 * Organization Courses Handler Lambda
 *
 * Handles:
 * - GET /organization/courses/public       (no auth — public landing/explore page)
 * - GET /organization/courses/enrolled     (auth + org membership — LMS "my courses")
 * - GET /organization/courses/recommended  (auth + org membership — LMS "explore" page)
 * - GET /organization/courses              (auth + org membership, ADMIN/TUTOR only — instructor dashboard)
 *
 * Mirrors apps/api/src/routes/organization/organization.ts's four `/courses*`
 * handlers (backed by apps/api/src/services/organization.ts's getPublicCourses,
 * getUserEnrolledCourses, getRecommendedCourses, getOrganizationCourses).
 * Required by the dashboard: `apps/dashboard/src/lib/features/{org/api/org.svelte.ts,
 * course/api/courses.svelte.ts}` call these four routes to populate the
 * public course catalog, the student's enrolled-courses list, the "explore"
 * recommendations, and the instructor's course-management list. Without
 * these routes student post-login navigation (the LMS home + explore pages)
 * has nothing to render.
 *
 * Reuses the real query-layer functions from @cio/db + @cio/utils (not
 * hand-rolled SQL or a copy of apps/api's service) so response shapes stay
 * in sync with the monolith — same pattern as organization-handler /
 * account-handler. Bundled from the monorepo root (bundleFromMonorepoRoot:
 * true in api-stack.ts) so esbuild can resolve @cio/db + better-auth.
 *
 * Role check for /organization/courses replicates orgMemberMiddleware +
 * the monolith's inline ADMIN/TUTOR switch: orgRoles ({ [orgId]: roleId })
 * comes from the Better Auth customSession plugin (packages/db/src/auth.ts),
 * i.e. it's already embedded in the session response — no extra DB query.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getOrgIdBySiteName } from '@cio/db/queries/organization';
import {
  countPublishedCoursesBySiteName,
  getEnrolledCourses,
  getExploreCourses,
  getOrgCourses,
  getPublishedCoursesBySiteName
} from '@cio/db/queries/course';
import { getCourseIdsByTagSlugs, getCourseTagsByCourseIdsForOrganization } from '@cio/db/queries/tag';
import { ROLE } from '@cio/utils/constants';
import { requireOrgMember } from '../_shared/org-membership';

const PUBLIC_ORG_LANDING_PAGE_COURSE_LIMIT = 4;
const ORG_COURSES_PAGE_SIZE = 6;

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function splitParam(param: string | undefined): string[] | undefined {
  return param
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * GET /organization/courses/public — no auth, published courses only.
 */
async function handleGetPublic(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const query = event.queryStringParameters || {};
  const siteName = query.siteName;

  if (!siteName) {
    return jsonResponse(400, { success: false, message: 'siteName is required' });
  }

  try {
    const [org] = await getOrgIdBySiteName(siteName);
    if (!org) {
      return jsonResponse(404, { success: false, message: 'Organization not found' });
    }

    const tagSlugs = splitParam(query.tags);
    const courseTypes = splitParam(query.types);
    const search = query.search?.trim() || undefined;
    const pricing = query.pricing === 'free' || query.pricing === 'paid' ? query.pricing : undefined;
    const pageParam = query.page !== undefined ? Number(query.page) : undefined;
    const limitParam = query.limit !== undefined ? Number(query.limit) : undefined;
    const isPaginated = pageParam !== undefined || limitParam !== undefined;

    const limit = isPaginated ? (limitParam ?? ORG_COURSES_PAGE_SIZE) : PUBLIC_ORG_LANDING_PAGE_COURSE_LIMIT;
    const page = isPaginated ? (pageParam ?? 1) : 1;
    const offset = (page - 1) * limit;

    let filteredCourseIds: string[] | undefined;
    if (tagSlugs && tagSlugs.length > 0) {
      filteredCourseIds = await getCourseIdsByTagSlugs(org.id, tagSlugs);
      if (filteredCourseIds.length === 0) {
        return jsonResponse(200, {
          success: true,
          data: { courses: [], hasMoreCourses: false, total: 0, page, limit, totalPages: 0 }
        });
      }
    }

    const [total, courses] = await Promise.all([
      countPublishedCoursesBySiteName(siteName, filteredCourseIds, courseTypes, search, pricing),
      getPublishedCoursesBySiteName(siteName, filteredCourseIds, courseTypes, search, pricing, limit, offset)
    ]);
    const tagsByCourseId = await getCourseTagsByCourseIdsForOrganization(
      org.id,
      courses.map((course) => course.id)
    );

    return jsonResponse(200, {
      success: true,
      data: {
        courses: courses.map((course) => ({ ...course, tags: tagsByCourseId[course.id] ?? [] })),
        hasMoreCourses: offset + courses.length < total,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('[organization-courses-handler] getPublic error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch public courses' });
  }
}

/**
 * GET /organization/courses/enrolled — auth + org membership required.
 */
async function handleGetEnrolled(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const data = await getEnrolledCourses({ orgId: member.orgId, profileId: member.userId });
    return jsonResponse(200, { success: true, data });
  } catch (error) {
    console.error('[organization-courses-handler] getEnrolled error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch courses' });
  }
}

/**
 * GET /organization/courses/recommended — auth + org membership required.
 */
async function handleGetRecommended(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const query = event.queryStringParameters || {};
  const limitParam = query.limit !== undefined ? Number(query.limit) : undefined;
  const limit = limitParam !== undefined && Number.isFinite(limitParam) ? limitParam : undefined;
  const pageParam = query.page !== undefined ? Number(query.page) : undefined;
  const page = pageParam !== undefined && Number.isFinite(pageParam) ? pageParam : 1;

  try {
    const { data, total } = await getExploreCourses({ orgId: member.orgId, profileId: member.userId, limit, page });

    const resolvedLimit = limit ?? total;
    const totalPages = resolvedLimit > 0 ? Math.ceil(total / resolvedLimit) : 1;

    return jsonResponse(200, {
      success: true,
      data,
      pagination: { page, limit: resolvedLimit, total, totalPages }
    });
  } catch (error) {
    console.error('[organization-courses-handler] getRecommended error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch recommended courses' });
  }
}

/**
 * GET /organization/courses — auth + org membership, ADMIN/TUTOR only
 * (instructor course-management dashboard).
 */
async function handleGetOrgCourses(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgMember(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  if (member.roleId !== ROLE.ADMIN && member.roleId !== ROLE.TUTOR) {
    return jsonResponse(403, { success: false, message: 'Invalid permissions' });
  }

  const query = event.queryStringParameters || {};
  const page = query.page !== undefined ? Math.max(1, Number(query.page) || 1) : 1;
  const limit = query.limit !== undefined ? Math.min(100, Math.max(1, Number(query.limit) || 20)) : 20;
  const search = query.search?.trim() || undefined;
  const tags = query.tags;
  const tagSlugs = splitParam(tags);

  try {
    let filteredCourseIds: string[] | undefined;
    if (tagSlugs && tagSlugs.length > 0) {
      filteredCourseIds = await getCourseIdsByTagSlugs(member.orgId, tagSlugs);
      if (filteredCourseIds.length === 0) {
        return jsonResponse(200, {
          success: true,
          data: [],
          pagination: { page, limit, total: 0, totalPages: 0 },
          query: { page, limit, search, tags }
        });
      }
    }

    // ADMIN sees all org courses; TUTOR sees only courses they're a member of
    // (profileId filter), matching apps/api/src/services/organization.ts's
    // getOrganizationCourses switch.
    const courses =
      member.roleId === ROLE.ADMIN
        ? await getOrgCourses({ orgId: member.orgId, courseIds: filteredCourseIds, page, limit, search })
        : await getOrgCourses({
            orgId: member.orgId,
            profileId: member.userId,
            courseIds: filteredCourseIds,
            page,
            limit,
            search
          });

    const tagsByCourseId = await getCourseTagsByCourseIdsForOrganization(
      member.orgId,
      courses.items.map((course) => course.id)
    );

    return jsonResponse(200, {
      success: true,
      data: courses.items.map((course) => ({ ...course, tags: tagsByCourseId[course.id] ?? [] })),
      pagination: {
        page: courses.page,
        limit: courses.limit,
        total: courses.total,
        totalPages: courses.totalPages
      },
      query: { page, limit, search, tags }
    });
  } catch (error) {
    console.error('[organization-courses-handler] getOrgCourses error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to fetch courses' });
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';

  if (path.endsWith('/courses/public')) {
    return handleGetPublic(event);
  }

  if (path.endsWith('/courses/enrolled')) {
    return handleGetEnrolled(event);
  }

  if (path.endsWith('/courses/recommended')) {
    return handleGetRecommended(event);
  }

  return handleGetOrgCourses(event);
}
