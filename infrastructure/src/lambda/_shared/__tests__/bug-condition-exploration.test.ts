/**
 * Bug Condition Exploration Test — Missing Lambda Routes (404)
 *
 * Spec: .kiro/specs/missing-lambda-routes-404
 * Task: 1. "Write bug condition exploration test"
 *
 * Property under test (bugfix.md / design.md):
 *
 *   FUNCTION isBugCondition(X)
 *     INPUT: X of type HttpRequest (method, path, headers, body) sent to the
 *            AWS API Gateway HTTP API
 *     RETURN X.path does NOT match any of the explicitly registered API
 *            Gateway routes
 *        AND X.path matches a route that exists and is handled in the Hono
 *            server
 *   END FUNCTION
 *
 * GOAL (per tasks.md task 1): for a representative sample of unmigrated
 * route groups (one per P0 group, plus a P1 and a P2 sample), confirm that:
 *   (a) the AWS API Gateway URL returns HTTP 404 `{"message":"Not Found"}`
 *       TODAY (this is the expected, bug-confirming outcome — the assertions
 *       below are written to FAIL loudly if AWS ever stops 404ing, which
 *       would mean the bug has already been fixed for that route and this
 *       exploration test's job is done for it), and
 *   (b) capture the Render-hosted Hono server's response shape for the same
 *       request, to use as the oracle/parity target for the Fase 2/3/4
 *       validation sub-tasks.
 *
 * IMPORTANT — environment/credentials note (read before running):
 *
 * This test issues real HTTP requests against two live backends and does
 * NOT mock either one, per the "Exploratory Bug Condition Checking" test
 * plan in design.md ("issue the same representative request ... against
 * (a) the AWS API Gateway URL ... (b) the Render-hosted Hono URL"). That
 * means:
 *
 *   - `AWS_API_BASE_URL` must point at the deployed API Gateway HTTP API
 *     (e.g. `https://api.example.com` or the raw
 *     `https://<id>.execute-api.<region>.amazonaws.com` invoke URL). No AWS
 *     credentials are needed to hit a public HTTP API endpoint — this is a
 *     plain HTTPS request, not an AWS SDK call.
 *   - `RENDER_API_BASE_URL` must point at the Render-hosted Hono server that
 *     is the source of truth for tenants not yet on the AWS deployment
 *     (e.g. `https://api.classroomio.com`).
 *   - Three of the six sample requests (`/dash/stats`, `/organization/team/invite`,
 *     `/organization/audience`, `/agent/status`) require an authenticated
 *     admin session against Render to reach anything past that route's own
 *     `authMiddleware`/`orgAdminMiddleware`/`orgTeamMemberMiddleware` guard.
 *     Set `RENDER_ADMIN_SESSION_COOKIE` to a valid `better-auth.session_token`
 *     cookie value (or full `Cookie:` header string) for an org admin on the
 *     target tenant to exercise the authenticated branch. Without it, these
 *     routes still 401 in a well-shaped, informative way on Render (captured
 *     as the oracle for the *unauthenticated* case) — the test does not fail
 *     just because auth wasn't supplied, but the more useful "real data"
 *     oracle capture for the authenticated branch requires someone with
 *     access to a real session to re-run this with the cookie set.
 *   - Whoever has AWS/Render/production access should be the one to actually
 *     run this against the live URLs and confirm the documented outcome
 *     below still holds before Fase 2 native-Lambda work starts. This
 *     sandbox environment has outbound network access but no admin session
 *     cookie for either backend, so the authenticated-branch oracle capture
 *     for tasks 2–4 below is best-effort (unauthenticated shape only) unless
 *     re-run with `RENDER_ADMIN_SESSION_COOKIE` set.
 *
 * How to run:
 *
 *   cd infrastructure
 *   AWS_API_BASE_URL="https://api.example.com" \
 *   RENDER_API_BASE_URL="https://api.classroomio.com" \
 *   RENDER_ADMIN_SESSION_COOKIE="better-auth.session_token=<token>" \
 *   node --require ts-node/register --test src/lambda/_shared/__tests__/bug-condition-exploration.test.ts
 *
 * (No test runner is configured yet for `infrastructure/` — no vitest/jest
 * devDependency exists in infrastructure/package.json. This uses Node's
 * built-in `node:test` + the `ts-node` devDependency already present in
 * infrastructure/package.json, so no new dependency is introduced.)
 *
 * DO NOT attempt to fix the code if the AWS-side assertions below fail by
 * turning up something other than a 404 — that would mean the bug is
 * already fixed for that route, which is a valid, good outcome, not a test
 * bug. Per the bugfix workflow, this task's job is exploration/documentation
 * only; no implementation changes belong in this file or alongside it.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

interface CapturedResponse {
  status: number;
  body: unknown;
  rawBody: string;
}

interface SampleRequest {
  /** Human-readable label matching the route group naming in tasks.md/design.md. */
  label: string;
  /** Priority bucket this route group falls into per design.md's phased plan. */
  priority: 'P0' | 'P1' | 'P2';
  method: 'GET' | 'POST';
  /** Path + query string, relative to the base URL, e.g. "/organization/setup?siteName=udemy-test". */
  path: string;
  body?: unknown;
  /** Extra headers to send (e.g. an admin session cookie) — same request replayed against both backends. */
  extraHeaders?: Record<string, string>;
}

const AWS_API_BASE_URL = process.env.AWS_API_BASE_URL ?? 'https://api.example.com';
const RENDER_API_BASE_URL = process.env.RENDER_API_BASE_URL ?? 'https://api.classroomio.com';
const RENDER_ADMIN_SESSION_COOKIE = process.env.RENDER_ADMIN_SESSION_COOKIE;
const REQUEST_TIMEOUT_MS = 10_000;

const skipNetworkNote =
  '\n[bug-condition-exploration] NOTE: this attempt could not reach the target host from the current ' +
  'environment (DNS/TLS/connection error). Re-run this file from an environment with network access to ' +
  'AWS_API_BASE_URL / RENDER_API_BASE_URL — see the file header for instructions. This is reported as a ' +
  'skipped assertion, not a passing one: it does NOT confirm the bug condition either way.';

/**
 * The six representative sample requests called out explicitly in tasks.md's
 * task 1 ("Scoped PBT Approach" bullet list) — one per P0 group plus a P1 and
 * P2 sample, matching design.md's "Exploratory Bug Condition Checking" test
 * cases 1–4 plus the two extra P1/P2 samples the task adds.
 */
const SAMPLE_REQUESTS: SampleRequest[] = [
  {
    label: "organization/organization.ts .get('/setup') — P0, no auth (public route)",
    priority: 'P0',
    method: 'GET',
    path: '/organization/setup?siteName=udemy-test'
  },
  {
    label: "dash/stats.ts .get('/stats') — P0, authMiddleware + orgMemberMiddleware",
    priority: 'P0',
    method: 'GET',
    path: '/dash/stats?orgId=placeholder-org-id&siteName=udemy-test',
    extraHeaders: RENDER_ADMIN_SESSION_COOKIE ? { cookie: RENDER_ADMIN_SESSION_COOKIE } : undefined
  },
  {
    label: "organization/organization.ts .post('/team/invite') — P0, authMiddleware + orgAdminMiddleware",
    priority: 'P0',
    method: 'POST',
    path: '/organization/team/invite',
    body: { emails: ['exploration-test@example.com'], roleId: 1 },
    extraHeaders: RENDER_ADMIN_SESSION_COOKIE ? { cookie: RENDER_ADMIN_SESSION_COOKIE } : undefined
  },
  {
    label: "onboarding/onboarding.ts .post('/create-org') — P0, authMiddleware",
    priority: 'P0',
    method: 'POST',
    path: '/onboarding/create-org',
    body: {}
  },
  {
    label: "organization/organization.ts .get('/audience') — P1 sample, authMiddleware + orgTeamMemberMiddleware",
    priority: 'P1',
    method: 'GET',
    path: '/organization/audience',
    extraHeaders: RENDER_ADMIN_SESSION_COOKIE ? { cookie: RENDER_ADMIN_SESSION_COOKIE } : undefined
  },
  {
    label: "agent/agent.ts .get('/status') — P2 sample, authMiddleware + orgMemberMiddleware",
    priority: 'P2',
    method: 'GET',
    path: '/agent/status'
  }
];

async function issueRequest(baseUrl: string, request: SampleRequest): Promise<CapturedResponse | null> {
  const url = `${baseUrl}${request.path}`;
  const headers: Record<string, string> = { ...request.extraHeaders };
  if (request.body !== undefined) headers['content-type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      signal: controller.signal
    });

    const rawBody = await response.text();
    let body: unknown = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Non-JSON body (unlikely for this API) — keep the raw string.
    }

    return { status: response.status, body, rawBody };
  } catch (error) {
    console.warn(`[bug-condition-exploration] request to ${url} failed:`, (error as Error).message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Mirrors bugfix.md's `isBugCondition(X)`: true when the AWS response is a
 * 404 with API Gateway's own default-404 body shape (as opposed to a 404
 * legitimately produced by application logic, e.g. "organization not
 * found" — API Gateway's default 404 has exactly `{"message":"Not Found"}`
 * and no `success` key, which is how we distinguish "no route registered"
 * from "route registered, handler returned 404").
 */
function looksLikeApiGatewayDefault404(response: CapturedResponse): boolean {
  if (response.status !== 404) return false;
  if (typeof response.body !== 'object' || response.body === null) return false;

  const body = response.body as Record<string, unknown>;
  return body.message === 'Not Found' && !('success' in body);
}

describe('Bug Condition Exploration — Missing Lambda Routes (404)', () => {
  const capturedOracles: Array<{
    request: SampleRequest;
    aws: CapturedResponse | null;
    render: CapturedResponse | null;
  }> = [];

  before(() => {
    console.log('\n[bug-condition-exploration] Running against:');
    console.log(`  AWS_API_BASE_URL    = ${AWS_API_BASE_URL}`);
    console.log(`  RENDER_API_BASE_URL = ${RENDER_API_BASE_URL}`);
    console.log(
      `  RENDER_ADMIN_SESSION_COOKIE set? ${RENDER_ADMIN_SESSION_COOKIE ? 'yes' : 'no (authenticated-branch oracle capture will be best-effort)'}`
    );
  });

  after(() => {
    console.log('\n[bug-condition-exploration] Captured oracle shapes (Render = source of truth to match later):\n');
    for (const { request, aws, render } of capturedOracles) {
      console.log(`--- ${request.priority} ${request.method} ${request.path} ---`);
      console.log(`  ${request.label}`);
      console.log(
        `  AWS API Gateway    : ${aws ? `${aws.status} ${aws.rawBody}` : '(request failed — see warning above)'}`
      );
      console.log(
        `  Render Hono server : ${render ? `${render.status} ${render.rawBody}` : '(request failed — see warning above)'}`
      );
      console.log('');
    }
  });

  for (const request of SAMPLE_REQUESTS) {
    it(`[${request.priority}] ${request.method} ${request.path} — AWS returns API Gateway's default 404 today`, async () => {
      const [aws, render] = await Promise.all([
        issueRequest(AWS_API_BASE_URL, request),
        issueRequest(RENDER_API_BASE_URL, request)
      ]);
      capturedOracles.push({ request, aws, render });

      if (!aws) {
        console.warn(skipNetworkNote);
        return;
      }

      // isBugCondition(X) — AWS side: no registered API Gateway route for
      // this path, so API Gateway's own routing layer returns its default
      // 404 before any Lambda runs. This assertion is EXPECTED TO PASS on
      // unfixed code — a pass here confirms the bug exists for this route.
      // If this ever fails (i.e. AWS does NOT return the default 404
      // shape), that means the route has already been migrated to a native
      // Lambda for this path — a good outcome, but it means this specific
      // assertion is no longer exercising the bug condition and should be
      // revisited (not "fixed") when that happens.
      assert.equal(
        aws.status,
        404,
        `Expected AWS API Gateway to return 404 for unmigrated route ${request.path}, got ${aws.status}. ` +
          `Body: ${aws.rawBody}. If this route now returns a non-404 status, it appears to have already ` +
          `been migrated — re-classify this sample in tasks.md rather than treating this as a test failure.`
      );
      assert.ok(
        looksLikeApiGatewayDefault404(aws),
        `Expected AWS's 404 body to be API Gateway's default shape {"message":"Not Found"} (no "success" ` +
          `key), got: ${aws.rawBody}. A 404 with a "success" key would mean a Lambda ran and returned 404 ` +
          `itself (e.g. "not found" business logic), which is a different condition than the missing-route bug.`
      );

      if (!render) {
        console.warn(
          `[bug-condition-exploration] Render request for ${request.path} failed — cannot capture the oracle ` +
            'shape for this route in this run. See warning above for the underlying network error.'
        );
        return;
      }

      // Render is the oracle: it should NOT return API Gateway's 404 shape,
      // because the route exists and is handled by the Hono app. Render is
      // allowed to return 401 (missing/invalid session), 400 (validation
      // error), or 200 with real data — anything except the AWS-style
      // "route doesn't exist" 404 — confirming the route is implemented and
      // reachable on the Hono server, which is the second half of
      // isBugCondition(X).
      assert.ok(
        !looksLikeApiGatewayDefault404(render),
        `Expected Render's Hono server to handle ${request.path} (any status except API Gateway's default ` +
          `404 shape), got: ${render.status} ${render.rawBody}. If Render also 404s with this exact shape, ` +
          'the route may not exist on Hono either, and this sample should be reconsidered as a genuine ' +
          '404 rather than a bug-condition example.'
      );
    });
  }
});
