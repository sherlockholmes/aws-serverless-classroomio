/**
 * Authentication Lambda Handler
 *
 * This Lambda proxies all /auth/* routes to Better Auth's handler.
 * Handles login, logout, session validation, OAuth, SSO, and email verification.
 *
 * Routes handled:
 * - POST /auth/sign-in/email (email/password login)
 * - POST /auth/sign-in/social (OAuth - Google)
 * - POST /auth/sign-out (logout)
 * - GET /auth/session (session validation)
 * - POST /auth/sign-up/email (registration)
 * - GET/POST /auth/* (all Better Auth routes)
 *
 * Requirements: 4.1, 4.5, 9.6
 * Design: Request Flow § Web Request Flow (Authenticated)
 * Tasks: 8.1, 8.2, 8.3 (consolidated into single Lambda)
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { auth } from '@cio/db/auth';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    console.log('[auth-handler] Processing request:', {
      method: event.requestContext.http.method,
      path: event.rawPath,
      queryString: event.rawQueryString
    });

    // Reconstruct the full URL from API Gateway event
    const protocol = event.headers['x-forwarded-proto'] || 'https';
    const host = event.headers['x-forwarded-host'] || event.requestContext.domainName;
    const path = event.rawPath;
    const queryString = event.rawQueryString ? `?${event.rawQueryString}` : '';
    const url = `${protocol}://${host}${path}${queryString}`;

    // Reconstruct headers
    const headers = new Headers();
    for (const [key, value] of Object.entries(event.headers || {})) {
      if (value) {
        headers.set(key, value);
      }
    }

    // Reconstruct cookies from event.cookies array
    if (event.cookies && event.cookies.length > 0) {
      const cookieHeader = event.cookies.join('; ');
      headers.set('cookie', cookieHeader);
    }

    // Create Request object for Better Auth
    const request = new Request(url, {
      method: event.requestContext.http.method,
      headers,
      body: event.body
        ? event.isBase64Encoded
          ? Buffer.from(event.body, 'base64').toString('utf-8')
          : event.body
        : undefined
    });

    // Call Better Auth handler
    const response = await auth.handler(request);

    // Extract response body
    const responseBody = await response.text();

    // Extract cookies from Set-Cookie headers
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    const cookies = setCookieHeaders.length > 0 ? setCookieHeaders : undefined;

    // Build response headers (exclude Set-Cookie as it's handled separately)
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'set-cookie') {
        responseHeaders[key] = value;
      }
    });

    console.log('[auth-handler] Response:', {
      status: response.status,
      hasCookies: !!cookies,
      bodyLength: responseBody.length
    });

    return {
      statusCode: response.status,
      headers: responseHeaders,
      cookies,
      body: responseBody
    };
  } catch (error) {
    console.error('[auth-handler] Error:', error);

    return {
      statusCode: 500,
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        success: false,
        message: 'Authentication service error',
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    };
  }
};
