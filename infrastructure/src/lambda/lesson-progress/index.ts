/**
 * Lesson Progress Tracking Lambda Function
 *
 * Task 15.3: Implement lesson progress tracking Lambda
 * Requirements: 9.2, 10.2
 * Design: Components § Lambda Functions § Lesson Handler
 *
 * This Lambda function handles POST /lesson/:id/progress requests and creates/updates
 * progress records in the lesson_completion table. It supports:
 * - User authentication and authorization validation
 * - Enrollment verification (403 if user not enrolled in parent course)
 * - Progress record upsert (INSERT ... ON CONFLICT ... DO UPDATE)
 * - Completion percentage tracking (0-100)
 * - CloudWatch custom metrics for lesson completions
 * - Connection reuse across Lambda invocations
 *
 * Performance targets:
 * - p95 response time < 1000ms
 * - Cold start < 3s
 * - Database connection reuse for warm starts
 *
 * Database Schema:
 * - lesson_completion table: id, lesson_id, profile_id, is_complete, created_at, updated_at
 * - Unique constraint: (lesson_id, profile_id) prevents duplicate records
 * - lesson table: id, course_id (to find parent course)
 * - course table: id, group_id (for enrollment check)
 * - groupmember table: tracks enrollment (profile_id, group_id, role_id=3 for students)
 */

import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CloudWatch } from '@aws-sdk/client-cloudwatch';
import { getSessionUserId } from '../_shared/session';

// Configure WebSocket for Neon in Lambda environment
neonConfig.webSocketConstructor = ws;

// Connection pool is created outside the handler
// This allows connection reuse across Lambda invocations
let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

// CloudWatch client for custom metrics
const cloudwatch = new CloudWatch({ region: process.env.REGION || 'us-east-1' });

/**
 * Initialize connection pool and Drizzle client (lazy initialization)
 */
function getDbClient() {
  if (!pool || !db) {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    console.log('Creating new Neon connection pool');

    pool = new Pool({
      connectionString,
      max: 1, // Lambda = 1 concurrent execution per container
      idleTimeoutMillis: 0, // Never close idle connections (reuse across invocations)
      connectionTimeoutMillis: Number(process.env.CONNECTION_TIMEOUT_MS) || 10000
    });

    db = drizzle(pool);
  }

  return db;
}

/**
 * Interface for progress update request body
 */
interface ProgressUpdateRequest {
  percentComplete: number; // 0-100
  isComplete: boolean;
}

/**
 * Interface for progress result
 */
interface ProgressResult {
  lessonId: string;
  userId: string;
  percentComplete: number;
  isComplete: boolean;
  lastUpdatedAt: string;
  isNewRecord: boolean;
}

/**
 * Validate progress update request body
 */
function validateProgressRequest(body: any): { valid: boolean; error?: string; data?: ProgressUpdateRequest } {
  if (!body) {
    return { valid: false, error: 'Request body is required' };
  }

  const { percentComplete, isComplete } = body;

  // Validate percentComplete
  if (typeof percentComplete !== 'number') {
    return { valid: false, error: 'percentComplete must be a number' };
  }

  if (percentComplete < 0 || percentComplete > 100) {
    return { valid: false, error: 'percentComplete must be between 0 and 100' };
  }

  // Validate isComplete
  if (typeof isComplete !== 'boolean') {
    return { valid: false, error: 'isComplete must be a boolean' };
  }

  // Business rule: isComplete should be true when percentComplete is 100
  if (percentComplete === 100 && !isComplete) {
    return { valid: false, error: 'isComplete must be true when percentComplete is 100' };
  }

  return {
    valid: true,
    data: {
      percentComplete,
      isComplete
    }
  };
}

/**
 * Query layer: Verify user enrollment in parent course
 *
 * Checks if the user is enrolled in the course that contains this lesson.
 * This prevents unauthorized progress updates.
 *
 * @param lessonId - The lesson ID
 * @param userId - The user's profile ID
 * @returns true if enrolled, false otherwise
 */
async function verifyEnrollment(lessonId: string, userId: string): Promise<boolean> {
  const db = getDbClient();

  try {
    // Check enrollment by joining lesson -> course -> group -> groupmember
    const enrollmentQuery = sql`
      SELECT 
        gm.id as "enrollmentId"
      FROM lesson l
      INNER JOIN course c ON l.course_id = c.id
      INNER JOIN "group" g ON c.group_id = g.id
      INNER JOIN groupmember gm ON g.id = gm.group_id
      WHERE l.id = ${lessonId}
        AND gm.profile_id = ${userId}
        AND gm.role_id = 3
      LIMIT 1
    `;

    const result = await db.execute(enrollmentQuery);

    return result.rows.length > 0;
  } catch (error) {
    console.error('verifyEnrollment error:', error);
    throw new Error(`Failed to verify enrollment: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Query layer: Update or create progress record
 *
 * Requirements: 9.2, 10.2
 * Design: Components § Lambda Functions § Lesson Handler
 *
 * Uses PostgreSQL UPSERT pattern (INSERT ... ON CONFLICT ... DO UPDATE)
 * to handle both new records and updates to existing records.
 *
 * The unique constraint (lesson_id, profile_id) ensures one progress record
 * per user per lesson.
 *
 * @param lessonId - The lesson ID
 * @param userId - The user's profile ID
 * @param percentComplete - Completion percentage (0-100)
 * @param isComplete - Whether lesson is complete
 * @returns Progress result with metadata
 * @throws Error if update fails
 */
async function upsertProgress(
  lessonId: string,
  userId: string,
  percentComplete: number,
  isComplete: boolean
): Promise<ProgressResult> {
  const db = getDbClient();

  try {
    // First, check if record exists
    const existingQuery = sql`
      SELECT 
        id,
        is_complete as "isComplete",
        created_at as "createdAt"
      FROM lesson_completion
      WHERE lesson_id = ${lessonId}
        AND profile_id = ${userId}
    `;

    const existingResult = await db.execute(existingQuery);
    const isNewRecord = existingResult.rows.length === 0;

    // UPSERT pattern: INSERT ... ON CONFLICT ... DO UPDATE
    const upsertQuery = sql`
      INSERT INTO lesson_completion (lesson_id, profile_id, is_complete, updated_at)
      VALUES (${lessonId}, ${userId}, ${isComplete}, NOW())
      ON CONFLICT (lesson_id, profile_id)
      DO UPDATE SET
        is_complete = EXCLUDED.is_complete,
        updated_at = NOW()
      RETURNING 
        lesson_id as "lessonId",
        profile_id as "profileId",
        is_complete as "isComplete",
        updated_at as "updatedAt"
    `;

    const result = await db.execute(upsertQuery);

    if (result.rows.length === 0) {
      throw new Error('Failed to upsert progress record');
    }

    const progress = result.rows[0] as any;

    console.log(
      `Successfully ${isNewRecord ? 'created' : 'updated'} progress for user ${userId} on lesson ${lessonId}`
    );

    return {
      lessonId: progress.lessonId,
      userId: progress.profileId,
      percentComplete,
      isComplete: progress.isComplete,
      lastUpdatedAt: progress.updatedAt,
      isNewRecord
    };
  } catch (error) {
    console.error('upsertProgress error:', error);

    throw new Error(`Failed to upsert progress: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Publish CloudWatch custom metric
 */
async function publishMetric(metricName: string, value: number, unit: string = 'Count') {
  try {
    await cloudwatch.putMetricData({
      Namespace: 'ClassroomIO/Lambda',
      MetricData: [
        {
          MetricName: metricName,
          Value: value,
          Unit: unit as any,
          Timestamp: new Date(),
          Dimensions: [
            {
              Name: 'Function',
              Value: 'lesson-progress'
            }
          ]
        }
      ]
    });
  } catch (error) {
    // Don't fail the request if metrics fail
    console.error('Failed to publish metric:', error);
  }
}

/**
 * Lambda handler
 *
 * Handles POST /lesson/{id}/progress
 *
 * Requirements:
 * - User must be authenticated (Authorization header required)
 * - User must be enrolled in the parent course (403 if not)
 * - Request body must contain valid percentComplete and isComplete
 * - Uses UPSERT to handle duplicate updates
 * - Emits CloudWatch metrics when lesson is completed (percentComplete = 100)
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();

  console.log('Lesson progress Lambda invoked');
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Extract lesson ID from path parameters
    const lessonId = event.pathParameters?.id;

    if (!lessonId) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          error: 'Missing required path parameter: id'
        })
      };
    }

    // Extract and validate user ID from Authorization header
    const userId = await getSessionUserId(event);

    if (!userId) {
      await publishMetric('LessonProgressUnauthorized', 1);

      return {
        statusCode: 401,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          error: 'Authentication required: Missing or invalid Authorization header'
        })
      };
    }

    // Parse and validate request body
    let requestBody;
    try {
      requestBody = event.body ? JSON.parse(event.body) : null;
    } catch (error) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          error: 'Invalid JSON in request body'
        })
      };
    }

    const validation = validateProgressRequest(requestBody);
    if (!validation.valid) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          error: validation.error
        })
      };
    }

    const { percentComplete, isComplete } = validation.data!;

    console.log(`Processing progress update for user ${userId} on lesson ${lessonId}: ${percentComplete}%`);

    // Verify user enrollment in parent course
    const isEnrolled = await verifyEnrollment(lessonId, userId);

    if (!isEnrolled) {
      await publishMetric('LessonProgressForbidden', 1);

      const duration = Date.now() - startTime;

      return {
        statusCode: 403,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          error: 'User is not enrolled in the parent course',
          meta: {
            duration: `${duration}ms`
          }
        })
      };
    }

    // Update or create progress record
    const progress = await upsertProgress(lessonId, userId, percentComplete, isComplete);

    // Publish metrics
    await publishMetric('LessonProgressUpdates', 1);

    // Emit completion metric when lesson is marked complete
    if (isComplete && percentComplete === 100) {
      await publishMetric('LessonCompletions', 1);
      console.log(`Lesson ${lessonId} completed by user ${userId}`);
    }

    const duration = Date.now() - startTime;
    console.log(`Lesson progress update completed in ${duration}ms`);

    // Return success response
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        message: progress.isNewRecord ? 'Progress recorded' : 'Progress updated',
        data: {
          lessonId: progress.lessonId,
          userId: progress.userId,
          percentComplete: progress.percentComplete,
          isComplete: progress.isComplete,
          lastUpdatedAt: progress.lastUpdatedAt,
          isNewRecord: progress.isNewRecord
        },
        meta: {
          duration: `${duration}ms`
        }
      })
    };
  } catch (error) {
    console.error('Lesson progress Lambda error:', error);

    // Publish error metric
    await publishMetric('LessonProgressErrors', 1);

    const duration = Date.now() - startTime;

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
        meta: {
          duration: `${duration}ms`
        }
      })
    };
  }
}
