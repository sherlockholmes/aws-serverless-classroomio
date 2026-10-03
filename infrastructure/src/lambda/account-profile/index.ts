/**
 * Account Profile Lambda Handler
 *
 * Handles GET /account/profile
 * Returns the authenticated user's profile.
 *
 * Session validation uses Better Auth's auth.api.getSession (bundled from
 * @cio/db), so cookie signing / session-cache semantics stay identical to the
 * rest of the platform.
 *
 * Requirements: 9.6
 * Design: Creating a New Route § Route Pattern
 * Task: 11.1
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { auth } from '@cio/db/auth';
import { getProfileById, updateProfile } from '@cio/db/queries/auth';
import { ZUpdateProfile } from '@cio/utils/validation/account';

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

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const method = event.requestContext.http.method;
    const headers = buildHeaders(event);

    let session: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
    try {
      session = await auth.api.getSession({ headers });
    } catch (error) {
      console.error('[account-profile] getSession error:', error);
      session = null;
    }

    if (!session || !session.user) {
      return {
        statusCode: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ success: false, message: 'Unauthorized' })
      };
    }

    if (method === 'PUT') {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
        : (event.body ?? '{}');

      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ success: false, message: 'Invalid JSON body' })
        };
      }

      const validation = ZUpdateProfile.safeParse(body);
      if (!validation.success) {
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            success: false,
            message: 'Invalid request body',
            errors: validation.error.issues
          })
        };
      }

      try {
        const updatedProfile = await updateProfile(session.user.id, validation.data);

        if (!updatedProfile) {
          return {
            statusCode: 404,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ success: false, message: 'Profile not found' })
          };
        }

        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ success: true, profile: updatedProfile })
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes('profile_username_key')) {
          return {
            statusCode: 400,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              success: false,
              message: 'Username already exists',
              code: 'VALIDATION_ERROR',
              field: 'username'
            })
          };
        }

        throw error;
      }
    }

    const profile = await getProfileById(session.user.id);

    if (!profile) {
      return {
        statusCode: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ success: false, message: 'Profile not found' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ success: true, data: profile })
    };
  } catch (error) {
    console.error('[account-profile] Error:', error);

    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        success: false,
        message: 'Failed to retrieve profile',
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
