/**
 * Shared session-validation helper for domain Lambdas.
 *
 * Validates the Better Auth session cookie (signed, stored in the `session`
 * table) via auth.api.getSession — the same mechanism used by auth-handler
 * and account-profile. Replaces the earlier `extractUserId` placeholder,
 * which decoded an unsigned JWT-shaped payload without verifying it against
 * any secret or database record (anyone could forge an Authorization header).
 *
 * Lambdas importing this module MUST set `bundleFromMonorepoRoot: true` in
 * their NodejsFunction definition (api-stack.ts) so esbuild can resolve
 * @cio/db + better-auth from the repo root, and MUST receive the shared
 * `authEnv` (BETTER_AUTH_SECRET, PUBLIC_SERVER_URL, TRUSTED_ORIGINS, ...).
 */

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { auth } from '@cio/db/auth';

/**
 * Rebuild a Fetch API Headers object from an API Gateway v2 event, including
 * cookies (event.cookies is delivered separately from event.headers by HTTP API).
 */
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

/**
 * Validate the request's Better Auth session cookie.
 *
 * Returns the authenticated user's id, or null if there is no session or it
 * is invalid/expired. Never throws — auth.api.getSession errors are logged
 * and treated as "no session" so callers can fall back to anonymous/public
 * behavior where appropriate (e.g. public course/lesson visibility).
 */
export async function getSessionUserId(event: APIGatewayProxyEventV2): Promise<string | null> {
  try {
    const session = await auth.api.getSession({ headers: buildHeaders(event) });
    return session?.user?.id ?? null;
  } catch (error) {
    console.error('[session] getSession error:', error);
    return null;
  }
}

export interface SessionUser {
  id: string;
  email: string | null;
}

/**
 * Same validation as `getSessionUserId`, but also returns the user's email —
 * needed by routes (e.g. invite accept flows) that enforce an email match
 * against a target record, matching Hono's `c.get('user')!.email` usage.
 * Returns null under the same conditions as `getSessionUserId`.
 */
export async function getSessionUser(event: APIGatewayProxyEventV2): Promise<SessionUser | null> {
  try {
    const session = await auth.api.getSession({ headers: buildHeaders(event) });
    if (!session?.user) return null;

    return { id: session.user.id, email: session.user.email ?? null };
  } catch (error) {
    console.error('[session] getSession error:', error);
    return null;
  }
}
