/**
 * Unit tests for `_shared/course-membership.ts`.
 *
 * Spec: .kiro/specs/missing-lambda-routes-404
 * Task: 4.4 "Validation: unit tests for the new shared helpers"
 *
 * Runner: Node's built-in `node:test` + `mock.module` (Node 22,
 * `--experimental-test-module-mocks`) + `ts-node` (already a devDependency
 * of `infrastructure/`) — no new test framework is introduced.
 *
 * Two modules are mocked:
 *   - `@cio/db/auth` — `course-membership.ts` depends on it transitively via
 *     `./session`'s `getSessionUserId`, which calls `auth.api.getSession`.
 *   - `@cio/db/queries/group` — supplies `isUserCourseMemberOrOrgAdmin` /
 *     `isCourseTeamMemberOrOrgAdmin`, which back `requireCourseMember` /
 *     `requireCourseTeamMember` respectively.
 *
 * Both mocks read mutable variables set per-test, so a single
 * `mock.module(...)` call per module (made before the first import of
 * `./course-membership`) covers every test case below.
 *
 * How to run:
 *   cd infrastructure
 *   node --experimental-test-module-mocks --require ts-node/register --test \
 *     src/lambda/_shared/course-membership.test.ts
 *
 * Note on `TS_NODE_TRANSPILE_ONLY`: this repo has no `@types/aws-lambda`
 * devDependency (the Lambdas are normally bundled with esbuild, which
 * doesn't type-check either), so a plain `ts-node/register` run fails on
 * `Cannot find module 'aws-lambda'` type-only imports. Run with
 * `TS_NODE_TRANSPILE_ONLY=1` (or add `--transpile-only` semantics via env)
 * to skip type-checking and transpile only, e.g.:
 *
 *   TS_NODE_TRANSPILE_ONLY=1 node --experimental-test-module-mocks \
 *     --require ts-node/register --test \
 *     src/lambda/_shared/org-membership.test.ts src/lambda/_shared/course-membership.test.ts
 */

import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';

// Mutable state read by the mocked `auth.api.getSession` (via `./session`).
let currentSession: { user: { id: string } | null } | null = null;

// Mutable state read by the mocked `@cio/db/queries/group` functions.
let courseMemberResult = false;
let courseTeamMemberResult = false;

mock.module('@cio/db/auth', {
  namedExports: {
    auth: {
      api: {
        getSession: async () => currentSession
      }
    }
  }
});

mock.module('@cio/db/queries/group', {
  namedExports: {
    isUserCourseMemberOrOrgAdmin: async () => courseMemberResult,
    isCourseTeamMemberOrOrgAdmin: async () => courseTeamMemberResult
  }
});

// Imported dynamically, after both mocks above are registered, so the
// module under test (and the `./session` module it depends on) pick up the
// mocked `@cio/db/auth` / `@cio/db/queries/group` on first load.
let requireCourseMember: typeof import('./course-membership').requireCourseMember;
let requireCourseTeamMember: typeof import('./course-membership').requireCourseTeamMember;

before(async () => {
  const mod = await import('./course-membership');
  requireCourseMember = mod.requireCourseMember;
  requireCourseTeamMember = mod.requireCourseTeamMember;
});

function makeEvent(headers: Record<string, string> = {}): any {
  return { headers };
}

const USER_ID = 'user-1';
const COURSE_ID = 'course-1';

describe('_shared/course-membership', () => {
  describe('requireCourseMember', () => {
    it('resolves { userId } when the course-membership query returns true', async () => {
      currentSession = { user: { id: USER_ID } };
      courseMemberResult = true;

      const result = await requireCourseMember(makeEvent(), COURSE_ID);

      assert.deepEqual(result, { userId: USER_ID });
    });

    it('resolves null when the course-membership query returns false', async () => {
      currentSession = { user: { id: USER_ID } };
      courseMemberResult = false;

      const result = await requireCourseMember(makeEvent(), COURSE_ID);

      assert.equal(result, null);
    });

    it('resolves null when there is no session', async () => {
      currentSession = null;
      // Even if the membership query would say true, absence of a session
      // must short-circuit to null without needing that query's result.
      courseMemberResult = true;

      const result = await requireCourseMember(makeEvent(), COURSE_ID);

      assert.equal(result, null);
    });
  });

  describe('requireCourseTeamMember', () => {
    it('resolves { userId } when the team-membership query returns true', async () => {
      currentSession = { user: { id: USER_ID } };
      courseTeamMemberResult = true;

      const result = await requireCourseTeamMember(makeEvent(), COURSE_ID);

      assert.deepEqual(result, { userId: USER_ID });
    });

    it('resolves null when the team-membership query returns false', async () => {
      currentSession = { user: { id: USER_ID } };
      courseTeamMemberResult = false;

      const result = await requireCourseTeamMember(makeEvent(), COURSE_ID);

      assert.equal(result, null);
    });

    it('resolves null when there is no session', async () => {
      currentSession = null;
      courseTeamMemberResult = true;

      const result = await requireCourseTeamMember(makeEvent(), COURSE_ID);

      assert.equal(result, null);
    });
  });
});
