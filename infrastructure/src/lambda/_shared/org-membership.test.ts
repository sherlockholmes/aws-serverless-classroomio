/**
 * Unit tests for `_shared/org-membership.ts`.
 *
 * Spec: .kiro/specs/missing-lambda-routes-404
 * Task: 4.4 "Validation: unit tests for the new shared helpers"
 *
 * Runner: Node's built-in `node:test` + `mock.module` (Node 22,
 * `--experimental-test-module-mocks`) + `ts-node` (already a devDependency
 * of `infrastructure/`) — no new test framework is introduced.
 *
 * `@cio/db/auth` is mocked so no real Better Auth session/DB lookup runs.
 * The mock's `getSession` reads a mutable `currentSession` variable that
 * each test sets before calling the helper under test, so a single
 * `mock.module(...)` call (made once, before the first import of
 * `./org-membership`) can serve every test case below.
 *
 * How to run:
 *   cd infrastructure
 *   node --experimental-test-module-mocks --require ts-node/register --test \
 *     src/lambda/_shared/org-membership.test.ts
 *
 * (ts-node type-checking is skipped here — see course-membership.test.ts's
 * header comment for why `TS_NODE_TRANSPILE_ONLY=1` is required: this repo
 * has no `@types/aws-lambda` devDependency, which normal esbuild bundling
 * for the Lambdas never needs since it doesn't type-check either.)
 */

import assert from 'node:assert/strict';
import { before, describe, it, mock } from 'node:test';
import { ROLE } from '@cio/utils/constants';

interface FakeSession {
  user: { id: string } | null;
  orgRoles?: Record<string, number>;
}

// Mutable state read by the mocked `auth.api.getSession` — reassigned by
// each test before invoking the helper under test.
let currentSession: FakeSession | null = null;

mock.module('@cio/db/auth', {
  namedExports: {
    auth: {
      api: {
        getSession: async () => currentSession
      }
    }
  }
});

// Imported dynamically, after the mock above is registered, so the module
// under test picks up the mocked `@cio/db/auth` on first load.
let requireOrgMember: typeof import('./org-membership').requireOrgMember;
let requireOrgTeamMember: typeof import('./org-membership').requireOrgTeamMember;
let requireOrgAdmin: typeof import('./org-membership').requireOrgAdmin;

before(async () => {
  const mod = await import('./org-membership');
  requireOrgMember = mod.requireOrgMember;
  requireOrgTeamMember = mod.requireOrgTeamMember;
  requireOrgAdmin = mod.requireOrgAdmin;
});

function makeEvent(headers: Record<string, string> = {}): any {
  return { headers };
}

const ORG_ID = 'org-1';
const USER_ID = 'user-1';

describe('_shared/org-membership', () => {
  describe('requireOrgMember', () => {
    it('resolves { userId, orgId, roleId } for a valid session + header + membership', async () => {
      currentSession = { user: { id: USER_ID }, orgRoles: { [ORG_ID]: ROLE.ADMIN } };

      const result = await requireOrgMember(makeEvent({ 'cio-org-id': ORG_ID }));

      assert.deepEqual(result, { userId: USER_ID, orgId: ORG_ID, roleId: ROLE.ADMIN });
    });

    it('resolves null when the cio-org-id header is missing', async () => {
      currentSession = { user: { id: USER_ID }, orgRoles: { [ORG_ID]: ROLE.ADMIN } };

      const result = await requireOrgMember(makeEvent({}));

      assert.equal(result, null);
    });

    it('resolves null when there is no session', async () => {
      currentSession = null;

      const result = await requireOrgMember(makeEvent({ 'cio-org-id': ORG_ID }));

      assert.equal(result, null);
    });

    it('resolves null when the session has no user', async () => {
      currentSession = { user: null };

      const result = await requireOrgMember(makeEvent({ 'cio-org-id': ORG_ID }));

      assert.equal(result, null);
    });

    it('resolves null when the user has no role for this org', async () => {
      currentSession = { user: { id: USER_ID }, orgRoles: { 'some-other-org': ROLE.ADMIN } };

      const result = await requireOrgMember(makeEvent({ 'cio-org-id': ORG_ID }));

      assert.equal(result, null);
    });
  });

  describe('requireOrgAdmin', () => {
    it('resolves null when the role is present but insufficient (STUDENT)', async () => {
      currentSession = { user: { id: USER_ID }, orgRoles: { [ORG_ID]: ROLE.STUDENT } };

      const result = await requireOrgAdmin(makeEvent({ 'cio-org-id': ORG_ID }));

      assert.equal(result, null);
    });

    it('resolves the membership object when the role is ADMIN', async () => {
      currentSession = { user: { id: USER_ID }, orgRoles: { [ORG_ID]: ROLE.ADMIN } };

      const result = await requireOrgAdmin(makeEvent({ 'cio-org-id': ORG_ID }));

      assert.deepEqual(result, { userId: USER_ID, orgId: ORG_ID, roleId: ROLE.ADMIN });
    });
  });

  describe('requireOrgTeamMember', () => {
    it('resolves the membership object when the role is TUTOR', async () => {
      currentSession = { user: { id: USER_ID }, orgRoles: { [ORG_ID]: ROLE.TUTOR } };

      const result = await requireOrgTeamMember(makeEvent({ 'cio-org-id': ORG_ID }));

      assert.deepEqual(result, { userId: USER_ID, orgId: ORG_ID, roleId: ROLE.TUTOR });
    });

    it('resolves null when the role is STUDENT (not team)', async () => {
      currentSession = { user: { id: USER_ID }, orgRoles: { [ORG_ID]: ROLE.STUDENT } };

      const result = await requireOrgTeamMember(makeEvent({ 'cio-org-id': ORG_ID }));

      assert.equal(result, null);
    });
  });
});
