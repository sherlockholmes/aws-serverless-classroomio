/**
 * Account Handler Lambda
 *
 * Handles GET /account.
 *
 * Mirrors apps/api/src/routes/account/account.ts's `.get('/', ...)` handler
 * (backed by apps/api/src/services/account/profile.ts's getAccountData).
 * Required by the dashboard: `apps/dashboard/src/lib/features/app/init.svelte.ts`
 * calls `classroomio.account.$get()` on every authenticated app init
 * (setupApp) to fetch the signed-in user's profile + org memberships. Without
 * this route the dashboard's post-login initialization never completes (it
 * gets a 404 from the migrated API Gateway, which previously only exposed
 * /account/profile — see account-profile Lambda, Task 11.1 — not this
 * broader /account route).
 *
 * Reuses the real query-layer functions from @cio/db + @cio/utils (not
 * hand-rolled SQL or a copy of apps/api's service), so the response shape
 * stays in sync with the monolith — same pattern as organization-handler.
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/db + better-auth.
 *
 * Self-hosted-only behavior intentionally NOT ported here: the monolith's
 * getAccountData auto-enrolls users with zero org memberships as a student
 * in the single org, and attaches a license status, but only when
 * PUBLIC_IS_SELFHOSTED === 'true'. This deployment is cloud-mode
 * (PUBLIC_IS_SELFHOSTED=false), where both branches are no-ops in the
 * monolith too — porting them would add real work (extra queries, an
 * external license API call) that never executes today. Revisit if this
 * Lambda is ever deployed in self-hosted mode.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { auth } from '@cio/db/auth';
import { getProfileById, syncProfileEmailVerificationFromAuthUser } from '@cio/db/queries/auth';
import { getOrganizationByProfileId, countActiveStudents } from '@cio/db/queries/organization';
import { getPlanLimit, toResourceUsage } from '@cio/utils/plans';
import { ROLE } from '@cio/utils/constants';

function buildHeaders(event: APIGatewayProxyEventV2): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value) headers.set(key, value);
  }

  if (event.cookies && event.cookies.length > 0) {
    headers.set('cookie', event.cookies.join('; '));
  }

  return headers;
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

/**
 * Attach per-resource usage + plan limits for admin/tutor members only, same
 * as the monolith's getAccountData. Plain counts so students never receive
 * org limit data.
 */
async function attachOrgLimits(organizations: Awaited<ReturnType<typeof getOrganizationByProfileId>>) {
  await Promise.all(
    organizations.map(async (org) => {
      if (org.roleId !== ROLE.ADMIN && org.roleId !== ROLE.TUTOR) return;

      const activePlan = org.plans.find((plan) => plan.isActive);
      const studentsUsed = await countActiveStudents(org.id);
      const studentsLimit = getPlanLimit('students', activePlan?.planName);

      org.limits = { students: toResourceUsage(studentsUsed, studentsLimit) };
    })
  );
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    let session: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
    try {
      session = await auth.api.getSession({ headers: buildHeaders(event) });
    } catch (error) {
      console.error('[account-handler] getSession error:', error);
      session = null;
    }

    if (!session || !session.user) {
      return jsonResponse(401, { success: false, message: 'Unauthorized' });
    }

    const userId = session.user.id;

    const [profileResult, organizations] = await Promise.all([
      getProfileById(userId),
      getOrganizationByProfileId(userId)
    ]);

    if (!profileResult) {
      return jsonResponse(404, { success: false, message: 'Account not found' });
    }

    const profile = (await syncProfileEmailVerificationFromAuthUser(userId)) ?? profileResult;

    await attachOrgLimits(organizations);

    return jsonResponse(200, {
      success: true,
      user: session.user,
      profile,
      organizations,
      // License features are self-hosted-only (see module doc); always empty in cloud mode.
      licenseFeatures: []
    });
  } catch (error) {
    console.error('[account-handler] Error:', error);

    return jsonResponse(500, {
      success: false,
      message: 'Failed to fetch account data',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};
