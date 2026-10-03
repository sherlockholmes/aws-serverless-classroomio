/**
 * Domain Handler Lambda
 *
 * Handles:
 * - POST /domain (connect / refresh / remove a custom domain — ADMIN only)
 *
 * Mirrors apps/api/src/routes/domain/domain.ts's `domainRouter` and its
 * underlying service, apps/api/src/services/org/domain.ts. Required by the
 * dashboard's org settings "Custom domain" flow (connect a BYOD domain,
 * refresh its verification status, or remove it).
 *
 * External provider: Approximated (https://approximated.app/) — a
 * third-party DNS/custom-domain proxy service. This Lambda talks to it via
 * plain `fetch` HTTP calls against `https://cloud.approximated.app/api`, no
 * SDK required (same as the real service). It requires the following env
 * vars to be configured on the Lambda (see api-stack.ts's `environment`
 * block for this function):
 *   - APPROXIMATED_API_KEY
 *   - APPROXIMATED_TARGET_ADDRESS
 *   - APPROXIMATED_DNS_TARGET_IP
 *   - APPROXIMATED_DNS_TARGET_CNAME
 * These were not previously read by any other Lambda in api-stack.ts, so
 * they were added to this function's `environment` block (falling back to
 * `''` when unset, matching the pattern used for GOOGLE_CLIENT_ID/SECRET in
 * authEnv) rather than assuming they already existed.
 *
 * Auth mirrors Hono: the single route requires ADMIN (`orgAdminMiddleware`,
 * i.e. `requireOrgAdmin` from `_shared/org-membership`).
 *
 * Validation is re-implemented manually here (not via zValidator/Zod) to
 * mirror packages/utils/src/validation/organization/domain.ts's
 * ZDomainActionRequest schema (`action` in ['connect','refresh','remove'],
 * `domain` a non-empty string). The 400 response shape below
 * (`{success:false, message}`) is a reasonable approximation of Hono's
 * zValidator rejection shape, not a byte-for-byte replica — same tradeoff as
 * organization-mutation-handler / organization-team-handler.
 *
 * The Approximated integration itself (ensureApproximatedConfig,
 * approximatedRequest, buildDnsRecords, mapDomainStatus, getStatusMessage,
 * toDomainSetupResult, normalizeCustomDomain, assertSupportedCustomDomain,
 * getVhost, createVhost, connectDomain, refreshDomain, removeDomain) is
 * copied verbatim from apps/api/src/services/org/domain.ts, with the only
 * change being error handling: the real service throws `AppError` (from
 * `@api/utils/errors`, not portable to a standalone Lambda bundle); this
 * Lambda throws a local `DomainHandlerError` carrying the same
 * `statusCode`/`message`/`field`, caught by the route handler below and
 * turned into a `{success:false, message}` JSON response.
 *
 * After a successful connect/refresh/remove, this Lambda persists
 * `customDomain`/`isCustomDomainVerified` on the organization by calling
 * `updateOrganization` (the query-layer function) from
 * `@cio/db/queries/organization` DIRECTLY — the real Hono route calls a
 * thin `updateOrg` service wrapper for this, but that wrapper's extra
 * behavior (settings merge, siteName uniqueness check, plan-entitlement
 * gates) is irrelevant here since this route only ever writes exactly two
 * known-safe fields, so the plain query function is sufficient and keeps
 * this bundle self-contained (each Lambda bundle must not cross-import
 * another Lambda's local helpers).
 *
 * Reuses the real query-layer function from @cio/db (not hand-rolled SQL).
 * Bundled from the monorepo root (bundleFromMonorepoRoot: true in
 * api-stack.ts) so esbuild can resolve @cio/db + better-auth + tldts. All
 * @cio/db imports use the folder-level subpath (`@cio/db/queries/organization`),
 * never an individual file path.
 *
 * KNOWN GAPS (intentional scope cuts for this first pass — the goal is to
 * eliminate the hard 404 from API Gateway, not to reach full functional
 * parity with the Hono service layer in one change):
 *
 * (a) Does not call the full `updateOrg` service wrapper — see above. This
 *     means the plan-entitlement gates that wrapper applies to *other*
 *     fields are irrelevant here (this route never touches those fields),
 *     but any *future* field added to this route's persistence would need
 *     to reconsider this.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { env } from '@cio/core/config/env';
import { parse } from 'tldts';
import { updateOrganization } from '@cio/db/queries/organization';

import { requireOrgAdmin } from '../_shared/org-membership';

export type DomainSetupStatus =
  | 'reconnect_required'
  | 'pending_dns'
  | 'pending_verification'
  | 'verified'
  | 'removed'
  | 'error';

export interface DomainDnsRecord {
  type: 'A' | 'CNAME' | 'TXT';
  name: string;
  value: string;
  status: 'pending' | 'active';
}

export interface DomainSetupResult {
  hostname: string;
  status: DomainSetupStatus;
  verified: boolean;
  reconnectRequired: boolean;
  message: string;
  provider: 'approximated';
  dnsRecords: DomainDnsRecord[];
  validationErrors: string[];
}

interface ApproximatedVhost {
  incoming_address: string;
  target_address?: string;
  dns_pointed_at?: string;
  has_ssl?: boolean;
  is_resolving?: boolean;
  apx_hit?: boolean;
  status?: string;
  ssl_active_from?: string | null;
  ssl_active_until?: string | null;
}

const SUPPORTED_CUSTOM_DOMAIN_PATTERN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const APPROXIMATED_BASE_URL = 'https://cloud.approximated.app/api';
const DOMAIN_ACTION_VALUES = ['connect', 'refresh', 'remove'] as const;
type DomainAction = (typeof DOMAIN_ACTION_VALUES)[number];

class DomainHandlerError extends Error {
  statusCode: number;
  field?: string;

  constructor(message: string, statusCode: number, field?: string) {
    super(message);
    this.statusCode = statusCode;
    this.field = field;
  }
}

function ensureApproximatedConfig() {
  const missing = [
    ['APPROXIMATED_API_KEY', env.APPROXIMATED_API_KEY],
    ['APPROXIMATED_TARGET_ADDRESS', env.APPROXIMATED_TARGET_ADDRESS]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new DomainHandlerError(`Missing Approximated config: ${missing.map(([key]) => key).join(', ')}`, 500);
  }

  if (!env.APPROXIMATED_DNS_TARGET_IP && !env.APPROXIMATED_DNS_TARGET_CNAME) {
    throw new DomainHandlerError(
      'Set APPROXIMATED_DNS_TARGET_IP and/or APPROXIMATED_DNS_TARGET_CNAME so customers know where to point their DNS.',
      500
    );
  }
}

async function approximatedRequest<T>(path: string, init: RequestInit = {}): Promise<T | null> {
  ensureApproximatedConfig();

  const response = await fetch(`${APPROXIMATED_BASE_URL}${path}`, {
    ...init,
    headers: {
      'api-key': env.APPROXIMATED_API_KEY!,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {})
    }
  });

  if (response.status === 404) return null;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const message =
      (payload as { message?: string } | null)?.message ??
      (payload as { error?: string } | null)?.error ??
      `Approximated ${init.method ?? 'GET'} ${path} failed`;
    throw new DomainHandlerError(message, response.status || 500);
  }

  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}

function buildDnsRecords(hostname: string, vhost?: ApproximatedVhost | null): DomainDnsRecord[] {
  const targetIp = env.APPROXIMATED_DNS_TARGET_IP;
  const targetCname = env.APPROXIMATED_DNS_TARGET_CNAME;
  const isApex = !parse(hostname).subdomain;

  const records: DomainDnsRecord[] = [];
  const isResolvingToTarget = Boolean(
    vhost?.is_resolving && (vhost?.dns_pointed_at === targetIp || vhost?.dns_pointed_at === targetCname)
  );
  const status: 'pending' | 'active' = isResolvingToTarget ? 'active' : 'pending';

  if (targetIp) records.push({ type: 'A', name: hostname, value: targetIp, status });
  if (targetCname && !isApex) records.push({ type: 'CNAME', name: hostname, value: targetCname, status });

  return records;
}

function mapDomainStatus(vhost?: ApproximatedVhost | null): DomainSetupStatus {
  if (!vhost) return 'reconnect_required';
  if (vhost.has_ssl && vhost.is_resolving) return 'verified';
  if (!vhost.is_resolving) return 'pending_dns';
  return 'pending_verification';
}

function getStatusMessage(status: DomainSetupStatus) {
  switch (status) {
    case 'reconnect_required':
      return 'Reconnect this custom domain to generate new setup records.';
    case 'pending_dns':
      return 'Add the DNS A record below, then refresh verification.';
    case 'pending_verification':
      return 'DNS resolves correctly. SSL issuance is still in progress.';
    case 'verified':
      return 'Custom domain verified.';
    case 'removed':
      return 'Custom domain removed.';
    case 'error':
    default:
      return 'Custom domain exists, but verification is not complete yet.';
  }
}

function toDomainSetupResult(hostname: string, vhost?: ApproximatedVhost | null): DomainSetupResult {
  const status = mapDomainStatus(vhost);
  return {
    hostname,
    status,
    verified: status === 'verified',
    reconnectRequired: status === 'reconnect_required',
    message: getStatusMessage(status),
    provider: 'approximated',
    dnsRecords: status === 'reconnect_required' ? [] : buildDnsRecords(hostname, vhost),
    validationErrors: []
  };
}

function normalizeCustomDomain(domain: string) {
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .replace(/\.$/, '');
}

function assertSupportedCustomDomain(domain: string) {
  if (!SUPPORTED_CUSTOM_DOMAIN_PATTERN.test(domain)) {
    throw new DomainHandlerError(
      'Enter a valid domain like yourwebsite.com or courses.yourwebsite.com.',
      400,
      'domain'
    );
  }
  if (domain.includes('classroomio.com') || domain.includes('myclassroomio.com')) {
    throw new DomainHandlerError("Domain cannot contain 'classroomio'", 400, 'domain');
  }
}

async function getVhost(hostname: string): Promise<ApproximatedVhost | null> {
  return approximatedRequest<ApproximatedVhost>(`/vhosts/by/incoming/${encodeURIComponent(hostname)}`, {
    method: 'GET'
  });
}

async function createVhost(hostname: string): Promise<ApproximatedVhost> {
  const created = await approximatedRequest<ApproximatedVhost>('/vhosts', {
    method: 'POST',
    body: JSON.stringify({
      incoming_address: hostname,
      target_address: env.APPROXIMATED_TARGET_ADDRESS!,
      target_ports: '443'
    })
  });
  if (!created) throw new DomainHandlerError('Approximated did not return a vhost', 500);
  return created;
}

async function connectDomain(hostname: string): Promise<DomainSetupResult> {
  const existing = await getVhost(hostname);
  const vhost = existing ?? (await createVhost(hostname));
  return toDomainSetupResult(hostname, vhost);
}

async function refreshDomain(hostname: string): Promise<DomainSetupResult> {
  const vhost = await getVhost(hostname);
  return toDomainSetupResult(hostname, vhost);
}

async function removeDomain(hostname: string): Promise<DomainSetupResult> {
  await approximatedRequest<null>(`/vhosts/by/incoming/${encodeURIComponent(hostname)}`, { method: 'DELETE' });
  return {
    hostname,
    status: 'removed',
    verified: false,
    reconnectRequired: false,
    message: getStatusMessage('removed'),
    provider: 'approximated',
    dnsRecords: [],
    validationErrors: []
  };
}

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
 * Mirrors ZDomainActionRequest: `action` in ['connect','refresh','remove'],
 * `domain` a non-empty string.
 */
function validateDomainActionRequest(
  body: unknown
): { success: true; data: { action: DomainAction; domain: string } } | { success: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { success: false, message: 'Invalid request body' };
  }

  const { action, domain } = body as Record<string, unknown>;

  if (typeof action !== 'string' || !DOMAIN_ACTION_VALUES.includes(action as DomainAction)) {
    return { success: false, message: `action must be one of: ${DOMAIN_ACTION_VALUES.join(', ')}` };
  }

  if (typeof domain !== 'string' || domain.length < 1) {
    return { success: false, message: 'domain must be a non-empty string' };
  }

  return { success: true, data: { action: action as DomainAction, domain } };
}

/**
 * POST /domain — ADMIN only.
 */
async function handleDomainAction(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const member = await requireOrgAdmin(event);
  if (!member) {
    return jsonResponse(401, { success: false, message: 'Unauthorized' });
  }

  const body = parseJsonBody(event);
  if (body === undefined) {
    return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
  }

  const validation = validateDomainActionRequest(body);
  if (!validation.success) {
    return jsonResponse(400, { success: false, message: validation.message });
  }

  const { action, domain } = validation.data;

  let normalizedDomain: string;
  try {
    normalizedDomain = normalizeCustomDomain(domain);
    assertSupportedCustomDomain(normalizedDomain);
  } catch (error) {
    if (error instanceof DomainHandlerError) {
      return jsonResponse(error.statusCode, { success: false, message: error.message, field: error.field });
    }
    throw error;
  }

  try {
    switch (action) {
      case 'connect': {
        const result = await connectDomain(normalizedDomain);
        await updateOrganization(member.orgId, {
          customDomain: normalizedDomain,
          isCustomDomainVerified: result.verified
        });
        return jsonResponse(200, { success: true, data: result });
      }
      case 'refresh': {
        const result = await refreshDomain(normalizedDomain);
        await updateOrganization(member.orgId, {
          customDomain: normalizedDomain,
          isCustomDomainVerified: result.verified
        });
        return jsonResponse(200, { success: true, data: result });
      }
      case 'remove': {
        const result = await removeDomain(normalizedDomain);
        await updateOrganization(member.orgId, { customDomain: null, isCustomDomainVerified: false });
        return jsonResponse(200, { success: true, data: result });
      }
    }
  } catch (error) {
    if (error instanceof DomainHandlerError) {
      return jsonResponse(error.statusCode, { success: false, message: error.message, field: error.field });
    }

    console.error('[domain-handler] domain action error:', error);
    return jsonResponse(500, { success: false, message: 'Failed to process domain request' });
  }
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';

  if (path.endsWith('/domain') && method === 'POST') {
    return handleDomainAction(event);
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
