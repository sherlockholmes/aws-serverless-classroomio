/**
 * Organization Mutation Handler Lambda
 *
 * Handles:
 * - POST /organization              (create org + become owner — session only)
 * - PUT  /organization               (update org — ADMIN only)
 * - POST /organization/plan          (create org plan — session OR API key)
 * - PUT  /organization/plan          (update org plan by subscriptionId — session OR API key)
 * - POST /organization/plan/cancel   (cancel org plan by subscriptionId — session OR API key)
 *
 * Mirrors apps/api/src/routes/organization/organization.ts's `.post('/', ...)`,
 * `.put('/', ...)`, `.post('/plan', ...)`, `.put('/plan', ...)` and
 * `.post('/plan/cancel', ...)` handlers. Required by the dashboard's
 * onboarding "create organization" flow, org settings "General" save, and
 * the Polar billing webhook/checkout flows that create/update/cancel plans.
 *
 * Auth mirrors Hono: POST / requires a session only (`authMiddleware`,
 * `getSessionUserId`); PUT / requires ADMIN (`orgAdminMiddleware`, i.e.
 * `requireOrgAdmin` from `_shared/org-membership`); all three /plan* routes
 * accept EITHER a valid session OR a valid `PRIVATE_SERVER_KEY` bearer token
 * (`authOrApiKeyMiddleware`), replicated here as `isValidApiKey(event) ||
 * getSessionUserId(event)`.
 *
 * Validation is re-implemented manually here (not via zValidator/Zod) to
 * mirror packages/utils/src/validation/organization/organization.ts's
 * ZCreateOrganization / ZUpdateOrganization / ZCreateOrgPlan / ZUpdateOrgPlan
 * / ZCancelOrgPlan schemas. The 400 response shape below
 * (`{success:false, message}`) is a reasonable approximation of Hono's
 * zValidator rejection shape, not a byte-for-byte replica — same tradeoff as
 * organization-team-handler / organization-audience-handler.
 *
 * Reuses the real query-layer functions from @cio/db (not hand-rolled SQL)
 * for everything that IS implemented, so response shapes stay in sync with
 * the monolith for the parts covered. Bundled from the monorepo root
 * (bundleFromMonorepoRoot: true in api-stack.ts) so esbuild can resolve
 * @cio/db + better-auth. All @cio/db imports use the folder-level subpath
 * (`@cio/db/queries/organization`), never an individual file path — the
 * package only exposes query functions through `queries/organization/index.ts`'s
 * re-exports.
 *
 * KNOWN GAPS (intentional scope cuts for this first pass — the goal is to
 * eliminate the hard 404 from API Gateway, not to reach full functional
 * parity with the Hono service layer in one change):
 *
 * (a) ZCreateOrganization / ZUpdateOrganization validation is SIMPLIFIED.
 *     Create only checks `name`/`siteName` are strings of length >= 5 and
 *     don't start/end with a hyphen — it does NOT check the `siteName`
 *     against the `blockedSubdomain` reserved-word list
 *     (@cio/utils/constants), so a handful of reserved subdomains that Hono
 *     would reject with a 400 will pass through here. Update accepts the
 *     body as an arbitrary partial object (400 only if it doesn't parse as
 *     JSON or isn't an object) — it does NOT enforce `name.min(5)` or
 *     validate `avatarUrl`/`favicon` as well-formed URLs the way the real
 *     Zod schema does.
 * (b) updateOrg omits three real business-logic gates from
 *     apps/api/src/services/organization.ts's `updateOrg`: (i) the plan
 *     entitlement gate on `landingpage.theme !== 'minimal'` for orgs on the
 *     BASIC plan, (ii) the plan entitlement gate on changes to
 *     `disableSignup` / `disableEmailPassword` / `disableGoogleAuth` /
 *     `disableSignupMessage` / `settings.signup.inviteOnly` /
 *     `settings.internalEnrollmentOnly` (Enterprise/Basic auth-settings
 *     entitlement), and (iii) `trustCustomDomainHostname` /
 *     `untrustCustomDomainHostname` — these update an in-memory
 *     CORS/trusted-origin registry that lives inside the long-running Hono
 *     process and has no equivalent in a standalone Lambda invocation.
 *     `updateOrganization` (the query-layer function) still performs the
 *     deep JSONB merge of `settings` internally, so that part IS preserved.
 * (c) createOrgPlan omits the "primary workspace" resolution
 *     (`getAccountPrimary` / `resolveOrgPlanTriggeredBy` from
 *     apps/api/src/services/organization.ts) that Polar checkout/webhook
 *     flows rely on to attach a subscription to a user's primary org even
 *     when a secondary org id was supplied at checkout. This Lambda creates
 *     the plan directly against the `orgId` received in the request body.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { TOrganization, TOrganizationPlan } from '@cio/db/types';
import { db } from '@cio/db/drizzle';
import {
  checkSiteNameExists,
  createOrganization,
  createOrganizationMember,
  createOrganizationPlan,
  getOrganizationByProfileId,
  getOrganizationCount,
  getOrganizationPlanBySubscriptionId,
  updateOrganization,
  updateOrganizationPlan,
  cancelOrganizationPlan
} from '@cio/db/queries/organization';
import { ROLE } from '@cio/utils/constants';
import { PLAN } from '@cio/utils/plans';

import { isValidApiKey } from '../_shared/api-key';
import { getSessionUserId } from '../_shared/session';
import { requireOrgAdmin } from '../_shared/org-membership';

const NAME_MIN_LENGTH = 5;
const HYPHEN_EDGE_REGEX = /^-|-$/;
const PLAN_NAME_VALUES = ['EARLY_ADOPTER', 'ENTERPRISE', 'BASIC'] as const;

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
 * Resolves whether the caller is authenticated via either a valid session
 * or a valid PRIVATE_SERVER_KEY bearer token — mirrors authOrApiKeyMiddleware.
 * Returns the session userId when authenticated via session, or null when
 * authenticated via API key (no userId to resolve) — and `undefined` when
 * neither auth path succeeds.
 */
async function resolveSessionOrApiKeyAuth(event: APIGatewayProxyEventV2): Promise<string | null | undefined> {
  if (isValidApiKey(event)) {
    return null;
  }

  const userId = await getSessionUserId(event);
  if (userId) {
    return userId;
  }

  return undefined;
}

/**
 * Mirrors ZCreateOrganization's simplified subset: `name`/`siteName` are
 * strings of at least 5 characters that don't start/end with a hyphen.
 * KNOWN GAP: does not check `siteName` against the `blockedSubdomain` list.
 */
function validateCreateOrganization(
  body: unknown
): { success: true; data: { name: string; siteName: string } } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { name, siteName } = body as Record<string, unknown>;

  if (typeof name !== 'string' || name.length < NAME_MIN_LENGTH || HYPHEN_EDGE_REGEX.test(name)) {
    return {
      success: false,
      message: `name must be a string of at least ${NAME_MIN_LENGTH} characters and cannot start or end with a hyphen`
    };
  }

  if (typeof siteName !== 'string' || siteName.length < NAME_MIN_LENGTH || HYPHEN_EDGE_REGEX.test(siteName)) {
    return {
      success: false,
      message: `siteName must be a string of at least ${NAME_MIN_LENGTH} characters and cannot start or end with a hyphen`
    };
  }

  return { success: true, data: { name, siteName } };
}

/**
 * Mirrors ZUpdateOrganization's minimum viable shape: every field is
 * optional, so the only rejection case is a body that isn't a JSON object.
 * KNOWN GAP: does not enforce `name.min(5)` or URL-shape validation for
 * `avatarUrl`/`favicon` the way the real Zod schema does.
 */
function validateUpdateOrganization(
  body: unknown
): { success: true; data: Partial<TOrganization> } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { success: false, message: 'Invalid request body' };
  }

  return { success: true, data: body as Partial<TOrganization> };
}

/**
 * Mirrors ZCreateOrgPlan: { orgId: uuid, planName: enum, subscriptionId: string (min 1),
 * triggeredBy: positive int, payload: record<string, unknown> }.
 */
function validateCreateOrgPlan(body: unknown):
  | {
      success: true;
      data: {
        orgId: string;
        planName: (typeof PLAN_NAME_VALUES)[number];
        subscriptionId: string;
        triggeredBy: number;
        payload: Record<string, unknown>;
      };
    }
  | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { orgId, planName, subscriptionId, triggeredBy, payload } = body as Record<string, unknown>;

  if (typeof orgId !== 'string' || orgId.length === 0) {
    return { success: false, message: 'orgId must be a valid UUID' };
  }

  if (typeof planName !== 'string' || !PLAN_NAME_VALUES.includes(planName as (typeof PLAN_NAME_VALUES)[number])) {
    return { success: false, message: `planName must be one of: ${PLAN_NAME_VALUES.join(', ')}` };
  }

  if (typeof subscriptionId !== 'string' || subscriptionId.length < 1) {
    return { success: false, message: 'subscriptionId must be a non-empty string' };
  }

  if (typeof triggeredBy !== 'number' || !Number.isInteger(triggeredBy) || triggeredBy <= 0) {
    return { success: false, message: 'triggeredBy must be a positive integer' };
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { success: false, message: 'payload must be an object' };
  }

  return {
    success: true,
    data: {
      orgId,
      planName: planName as (typeof PLAN_NAME_VALUES)[number],
      subscriptionId,
      triggeredBy,
      payload: payload as Record<string, unknown>
    }
  };
}

/**
 * Mirrors ZUpdateOrgPlan / ZCancelOrgPlan: { subscriptionId: string (min 1), payload: record }.
 */
function validateSubscriptionPayload(
  body: unknown
):
  | { success: true; data: { subscriptionId: string; payload: Record<string, unknown> } }
  | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { subscriptionId, payload } = body as Record<string, unknown>;

  if (typeof subscriptionId !== 'string' || subscriptionId.length < 1) {
    return { success: false, message: 'subscriptionId must be a non-empty string' };
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { success: false, message: 'payload must be an object' };
  }

  return { success: true, data: { subscriptionId, payload: payload as Record<string, unknown> } };
}

/**
 * Mirrors createOrganizationWithOwner (apps/api/src/services/onboarding.ts),
 * reimplemented here against @cio/db directly since apps/api's service file
 * sits behind the `@api/*` alias this standalone Lambda bundle can't resolve.
 */
async function createOrg(
  profileId: string,
  input: { name: string; siteName: string }
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
      const organization = await createOrganization({ name: input.name, siteName: input.siteName }, tx);
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
 * POST /organization — session only.
 */
async function handleCreateOrganization(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = await getSessionUserId(event);
  if (!userId) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateCreateOrganization(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const { status, body: responseBody } = await createOrg(userId, validation.data);
    return jsonResponse(status, responseBody);
  } catch (error) {
    console.error('[organization-mutation-handler] createOrg error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to create organization' });
  }
}

/**
 * PUT /organization — ADMIN only.
 *
 * KNOWN GAP: omits the plan entitlement gates and custom-domain trust
 * registry side effects from the real updateOrg — see module doc.
 */
async function handleUpdateOrganization(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgAdmin(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateUpdateOrganization(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const data = validation.data;

  if (data.siteName) {
    const exists = await checkSiteNameExists(data.siteName, member.orgId);
    if (exists) {
      return jsonResponse(409, { success: false, message: 'Site name already exists' });
    }
  }

  try {
    const organization = await updateOrganization(member.orgId, data);
    if (!organization) {
      return jsonResponse(404, { success: false, message: 'Organization not found' });
    }

    return jsonResponse(200, { success: true, data: organization });
  } catch (error) {
    console.error('[organization-mutation-handler] updateOrg error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to update organization' });
  }
}

/**
 * POST /organization/plan — session OR API key.
 *
 * KNOWN GAP: does not resolve the "primary workspace" for the plan — see
 * module doc. Creates the plan directly against `data.orgId`.
 */
async function handleCreateOrgPlan(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const auth = await resolveSessionOrApiKeyAuth(event);
  if (auth === undefined) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateCreateOrgPlan(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const data = validation.data;

  try {
    const existingPlan = await getOrganizationPlanBySubscriptionId(data.subscriptionId);
    if (existingPlan) {
      return jsonResponse(201, { success: true, data: existingPlan });
    }

    const plan = await createOrganizationPlan({
      orgId: data.orgId,
      planName: data.planName,
      subscriptionId: data.subscriptionId,
      triggeredBy: data.triggeredBy,
      payload: data.payload,
      isActive: true,
      provider: 'polar'
    });

    return jsonResponse(201, { success: true, data: plan });
  } catch (error) {
    console.error('[organization-mutation-handler] createOrgPlan error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to create organization plan' });
  }
}

/**
 * PUT /organization/plan — session OR API key.
 */
async function handleUpdateOrgPlan(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const auth = await resolveSessionOrApiKeyAuth(event);
  if (auth === undefined) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateSubscriptionPayload(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const plan = await updateOrganizationPlan(
      validation.data.subscriptionId,
      validation.data.payload as TOrganizationPlan['payload']
    );

    if (!plan) {
      return jsonResponse(404, { success: false, message: 'Organization plan not found' });
    }

    return jsonResponse(200, { success: true, data: plan });
  } catch (error) {
    console.error('[organization-mutation-handler] updateOrgPlan error:', error);
    return jsonResponse(404, { success: false, message: 'Organization plan not found' });
  }
}

/**
 * POST /organization/plan/cancel — session OR API key.
 */
async function handleCancelOrgPlan(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const auth = await resolveSessionOrApiKeyAuth(event);
  if (auth === undefined) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateSubscriptionPayload(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  try {
    const plan = await cancelOrganizationPlan(
      validation.data.subscriptionId,
      validation.data.payload as TOrganizationPlan['payload']
    );

    if (!plan) {
      return jsonResponse(404, { success: false, message: 'Organization plan not found' });
    }

    return jsonResponse(200, { success: true, data: plan });
  } catch (error) {
    console.error('[organization-mutation-handler] cancelOrgPlan error:', error);
    return jsonResponse(404, { success: false, message: 'Organization plan not found' });
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  if (path.endsWith('/plan/cancel') && method === 'POST') {
    return handleCancelOrgPlan(event);
  }

  if (path.endsWith('/plan')) {
    if (method === 'POST') return handleCreateOrgPlan(event);
    if (method === 'PUT') return handleUpdateOrgPlan(event);
    return jsonResponse(405, { success: false, message: 'Method not allowed' });
  }

  if (path.endsWith('/organization')) {
    if (method === 'POST') return handleCreateOrganization(event);
    if (method === 'PUT') return handleUpdateOrganization(event);
    return jsonResponse(405, { success: false, message: 'Method not allowed' });
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
