/**
 * Migration Router Lambda
 *
 * Task 9.1: Implement migration routing logic
 * Requirements: 3.1, 3.2, 3.3, 3.6
 *
 * This Lambda function implements the strangler fig pattern for gradual migration:
 * 1. Receives ALL /{proxy+} requests from API Gateway
 * 2. Queries migration-routes DynamoDB table for route configuration
 * 3. Implements longest prefix matching algorithm
 * 4. Routes to Lambda function OR Hono proxy based on config
 * 5. Supports canary traffic splitting (probabilistic routing)
 * 6. Logs all routing decisions to CloudWatch
 *
 * DynamoDB Schema (migration-routes table):
 * - path (partition key): Route path pattern (e.g., /course, /course/:id, /lesson/:id)
 * - target: "lambda" | "hono-proxy" | "canary"
 * - canaryPercentage: 0-100 (only used when target === "canary")
 * - lambdaFunctionName: Name of Lambda to invoke (when target === "lambda")
 * - enabled: boolean
 * - lastUpdated: ISO timestamp
 *
 * Example routing decisions:
 * - GET /course/123 with target="lambda" → invoke course-handler Lambda
 * - POST /assignment/456 with target="hono-proxy" → forward to Hono server
 * - GET /lesson/789 with target="canary", canaryPercentage=10 → 10% to Lambda, 90% to Hono
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// Initialize AWS clients (reused across warm invocations)
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

// Environment variables
const MIGRATION_ROUTES_TABLE = process.env.MIGRATION_ROUTES_TABLE || '';
const HONO_PROXY_FUNCTION_NAME = process.env.HONO_PROXY_FUNCTION_NAME || '';

/**
 * Route configuration from DynamoDB
 */
interface RouteConfig {
  path: string;
  target: 'lambda' | 'hono-proxy' | 'canary';
  canaryPercentage?: number;
  lambdaFunctionName?: string;
  enabled: number; // 0 = disabled, 1 = enabled (DynamoDB NUMBER for GSI)
  lastUpdated: string;
}

/**
 * Routing decision result
 */
interface RoutingDecision {
  matchedPath: string;
  target: 'lambda' | 'hono-proxy';
  lambdaFunctionName?: string;
  canaryDecision?: {
    percentage: number;
    randomValue: number;
    routedToLambda: boolean;
  };
}

/**
 * Lambda handler - receives ALL /{proxy+} requests
 */
export async function handler(event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();
  const requestPath = event.rawPath || '/';
  const method = event.requestContext.http.method;

  console.log('Migration Router invoked', {
    requestId: context.requestId,
    path: requestPath,
    method,
    headers: event.headers
  });

  try {
    // 1. Query DynamoDB for route configuration using longest prefix match
    const routingDecision = await determineRouting(requestPath);

    console.log('Routing decision made', {
      requestId: context.requestId,
      path: requestPath,
      decision: routingDecision,
      durationMs: Date.now() - startTime
    });

    // 2. Route to target (Lambda or Hono proxy)
    const response = await routeRequest(event, context, routingDecision);

    // 3. Add routing headers for debugging
    return {
      ...response,
      headers: {
        ...response.headers,
        'X-ClassroomIO-Router': 'migration-router',
        'X-ClassroomIO-Target': routingDecision.target,
        'X-ClassroomIO-Matched-Path': routingDecision.matchedPath,
        ...(routingDecision.canaryDecision && {
          'X-ClassroomIO-Canary-Percentage': String(routingDecision.canaryDecision.percentage),
          'X-ClassroomIO-Canary-Decision': routingDecision.canaryDecision.routedToLambda ? 'lambda' : 'hono-proxy'
        })
      }
    };
  } catch (error) {
    console.error('Routing error', {
      requestId: context.requestId,
      path: requestPath,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Internal routing error',
        message: error instanceof Error ? error.message : 'Unknown error',
        requestId: context.requestId
      })
    };
  }
}

/**
 * Determine routing based on longest prefix match in DynamoDB
 */
async function determineRouting(requestPath: string): Promise<RoutingDecision> {
  // Query all route configurations from DynamoDB
  // In production, consider caching this with short TTL (e.g., 30 seconds)
  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: MIGRATION_ROUTES_TABLE,
      IndexName: 'enabled-index', // GSI for efficient queries
      KeyConditionExpression: 'enabled = :enabled',
      ExpressionAttributeValues: {
        ':enabled': 1 // Query only enabled routes (1 = true)
      }
    })
  );

  const routes = (result.Items || []) as RouteConfig[];

  // Perform longest prefix match
  let bestMatch: RouteConfig | null = null;
  let longestMatchLength = 0;

  for (const route of routes) {
    // Convert route pattern to regex (e.g., /course/:id → /course/[^/]+)
    const pattern = route.path
      .replace(/:[^/]+/g, '[^/]+') // Replace :id with regex
      .replace(/\*/g, '.*'); // Replace * with wildcard

    const regex = new RegExp(`^${pattern}$`);

    if (regex.test(requestPath) && route.path.length > longestMatchLength) {
      bestMatch = route;
      longestMatchLength = route.path.length;
    }
  }

  // If no match found, default to Hono proxy (legacy behavior)
  if (!bestMatch) {
    console.log('No route match found, defaulting to Hono proxy', {
      requestPath,
      availableRoutes: routes.map((r) => r.path)
    });

    return {
      matchedPath: '/*',
      target: 'hono-proxy'
    };
  }

  // Handle canary traffic splitting
  if (bestMatch.target === 'canary') {
    const canaryPercentage = bestMatch.canaryPercentage || 0;
    const randomValue = Math.random() * 100;
    const routeToLambda = randomValue < canaryPercentage;

    return {
      matchedPath: bestMatch.path,
      target: routeToLambda ? 'lambda' : 'hono-proxy',
      lambdaFunctionName: routeToLambda ? bestMatch.lambdaFunctionName : undefined,
      canaryDecision: {
        percentage: canaryPercentage,
        randomValue,
        routedToLambda
      }
    };
  }

  // Handle direct Lambda routing
  if (bestMatch.target === 'lambda') {
    return {
      matchedPath: bestMatch.path,
      target: 'lambda',
      lambdaFunctionName: bestMatch.lambdaFunctionName
    };
  }

  // Handle Hono proxy routing
  return {
    matchedPath: bestMatch.path,
    target: 'hono-proxy'
  };
}

/**
 * Route request to target Lambda function
 */
async function routeRequest(
  event: APIGatewayProxyEventV2,
  context: Context,
  decision: RoutingDecision
): Promise<APIGatewayProxyResultV2> {
  const targetFunction = decision.target === 'lambda' ? decision.lambdaFunctionName! : HONO_PROXY_FUNCTION_NAME;

  console.log('Invoking target Lambda', {
    requestId: context.requestId,
    targetFunction,
    target: decision.target
  });

  // Invoke target Lambda function
  const invokeResult = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: targetFunction,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify(event)
    })
  );

  // Parse Lambda response
  if (!invokeResult.Payload) {
    throw new Error('No payload returned from target Lambda');
  }

  const responsePayload = JSON.parse(new TextDecoder().decode(invokeResult.Payload)) as APIGatewayProxyResultV2;

  // Check for Lambda execution errors
  if (invokeResult.FunctionError) {
    console.error('Target Lambda execution error', {
      requestId: context.requestId,
      functionError: invokeResult.FunctionError,
      response: responsePayload
    });

    return {
      statusCode: 502,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Target function error',
        message: 'The target Lambda function encountered an error',
        requestId: context.requestId
      })
    };
  }

  return responsePayload;
}
