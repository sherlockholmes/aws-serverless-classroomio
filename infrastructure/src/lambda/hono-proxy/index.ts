/**
 * Hono Proxy Lambda
 *
 * Task 10.1: Create Hono proxy Lambda function
 * Requirements: 3.2
 *
 * This Lambda function implements a pass-through proxy to forward requests
 * to the current Hono server running on Render. This allows the migration router
 * to gradually migrate routes from the legacy server to Lambda functions.
 *
 * Key Features:
 * 1. Preserves HTTP method, headers, query params, and body
 * 2. Forwards to current Hono server URL
 * 3. Returns response from Hono server to API Gateway
 * 4. Logs timing metrics for monitoring
 * 5. Handles errors gracefully
 *
 * Environment Variables:
 * - HONO_SERVER_URL: URL of the current Hono server (e.g., https://api.classroomio.com)
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';

// Environment variables
const HONO_SERVER_URL = process.env.HONO_SERVER_URL || '';

/**
 * Lambda handler - forwards requests to Hono server
 */
export async function handler(event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();
  const path = event.rawPath || '/';
  const method = event.requestContext.http.method;

  console.log('Hono Proxy invoked', {
    requestId: context.requestId,
    path,
    method,
    honoServerUrl: HONO_SERVER_URL
  });

  // Validate HONO_SERVER_URL is configured
  if (!HONO_SERVER_URL) {
    console.error('HONO_SERVER_URL environment variable not set');
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Proxy configuration error',
        message: 'HONO_SERVER_URL not configured',
        requestId: context.requestId
      })
    };
  }

  try {
    // Build target URL with query string
    const queryString = event.rawQueryString || '';
    const targetUrl = `${HONO_SERVER_URL}${path}${queryString ? `?${queryString}` : ''}`;

    console.log('Forwarding request to Hono server', {
      requestId: context.requestId,
      targetUrl,
      method
    });

    // Prepare headers for forwarding
    // Remove AWS-specific headers and add forwarding headers
    const forwardHeaders: Record<string, string> = {};

    if (event.headers) {
      Object.entries(event.headers).forEach(([key, value]) => {
        // Skip AWS-specific headers
        const lowerKey = key.toLowerCase();
        if (lowerKey.startsWith('x-amz') || lowerKey.startsWith('x-forwarded') || lowerKey === 'host') {
          return;
        }

        if (value) {
          forwardHeaders[key] = value;
        }
      });
    }

    // Add X-Forwarded headers for origin tracking
    forwardHeaders['X-Forwarded-For'] = event.requestContext.http.sourceIp;
    forwardHeaders['X-Forwarded-Proto'] = 'https';
    forwardHeaders['X-Original-Host'] = event.requestContext.domainName;
    forwardHeaders['X-Request-Id'] = context.requestId;

    // Prepare fetch options
    const fetchOptions: RequestInit = {
      method,
      headers: forwardHeaders,
      // Don't follow redirects automatically - let the client handle them
      redirect: 'manual'
    };

    // Add body for POST, PUT, PATCH requests
    if (event.body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      if (event.isBase64Encoded) {
        // Decode base64 body
        fetchOptions.body = Buffer.from(event.body, 'base64').toString('utf-8');
      } else {
        fetchOptions.body = event.body;
      }
    }

    // Forward request to Hono server
    const response = await fetch(targetUrl, fetchOptions);

    // Read response body
    const responseBody = await response.text();

    // Build response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      // Skip headers that shouldn't be forwarded
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'transfer-encoding' || lowerKey === 'connection' || lowerKey === 'keep-alive') {
        return;
      }

      responseHeaders[key] = value;
    });

    // Add proxy headers for debugging
    responseHeaders['X-ClassroomIO-Proxy'] = 'hono-proxy';
    responseHeaders['X-ClassroomIO-Proxy-Duration'] = `${Date.now() - startTime}ms`;

    const result: APIGatewayProxyResultV2 = {
      statusCode: response.status,
      headers: responseHeaders,
      body: responseBody
    };

    console.log('Hono proxy response', {
      requestId: context.requestId,
      statusCode: response.status,
      durationMs: Date.now() - startTime,
      bodyLength: responseBody.length
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;

    console.error('Hono proxy error', {
      requestId: context.requestId,
      path,
      method,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    // Return 502 Bad Gateway for upstream errors
    return {
      statusCode: 502,
      headers: {
        'Content-Type': 'application/json',
        'X-ClassroomIO-Proxy': 'hono-proxy',
        'X-ClassroomIO-Proxy-Error': 'true'
      },
      body: JSON.stringify({
        error: 'Bad Gateway',
        message: 'Failed to forward request to Hono server',
        details: error instanceof Error ? error.message : 'Unknown error',
        requestId: context.requestId
      })
    };
  }
}
