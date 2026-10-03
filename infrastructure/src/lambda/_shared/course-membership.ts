/**
 * Shared course-role auth helpers for course-scoped Lambda routes.
 *
 * Mirrors the two Hono course-role middlewares in
 * apps/api/src/middlewares/course-member.ts and
 * apps/api/src/middlewares/course-team-member.ts:
 *   - courseMemberMiddleware     -> requireCourseMember      (any group role, or org admin)
 *   - courseTeamMemberMiddleware -> requireCourseTeamMember   (course ADMIN/TUTOR, or org admin)
 *
 * Unlike org-scoped roles (`_shared/org-membership.ts`), course roles are not
 * embedded in the Better Auth session — there is no `orgRoles`-style shortcut
 * for course membership. Both Hono middlewares resolve the caller's course
 * access with a dedicated DB lookup (`isUserCourseMemberOrOrgAdmin` /
 * `isCourseTeamMemberOrOrgAdmin` from `@cio/db/queries/group`), so this
 * module only validates the session first (via `getSessionUserId`) and then
 * delegates to those same, already-tested query functions — no new query
 * logic is introduced here.
 */

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { isCourseTeamMemberOrOrgAdmin, isUserCourseMemberOrOrgAdmin } from '@cio/db/queries/group';

import { getSessionUserId } from './session';

/**
 * Resolves the authenticated session and confirms the caller is either a
 * member of the course's group (any role) or an ADMIN of the organization
 * that owns the course's group — mirrors courseMemberMiddleware.
 *
 * Returns null if there is no session, or the user has neither course
 * membership nor org-admin access to the course.
 */
export async function requireCourseMember(
  event: APIGatewayProxyEventV2,
  courseId: string
): Promise<{ userId: string } | null> {
  const userId = await getSessionUserId(event);
  if (!userId) return null;

  const isAllowed = await isUserCourseMemberOrOrgAdmin(courseId, userId);
  if (!isAllowed) return null;

  return { userId };
}

/**
 * Resolves the authenticated session and confirms the caller is either a
 * team member (ADMIN or TUTOR) of the course's group or an ADMIN of the
 * organization that owns the course's group — mirrors
 * courseTeamMemberMiddleware.
 *
 * Returns null if there is no session, or the user is neither a course team
 * member nor an org admin for the course.
 */
export async function requireCourseTeamMember(
  event: APIGatewayProxyEventV2,
  courseId: string
): Promise<{ userId: string } | null> {
  const userId = await getSessionUserId(event);
  if (!userId) return null;

  const isAllowed = await isCourseTeamMemberOrOrgAdmin(courseId, userId);
  if (!isAllowed) return null;

  return { userId };
}
