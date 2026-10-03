/**
 * Course Details Lambda Function
 *
 * Handles GET /course/{id}.
 *
 * Originally implemented with hand-rolled SQL that omitted the `group`
 * relation (members/tutors/students) the monolith always returns. The
 * dashboard's course store (`courseApi.setCourse`) only marks a course
 * "ready" once `group.id` is populated — every /courses/[id] page got
 * stuck on "Loading course…" forever because `group` was always undefined.
 *
 * Rewritten to replicate `@cio/core/services/course/course.ts`'s `getCourse`
 * (used by apps/api/src/routes/course/course.ts's `.get('/:courseId', ...)`)
 * — composing `getCourseWithRelations` (group + members + org),
 * progression-annotated content, and the student-limit flag — instead of
 * importing `getCourse` itself. `getCourse` lives in course.ts alongside
 * create/update helpers that pull in `isomorphic-dompurify` (HTML
 * sanitization for course descriptions), which depends on jsdom reading a
 * stylesheet file (`default-stylesheet.css`) relative to its own package
 * location at import time. esbuild's single-file bundling breaks that path
 * resolution ("ENOENT: no such file or directory, open
 * '/browser/default-stylesheet.css'" — confirmed via CloudWatch), crashing
 * the Lambda on cold start before any request-handling code runs. This
 * route only *reads* a course, so it never needed that dependency — the
 * fix is avoiding the import, not deleting the sanitizer.
 *
 * Auth: mirrors courseMemberMiddleware's direct-membership check — requires
 * a valid Better Auth session AND course membership (course-group
 * membership or org admin), via @cio/db/queries/group's
 * isUserCourseMemberOrOrgAdmin.
 *
 * Known gap vs. the monolith: courseMemberMiddleware also falls back to
 * `ensureProgramCourseAccess` (auto-enrolls a user who reaches a course
 * through a *program* membership rather than direct course/group
 * membership). That helper lives in the same course.ts module as
 * getCourse/createCourse/updateCourse, which import isomorphic-dompurify
 * for HTML sanitization — DOMPurify's jsdom dependency reads a stylesheet
 * file relative to its own package location at import time, which esbuild's
 * single-file bundling breaks ("ENOENT: .../default-stylesheet.css",
 * confirmed via CloudWatch), crashing the Lambda on cold start. Reimplementing
 * ensureProgramCourseAccess's transaction + org-stats-cache invalidation here
 * was out of scope for this fix; direct course/group members and org admins
 * (the common case) work. Revisit if program-based course access needs to
 * work from this Lambda.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getCourseWithRelations } from '@cio/db/queries/course';
import { isUserCourseMemberOrOrgAdmin } from '@cio/db/queries/group';
import { getActiveOrganizationPlan, countActiveStudents } from '@cio/db/queries/organization';
import { getStudentLimit } from '@cio/utils/plans';
import { AppError } from '@cio/utils/errors';
import { annotateCourseContentWithProgression } from '@cio/core/services/course/progression';
import { getSessionUserId } from '../_shared/session';

const DEFAULT_CONTENT_GROUPING = true;

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

/**
 * Whether a *new* student would be turned away from this org right now.
 * Mirrors the private `isStudentLimitReached` in
 * @cio/core/services/course/course.ts (not exported from there, so
 * re-implemented here from the same @cio/db/@cio/utils primitives rather
 * than importing that module and its sanitize-html side effect).
 */
async function isStudentLimitReached(orgId: string): Promise<boolean> {
  if (process.env.PUBLIC_IS_SELFHOSTED === 'true') return false;

  const activePlan = await getActiveOrganizationPlan(orgId);
  const limit = getStudentLimit(activePlan?.planName);
  if (!Number.isFinite(limit)) return false;

  const currentCount = await countActiveStudents(orgId);
  return currentCount + 1 > limit;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();

  try {
    const courseId = event.pathParameters?.id;

    if (!courseId) {
      return jsonResponse(400, { success: false, error: 'Missing required path parameter: id' });
    }

    const userId = await getSessionUserId(event);
    if (!userId) {
      return jsonResponse(401, { success: false, message: 'Unauthorized' });
    }

    const isMember = await isUserCourseMemberOrOrgAdmin(courseId, userId);
    if (!isMember) {
      // See module doc: program-based access (ensureProgramCourseAccess) is
      // not yet supported here.
      return jsonResponse(403, {
        success: false,
        error: 'You must be a member of this course to perform this action'
      });
    }

    const slug = event.queryStringParameters?.slug;
    const course = await getCourseWithRelations(slug ? undefined : courseId, slug, userId);

    if (!course) {
      return jsonResponse(404, { success: false, error: 'Course not found' });
    }

    const isContentGroupingEnabled = course.metadata?.isContentGroupingEnabled ?? DEFAULT_CONTENT_GROUPING;
    const progressionMode = course.metadata?.progressionMode ?? 'free';
    const roleId = course.group?.members?.find((member) => member.profileId === userId)?.roleId ?? null;

    const content = await annotateCourseContentWithProgression({
      courseId: course.id,
      profileId: userId,
      roleId,
      progressionMode,
      contentRows: course.contentItems,
      isContentGroupingEnabled
    });

    const { contentItems, org: courseOrg, ...rest } = course;
    const studentLimitReached = courseOrg ? await isStudentLimitReached(courseOrg.id) : false;

    const base = {
      ...rest,
      content,
      studentLimitReached,
      metadata: {
        ...course.metadata,
        progressionMode
      }
    };

    const data = courseOrg
      ? {
          ...base,
          org: {
            id: courseOrg.id,
            name: courseOrg.name,
            siteName: courseOrg.siteName ?? '',
            theme: courseOrg.theme ?? undefined
          }
        }
      : base;

    const duration = Date.now() - startTime;

    return jsonResponse(200, {
      success: true,
      data,
      meta: { duration: `${duration}ms` }
    });
  } catch (error) {
    console.error('[course-details] Error:', error);

    if (error instanceof AppError) {
      return jsonResponse(error.statusCode, { success: false, error: error.message });
    }

    return jsonResponse(500, {
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
}
