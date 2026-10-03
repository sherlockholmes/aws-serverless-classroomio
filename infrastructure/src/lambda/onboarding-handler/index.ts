/**
 * Onboarding Handler Lambda
 *
 * Handles:
 * - POST /onboarding/create-org       (create org + become owner — session only)
 * - POST /onboarding/update-metadata  (persist goal/source/fullname on the profile — session only)
 * - POST /onboarding/complete         (mark onboarding complete — session only)
 *
 * Mirrors apps/api/src/routes/onboarding/onboarding.ts's `onboardingRouter`.
 * Required by the dashboard's post-signup onboarding wizard (create
 * organization, pick a goal/source, finish).
 *
 * Auth mirrors Hono: all three routes use `authMiddleware` (session only,
 * `getSessionUserId` here) — there is no API-key alternative for onboarding.
 *
 * Validation is re-implemented manually here (not via zValidator/Zod) to
 * mirror packages/utils/src/validation/onboarding/onboarding.ts's
 * ZOnboardingCreateOrg / ZOnboardingUpdateMetadata schemas. The 400 response
 * shape below (`{success:false, message}`) is a reasonable approximation of
 * Hono's zValidator rejection shape, not a byte-for-byte replica — same
 * tradeoff as organization-mutation-handler / organization-team-handler.
 *
 * Reuses the real query-layer functions from @cio/db (not hand-rolled SQL)
 * for everything that IS implemented. Bundled from the monorepo root
 * (bundleFromMonorepoRoot: true in api-stack.ts) so esbuild can resolve
 * @cio/db + better-auth. All @cio/db imports use the folder-level subpath
 * (`@cio/db/queries/organization`, `@cio/db/queries/auth`), never an
 * individual file path.
 *
 * createOrganizationWithOwner's business logic (self-hosted single-org
 * gate, checkSiteNameExists, create-org+member+plan transaction, 23505
 * constraint handling) is copied from
 * infrastructure/src/lambda/organization-mutation-handler/index.ts's local
 * `createOrg` rather than imported cross-Lambda — each Lambda bundle must be
 * self-contained. The `fullname` field accepted by ZOnboardingCreateOrg is
 * intentionally NOT used when creating the organization: the real
 * `createOrganizationWithOwner` (apps/api/src/services/onboarding.ts) also
 * ignores it for that purpose (the profile's fullname is updated separately
 * via the account/profile flow, not here).
 *
 * KNOWN GAPS (intentional scope cuts for this first pass — the goal is to
 * eliminate the hard 404 from API Gateway, not to reach full functional
 * parity with the Hono service layer in one change):
 *
 * (a) ZOnboardingCreateOrg validation is SIMPLIFIED the same way as
 *     organization-mutation-handler's create-organization validation:
 *     `orgName`/`siteName` are checked for length >= 5 and no leading/
 *     trailing hyphen, but `siteName` is NOT checked against the
 *     `blockedSubdomain` reserved-word list (@cio/utils/constants).
 * POST /onboarding/complete sends the `welcome` email via the shared
 * `_shared/email-enqueue.ts` SQS helper (Task 7.3 of
 * .kiro/specs/ses-email-delivery), mirroring the real `completeOnboarding`
 * (apps/api/src/services/onboarding.ts). Uses `profile.email` as the
 * recipient (not the better-auth session's `user.email`, which this
 * Lambda's `getSessionUserId` doesn't expose) — these are expected to match
 * in the normal signup flow. Enqueue failures are logged and swallowed
 * rather than failing the request, matching the real service's
 * fire-and-forget semantics for this side effect.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { db } from '@cio/db/drizzle';
import {
  checkSiteNameExists,
  createOrganization,
  createOrganizationMember,
  createOrganizationPlan,
  getOrganizationByProfileId,
  getOrganizationCount
} from '@cio/db/queries/organization';
import { getProfileById, updateProfile } from '@cio/db/queries/auth';
import { ROLE } from '@cio/utils/constants';
import { PLAN } from '@cio/utils/plans';

import { getSessionUserId } from '../_shared/session';
import { enqueueTemplateEmail } from '../_shared/email-enqueue';

const NAME_MIN_LENGTH = 5;
const HYPHEN_EDGE_REGEX = /^-|-$/;

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
 * Mirrors ZOnboardingCreateOrg's simplified subset: `fullname` >= 5 chars,
 * `orgName`/`siteName` >= 5 chars and don't start/end with a hyphen.
 * KNOWN GAP: does not check `siteName` against the `blockedSubdomain` list.
 */
function validateCreateOrg(
  body: unknown
):
  | { success: true; data: { fullname: string; orgName: string; siteName: string } }
  | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { fullname, orgName, siteName } = body as Record<string, unknown>;

  if (typeof fullname !== 'string' || fullname.length < NAME_MIN_LENGTH) {
    return { success: false, message: `fullname must be a string of at least ${NAME_MIN_LENGTH} characters` };
  }

  if (typeof orgName !== 'string' || orgName.length < NAME_MIN_LENGTH || HYPHEN_EDGE_REGEX.test(orgName)) {
    return {
      success: false,
      message: `orgName must be a string of at least ${NAME_MIN_LENGTH} characters and cannot start or end with a hyphen`
    };
  }

  if (typeof siteName !== 'string' || siteName.length < NAME_MIN_LENGTH || HYPHEN_EDGE_REGEX.test(siteName)) {
    return {
      success: false,
      message: `siteName must be a string of at least ${NAME_MIN_LENGTH} characters and cannot start or end with a hyphen`
    };
  }

  return { success: true, data: { fullname, orgName, siteName } };
}

/**
 * Mirrors ZOnboardingUpdateMetadata: `fullname`, `goal`, `source` all
 * strings of at least 5 characters.
 */
function validateUpdateMetadata(
  body: unknown
): { success: true; data: { fullname: string; goal: string; source: string } } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { fullname, goal, source } = body as Record<string, unknown>;

  if (typeof fullname !== 'string' || fullname.length < NAME_MIN_LENGTH) {
    return { success: false, message: `fullname must be a string of at least ${NAME_MIN_LENGTH} characters` };
  }

  if (typeof goal !== 'string' || goal.length < NAME_MIN_LENGTH) {
    return { success: false, message: `goal must be a string of at least ${NAME_MIN_LENGTH} characters` };
  }

  if (typeof source !== 'string' || source.length < NAME_MIN_LENGTH) {
    return { success: false, message: `source must be a string of at least ${NAME_MIN_LENGTH} characters` };
  }

  return { success: true, data: { fullname, goal, source } };
}

/**
 * Mirrors createOrganizationWithOwner (apps/api/src/services/onboarding.ts).
 * Copied from organization-mutation-handler/index.ts's local `createOrg`
 * rather than imported cross-Lambda — see module doc. `input.fullname` is
 * intentionally accepted but unused, matching the real service.
 */
async function createOrg(
  profileId: string,
  input: { fullname: string; orgName: string; siteName: string }
): Promise<{ status: number; body: unknown }> {
  if (process.env.PUBLIC_IS_SELFHOSTED === 'true') {
    const count = await getOrganizationCount();
    if (count > 0) {
      return {
        status: 403,
        body: { success: false, message: 'Self-hosted instances support only one organization' }
      };
    }
  }

  const exists = await checkSiteNameExists(input.siteName);
  if (exists) {
    return { status: 409, body: { success: false, message: `Site name '${input.siteName}' already exists` } };
  }

  try {
    const result = await db.transaction(async (tx) => {
      const organization = await createOrganization({ name: input.orgName, siteName: input.siteName }, tx);
      const member = await createOrganizationMember(
        { organizationId: organization.id, profileId, roleId: ROLE.ADMIN, verified: true },
        tx
      );

      if (process.env.PUBLIC_IS_SELFHOSTED === 'true') {
        await createOrganizationPlan(
          {
            orgId: organization.id,
            planName: PLAN.ENTERPRISE as 'ENTERPRISE',
            subscriptionId: `selfhosted-${organization.id}`,
            triggeredBy: member.id,
            payload: {},
            isActive: true,
            provider: 'selfhosted'
          },
          tx
        );
      }

      return { organization, member };
    });

    const organizations = await getOrganizationByProfileId(profileId);

    return {
      status: 201,
      body: { success: true, data: { organization: result.organization, member: result.member, organizations } }
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === '23505') {
      return { status: 409, body: { success: false, message: `Site name '${input.siteName}' already exists` } };
    }

    throw error;
  }
}

/**
 * POST /onboarding/create-org — session only.
 */
async function handleCreateOrg(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = await getSessionUserId(event);
  if (!userId) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateCreateOrg(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const { status, body: responseBody } = await createOrg(userId, validation.data);
    return jsonResponse(status, responseBody);
  } catch (error) {
    console.error('[onboarding-handler] createOrg error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to create organization' });
  }
}

/**
 * POST /onboarding/update-metadata — session only.
 */
async function handleUpdateMetadata(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = await getSessionUserId(event);
  if (!userId) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateUpdateMetadata(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const updatedProfile = await updateProfile(userId, validation.data);
    if (!updatedProfile) {
      return jsonResponse(404, { success: false, message: 'Failed to update profile - profile not found' });
    }

    return jsonResponse(200, { success: true, data: updatedProfile });
  } catch (error) {
    console.error('[onboarding-handler] updateMetadata error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to update onboarding data' });
  }
}

/**
 * POST /onboarding/complete — session only. Sends the welcome email — see
 * module doc.
 */
async function handleComplete(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = await getSessionUserId(event);
  if (!userId) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  try {
    const profile = await getProfileById(userId);
    if (!profile) {
      return jsonResponse(404, { success: false, message: 'Profile not found' });
    }

    if (profile.email) {
      try {
        await enqueueTemplateEmail({
          kind: 'template',
          template: 'welcome',
          to: profile.email,
          fields: { name: profile.fullname }
        });
      } catch (emailError) {
        console.error('[onboarding-handler] Failed to enqueue welcome email:', emailError);
      }
    }

    return jsonResponse(200, { success: true });
  } catch (error) {
    console.error('[onboarding-handler] complete error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to complete onboarding' });
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  if (path.endsWith('/create-org') && method === 'POST') {
    return handleCreateOrg(event);
  }

  if (path.endsWith('/update-metadata') && method === 'POST') {
    return handleUpdateMetadata(event);
  }

  if (path.endsWith('/complete') && method === 'POST') {
    return handleComplete(event);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
