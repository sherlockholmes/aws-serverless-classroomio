/**
 * Shared API-key auth helper for server-to-server Lambda routes.
 *
 * Mirrors apps/api/src/middlewares/api-key.ts: validates
 * `Authorization: Bearer <PRIVATE_SERVER_KEY>`. Used by routes the dashboard's
 * SSR layer calls without a user session (e.g. organization resolution in
 * the root +layout.server.ts, which runs on every page load).
 */

import type { APIGatewayProxyEventV2 } from 'aws-lambda';

export function isValidApiKey(event: APIGatewayProxyEventV2): boolean {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const providedKey = authHeader.slice('Bearer '.length).trim();
  const expectedKey = process.env.PRIVATE_SERVER_KEY;

  if (!expectedKey) {
    console.error('[api-key] PRIVATE_SERVER_KEY not configured');
    return false;
  }

  return providedKey === expectedKey;
}
