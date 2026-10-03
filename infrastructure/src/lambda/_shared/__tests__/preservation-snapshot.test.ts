/**
 * Preservation Snapshot Test — Already-Migrated Routes Stay Unchanged
 *
 * Spec: .kiro/specs/missing-lambda-routes-404
 * Task: 2. "Write preservation property tests (BEFORE implementing fix)"
 *
 * Property under test (bugfix.md "Preservation Checking" / design.md
 * "Property 2: Preservation"):
 *
 *   FOR ALL X WHERE NOT isBugCondition(X) DO
 *     ASSERT apiGateway(X) = apiGateway'(X)   // already-migrated routes unaffected
 *        AND honoServer(X) = honoServer'(X)   // Render/Cloudflare path unaffected
 *   END FOR
 *
 * This file only exercises the `apiGateway(X) = apiGateway'(X)` half — the
 * AWS side. It is a snapshot test: it hardcodes the response (status code +
 * top-level body-key shape) observed for each of the routes already
 * migrated per bugfix.md 1.3, captured against the LIVE, UNFIXED AWS
 * deployment on the date this file was written, and asserts that re-running
 * the same requests today still produces the same status + key shape.
 *
 * Per design.md's own "Preservation Checking" Test Plan step 1 ("snapshot
 * responses from the ... already-migrated AWS routes for a fixed set of
 * representative inputs") and step 2 ("after each phase's Lambdas are
 * deployed, re-run the same ... snapshots, assert unchanged"), this same
 * file is meant to be re-run, unmodified, after every Fase 0-4 checkpoint
 * (see tasks.md 5.9, 6.14, and any later checkpoints) to catch accidental
 * regressions to `api-stack.ts` introduced while wiring in new routes.
 *
 * Route list (bugfix.md 1.3 — the "already-migrated, must not regress" set):
 *
 *   /health, /api/auth/{proxy+}, /account, /account/profile, /course,
 *   /course/{id}, /course/{id}/enroll, /course/{id}/lessons, /lesson/{id},
 *   /course/{courseId}/lesson/{lessonId}, /lesson/{id}/progress,
 *   /lesson/{id}/video-url, /organization, /organization/first,
 *   /organization/courses/public, /organization/courses/enrolled,
 *   /organization/courses/recommended, /organization/courses
 *
 * NOTE on the count: tasks.md's task 2 refers to this as "the 17
 * already-migrated routes", but the literal comma-separated list in
 * bugfix.md 1.3 (reproduced above) enumerates 18 distinct method+path
 * combinations. This is most likely because `/api/auth/{proxy+}` is a raw
 * passthrough integration to Better Auth (not an application "route" with
 * its own `{success, data}` shape) rather than a genuine off-by-one error,
 * but the discrepancy is called out here rather than silently resolved.
 * Per the instruction to be thorough, ALL 18 method+path combinations from
 * the literal bugfix.md 1.3 list are snapshotted below, so no route in that
 * list is left unverified regardless of which count is "correct".
 *
 * Representative inputs — decisions and rationale:
 *
 *   - All requests are unauthenticated (no session cookie / API key) unless
 *     noted. This environment has real outbound network access to AWS but
 *     no admin session for the target tenant, so the recorded shape for
 *     session-gated routes (`/account`, `/account/profile`, `/course/{id}`,
 *     `/organization/courses/enrolled`, `/organization/courses/recommended`,
 *     `/organization/courses`) is the 401 "Unauthorized" branch, not the
 *     200 authenticated branch. A 401 is still a stable, well-shaped
 *     response distinct from API Gateway's own 404 — it proves the route
 *     IS registered and IS reaching Lambda/middleware logic, which is
 *     exactly what this preservation snapshot needs to protect. Re-run
 *     with a real session (see bug-condition-exploration.test.ts's
 *     `RENDER_ADMIN_SESSION_COOKIE` convention, extended here as
 *     `AWS_ADMIN_SESSION_COOKIE` if ever needed) to additionally snapshot
 *     the 200 branch — not required for this property, since Preservation
 *     only needs "the response is unchanged", not "the response is a
 *     success".
 *   - `POST /course/{id}/enroll` uses a syntactically-valid but
 *     non-existent UUID (`00000000-0000-0000-0000-000000000000`) as the
 *     courseId and an empty JSON body, and is sent WITHOUT a session. This
 *     deliberately never reaches any enrollment-mutating logic — it 401s
 *     at `authMiddleware`/the Lambda's own session check before any DB
 *     write is attempted, per the instruction not to mutate real
 *     production data. No real course is enrolled into by this test.
 *   - `POST /lesson/{id}/progress` similarly uses a non-existent UUID and
 *     no session, so it 401s before any write.
 *   - `GET /course` (no `orgId` query param) intentionally omits the
 *     required parameter to exercise the Lambda's own validation-error
 *     branch (400) with a stable body shape, rather than depending on a
 *     real org's course list (which could legitimately change over time
 *     and would make an unstable "record the data" snapshot rather than a
 *     stable "record the shape" snapshot).
 *   - `GET /organization` and `GET /organization/first` are called with
 *     `?siteName=udemy-test` (a real seeded tenant per AGENTS.md) but
 *     without an API key, since these AWS routes are gated by
 *     `authOrApiKeyMiddleware` and return a stable 401 shape without one.
 *   - `GET /organization/courses/public` intentionally omits `siteName` to
 *     exercise its 400 validation-error shape, for the same "stable shape
 *     over stable data" reasoning as `GET /course` above.
 *   - `GET /api/auth/get-session` is used as the representative input for
 *     the `/api/auth/{proxy+}` passthrough route — it is Better Auth's own
 *     unauthenticated "who am I" endpoint, side-effect free, and returns a
 *     literal JSON `null` body when no session is present (captured as its
 *     own shape sentinel below rather than a key list, since the body is
 *     not an object).
 *
 * No mutations are performed against production data anywhere in this
 * file: every POST used above is expected to be rejected before reaching
 * any create/update logic, given the missing auth.
 *
 * How to run:
 *
 *   cd infrastructure
 *   AWS_API_BASE_URL="https://api.example.com" \
 *     node --require ts-node/register --test src/lambda/_shared/__tests__/preservation-snapshot.test.ts
 *
 * (Same runner as bug-condition-exploration.test.ts — Node's built-in
 * `node:test` plus the `ts-node` devDependency already present in
 * `infrastructure/package.json`. No new test framework/dependency added.)
 *
 * Separately, and NOT part of the Preservation assertions below (per
 * tasks.md task 2's explicit instruction), this file also records, purely
 * as documentation for Fase 0's own "before" checkpoint, the UNFIXED-code
 * response of `GET /license/features` against Render. Fase 0 is expected
 * to make this route 404 on Render once the dead route is deleted — that
 * is an intentional, accepted change (bugfix.md Requirement 3.2 protects
 * *other* Render routes, not this one), not something this test protects.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

interface CapturedResponse {
  status: number;
  body: unknown;
  rawBody: string;
}

/** Sentinel used for bodies that are not a JSON object (e.g. literal `null`). */
type BodyShape = 'null' | string[];

interface PreservationSnapshot {
  /** Human-readable label matching the route naming in bugfix.md 1.3. */
  label: string;
  method: 'GET' | 'POST';
  /** Path + query string, relative to the base URL. */
  path: string;
  body?: unknown;
  /** Status code recorded against the live, unfixed AWS deployment. */
  expectedStatus: number;
  /** Top-level body-key shape recorded against the live, unfixed AWS deployment (sorted), or 'null'. */
  expectedBodyShape: BodyShape;
}

const AWS_API_BASE_URL = process.env.AWS_API_BASE_URL ?? 'https://api.example.com';
const RENDER_API_BASE_URL = process.env.RENDER_API_BASE_URL ?? 'https://api.classroomio.com';
const REQUEST_TIMEOUT_MS = 10_000;

const FAKE_COURSE_ID = '00000000-0000-0000-0000-000000000000';
const FAKE_LESSON_ID = '00000000-0000-0000-0000-000000000000';
const SEEDED_SITE_NAME = 'udemy-test'; // per AGENTS.md "Seeded tenants" table

const skipNetworkNote =
  '\n[preservation-snapshot] NOTE: this attempt could not reach the target host from the current ' +
  'environment (DNS/TLS/connection error). Re-run this file from an environment with network access to ' +
  'AWS_API_BASE_URL — see the file header for instructions. This is reported as a skipped assertion, not a ' +
  'passing one: it does NOT confirm preservation either way.';

/**
 * The 18 method+path combinations from bugfix.md 1.3's literal list of
 * already-migrated routes (referred to as "17" in tasks.md task 2 — see
 * the count discrepancy note in the file header). Each entry's
 * `expectedStatus` / `expectedBodyShape` was recorded by issuing the exact
 * same request against the live, unfixed AWS deployment.
 */
const PRESERVATION_SNAPSHOTS: PreservationSnapshot[] = [
  {
    label: '/health — GET, no auth',
    method: 'GET',
    path: '/health',
    expectedStatus: 200,
    expectedBodyShape: ['connectionCount', 'containerState', 'success', 'tests', 'timestamp', 'totalDuration']
  },
  {
    label: '/api/auth/{proxy+} — GET /api/auth/get-session, no session (Better Auth passthrough)',
    method: 'GET',
    path: '/api/auth/get-session',
    expectedStatus: 200,
    expectedBodyShape: 'null'
  },
  {
    label: '/account — GET, no auth',
    method: 'GET',
    path: '/account',
    expectedStatus: 401,
    expectedBodyShape: ['message', 'success']
  },
  {
    label: '/account/profile — GET, no auth',
    method: 'GET',
    path: '/account/profile',
    expectedStatus: 401,
    expectedBodyShape: ['message', 'success']
  },
  {
    label: '/course — GET, no auth, missing required orgId (validation-error shape)',
    method: 'GET',
    path: '/course',
    expectedStatus: 400,
    expectedBodyShape: ['error', 'success']
  },
  {
    label: '/course/{id} — GET, no auth',
    method: 'GET',
    path: `/course/${FAKE_COURSE_ID}`,
    expectedStatus: 401,
    expectedBodyShape: ['message', 'success']
  },
  {
    label: '/course/{id}/enroll — POST, no auth, non-existent courseId (never reaches enrollment logic)',
    method: 'POST',
    path: `/course/${FAKE_COURSE_ID}/enroll`,
    body: {},
    expectedStatus: 401,
    expectedBodyShape: ['error', 'success']
  },
  {
    label: '/course/{id}/lessons — GET, no auth, non-existent courseId',
    method: 'GET',
    path: `/course/${FAKE_COURSE_ID}/lessons`,
    expectedStatus: 404,
    expectedBodyShape: ['error', 'success']
  },
  {
    label: '/lesson/{id} — GET, no auth, non-existent lessonId',
    method: 'GET',
    path: `/lesson/${FAKE_LESSON_ID}`,
    expectedStatus: 404,
    expectedBodyShape: ['error', 'success']
  },
  {
    label: '/course/{courseId}/lesson/{lessonId} — GET, no auth, non-existent ids',
    method: 'GET',
    path: `/course/${FAKE_COURSE_ID}/lesson/${FAKE_LESSON_ID}`,
    expectedStatus: 404,
    expectedBodyShape: ['error', 'success']
  },
  {
    label: '/lesson/{id}/progress — POST, no auth, non-existent lessonId (never reaches a write)',
    method: 'POST',
    path: `/lesson/${FAKE_LESSON_ID}/progress`,
    body: { progress: 0 },
    expectedStatus: 401,
    expectedBodyShape: ['error', 'success']
  },
  {
    label: '/lesson/{id}/video-url — GET, no auth, non-existent lessonId',
    method: 'GET',
    path: `/lesson/${FAKE_LESSON_ID}/video-url`,
    expectedStatus: 404,
    expectedBodyShape: ['error', 'success']
  },
  {
    label: '/organization — GET, no API key, seeded siteName',
    method: 'GET',
    path: `/organization?siteName=${SEEDED_SITE_NAME}`,
    expectedStatus: 401,
    expectedBodyShape: ['message', 'success']
  },
  {
    label: '/organization/first — GET, no API key',
    method: 'GET',
    path: '/organization/first',
    expectedStatus: 401,
    expectedBodyShape: ['message', 'success']
  },
  {
    label: '/organization/courses/public — GET, no auth, missing required siteName (validation-error shape)',
    method: 'GET',
    path: '/organization/courses/public',
    expectedStatus: 400,
    expectedBodyShape: ['message', 'success']
  },
  {
    label: '/organization/courses/enrolled — GET, no auth',
    method: 'GET',
    path: '/organization/courses/enrolled',
    expectedStatus: 401,
    expectedBodyShape: ['message', 'success']
  },
  {
    label: '/organization/courses/recommended — GET, no auth',
    method: 'GET',
    path: '/organization/courses/recommended',
    expectedStatus: 401,
    expectedBodyShape: ['message', 'success']
  },
  {
    label: '/organization/courses — GET, no auth',
    method: 'GET',
    path: '/organization/courses',
    expectedStatus: 401,
    expectedBodyShape: ['message', 'success']
  }
];

async function issueRequest(
  baseUrl: string,
  request: Pick<PreservationSnapshot, 'method' | 'path' | 'body'>
): Promise<CapturedResponse | null> {
  const url = `${baseUrl}${request.path}`;
  const headers: Record<string, string> = {};
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
      // Non-JSON body — keep the raw string.
    }

    return { status: response.status, body, rawBody };
  } catch (error) {
    console.warn(`[preservation-snapshot] request to ${url} failed:`, (error as Error).message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Extracts the sorted top-level key list of a JSON-object body, or the 'null' sentinel. */
function shapeOf(body: unknown): BodyShape {
  if (body === null) return 'null';
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`Expected a JSON object or literal null body, got: ${JSON.stringify(body)}`);
  }

  return Object.keys(body as Record<string, unknown>).sort();
}

function shapesEqual(a: BodyShape, b: BodyShape): boolean {
  if (a === 'null' || b === 'null') return a === b;

  if (a.length !== b.length) return false;

  return a.every((key, index) => key === b[index]);
}

/**
 * Mirrors bugfix.md's `isBugCondition(X)` AWS-side detection: true when the
 * response is API Gateway's own default 404 (no registered route), as
 * opposed to a 404 produced by application logic (which carries a
 * `success` key). None of the routes in this file are expected to hit
 * this — every entry above has a registered API Gateway route — but the
 * check guards against silently treating a regression-to-404 as if it were
 * just "a shape mismatch".
 */
function looksLikeApiGatewayDefault404(response: CapturedResponse): boolean {
  if (response.status !== 404) return false;
  if (typeof response.body !== 'object' || response.body === null) return false;

  const body = response.body as Record<string, unknown>;
  return body.message === 'Not Found' && !('success' in body);
}

describe('Preservation Snapshot — Already-Migrated Routes (bugfix.md 1.3)', () => {
  const results: Array<{ snapshot: PreservationSnapshot; aws: CapturedResponse | null }> = [];

  before(() => {
    console.log('\n[preservation-snapshot] Running against:');
    console.log(`  AWS_API_BASE_URL = ${AWS_API_BASE_URL}`);
    console.log(`  (${PRESERVATION_SNAPSHOTS.length} already-migrated method+path combinations from bugfix.md 1.3)`);
  });

  after(() => {
    console.log('\n[preservation-snapshot] Recorded vs observed (this run):\n');
    for (const { snapshot, aws } of results) {
      console.log(`--- ${snapshot.method} ${snapshot.path} ---`);
      console.log(`  ${snapshot.label}`);
      console.log(`  recorded : ${snapshot.expectedStatus} ${JSON.stringify(snapshot.expectedBodyShape)}`);
      console.log(`  observed : ${aws ? `${aws.status} ${aws.rawBody}` : '(request failed — see warning above)'}`);
      console.log('');
    }
  });

  for (const snapshot of PRESERVATION_SNAPSHOTS) {
    it(`${snapshot.method} ${snapshot.path} — matches the recorded pre-fix snapshot`, async () => {
      const aws = await issueRequest(AWS_API_BASE_URL, snapshot);
      results.push({ snapshot, aws });

      if (!aws) {
        console.warn(skipNetworkNote);
        return;
      }

      // NOT isBugCondition(X): none of these routes should ever regress to
      // API Gateway's own default 404 shape — that would mean the route
      // registration itself broke, which is exactly the regression this
      // property exists to catch.
      assert.ok(
        !looksLikeApiGatewayDefault404(aws),
        `Expected ${snapshot.path} to remain routed to its Lambda (any status except API Gateway's ` +
          `default 404 shape), got: ${aws.status} ${aws.rawBody}. This would indicate a regression to an ` +
          'already-migrated route — a Preservation violation.'
      );

      assert.equal(
        aws.status,
        snapshot.expectedStatus,
        `Preservation violation: ${snapshot.method} ${snapshot.path} returned status ${aws.status}, but the ` +
          `snapshot recorded on unfixed code was ${snapshot.expectedStatus}. Body: ${aws.rawBody}`
      );

      const observedShape = shapeOf(aws.body);
      assert.ok(
        shapesEqual(observedShape, snapshot.expectedBodyShape),
        `Preservation violation: ${snapshot.method} ${snapshot.path} returned body shape ` +
          `${JSON.stringify(observedShape)}, but the snapshot recorded on unfixed code was ` +
          `${JSON.stringify(snapshot.expectedBodyShape)}. Body: ${aws.rawBody}`
      );
    });
  }
});

/**
 * Fase 0 "before" baseline — documentation only, NOT a Preservation
 * assertion (per tasks.md task 2's explicit instruction). Fase 0 (tasks.md
 * task 3) is expected to delete the dead `GET /license/features` Hono
 * route, which will make Render itself start 404ing on this path. That is
 * an intentional, accepted behavior change scoped to this one route (see
 * bugfix.md Requirement 3.2's own carve-out and design.md's "license/
 * features — explicit design decision"), not something protected by
 * Property 2. This block only records what Render returns for it today, on
 * unfixed code, so Fase 0's own checkpoint has a documented "before" state
 * to diff against after the route is removed.
 *
 * No session/API key is available in this environment, so the captured
 * response below is the unauthenticated branch (401), not the
 * `{success:true, data:{valid, features, expiresAt}}` shape the route
 * returns for an authenticated caller — re-run with a valid session/API
 * key to additionally capture that branch before Fase 0 executes, if
 * needed. Either branch equally proves the route is live on Render today
 * (not a 404), which is the only fact this note needs to establish.
 */
describe('Fase 0 baseline note — GET /license/features on Render (documentation only)', () => {
  it('records (does not gate on) the current Render response for the soon-to-be-deleted route', async () => {
    const render = await issueRequest(RENDER_API_BASE_URL, { method: 'GET', path: '/license/features' });

    if (!render) {
      console.warn(skipNetworkNote.replace('AWS_API_BASE_URL', 'RENDER_API_BASE_URL'));
      return;
    }

    console.log('\n[preservation-snapshot] Fase 0 "before" baseline — GET /license/features on Render:');
    console.log(`  status: ${render.status}`);
    console.log(`  body  : ${render.rawBody}`);
    console.log(
      '  (Expected authenticated shape per design.md: {success:true, data:{valid, features, expiresAt}}. ' +
        'No session/API key available in this run, so the branch captured above is whichever unauthenticated ' +
        'rejection Render returns — still proof the route is live on Render today, which is all this note needs.)'
    );

    // Documentation only: assert the route is reachable on Render at all
    // (i.e. NOT a 404 with no body), without asserting a specific shape,
    // since the exact shape depends on whether an authenticated session is
    // available in the run environment.
    assert.notEqual(render.status, 404, 'Expected GET /license/features to still exist on Render pre-Fase-0.');
  });
});
