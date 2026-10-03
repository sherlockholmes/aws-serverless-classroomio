/**
 * Course Enrollment Lambda Function
 *
 * Task 13.3: Implement course enrollment Lambda
 * Requirements: 9.1, 10.2
 * Design: Components § Lambda Functions § Course Handler
 *
 * This Lambda function handles POST /course/:id/enroll requests and creates enrollment
 * records in the groupmember table. It supports:
 * - User authentication and authorization validation
 * - Enrollment record creation with role_id=3 (STUDENT)
 * - Duplicate enrollment handling (409 status)
 * - CloudWatch custom metrics for enrollment tracking
 * - Connection reuse across Lambda invocations
 *
 * Performance targets:
 * - p95 response time < 1000ms
 * - Cold start < 3s
 * - Database connection reuse for warm starts
 *
 * Database Schema:
 * - groupmember table: links profile_id to group_id with role_id
 * - role_id=3 is STUDENT role (from seed data)
 * - course.group_id links to group.id (organization group)
 * - Unique constraint: (group_id, profile_id) prevents duplicate enrollments
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
 * Interface for enrollment result
 */
interface EnrollmentResult {
  id: string;
  courseId: string;
  userId: string;
  groupId: string;
  roleId: number;
  createdAt: string;
  isNewEnrollment: boolean;
}

/**
 * Query layer: Create enrollment record in groupmember table
 *
 * Requirements: 9.1, 10.2
 * Design: Components § Lambda Functions § Course Handler
 *
 * Creates a groupmember record linking the user to the course's organization group
 * with role_id=3 (STUDENT role). Handles duplicate enrollments gracefully by
 * checking for existing records before insertion.
 *
 * @param courseId - The course ID to enroll in
 * @param userId - The user's profile ID
 * @returns Enrollment result with metadata
 * @throws Error if course not found or enrollment fails
 */
async function createEnrollment(courseId: string, userId: string): Promise<EnrollmentResult> {
  const db = getDbClient();

  try {
    // First, get the course's group_id
    const courseQuery = sql`
      SELECT 
        c.id as "courseId",
        c.group_id as "groupId",
        c.title,
        c.is_published as "isPublished",
        g.organization_id as "organizationId"
      FROM course c
      INNER JOIN "group" g ON c.group_id = g.id
      WHERE c.id = ${courseId}
        AND c.status = 'ACTIVE'
    `;

    const courseResult = await db.execute(courseQuery);

    if (courseResult.rows.length === 0) {
      throw new Error('Course not found');
    }

    const course = courseResult.rows[0] as any;

    // Check if enrollment already exists
    const existingEnrollmentQuery = sql`
      SELECT 
        id,
        created_at as "createdAt"
      FROM groupmember
      WHERE group_id = ${course.groupId}
        AND profile_id = ${userId}
        AND role_id = 3
    `;

    const existingResult = await db.execute(existingEnrollmentQuery);

    // If enrollment exists, return it with isNewEnrollment=false
    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0] as any;

      console.log(`User ${userId} already enrolled in course ${courseId}`);

      return {
        id: existing.id,
        courseId: course.courseId,
        userId,
        groupId: course.groupId,
        roleId: 3,
        createdAt: existing.createdAt,
        isNewEnrollment: false
      };
    }

    // Create new enrollment record
    // role_id=3 is STUDENT role (from seed data)
    const insertQuery = sql`
      INSERT INTO groupmember (group_id, profile_id, role_id)
      VALUES (${course.groupId}, ${userId}, 3)
      RETURNING 
        id,
        group_id as "groupId",
        profile_id as "profileId",
        role_id as "roleId",
        created_at as "createdAt"
    `;

    const insertResult = await db.execute(insertQuery);

    if (insertResult.rows.length === 0) {
      throw new Error('Failed to create enrollment record');
    }

    const enrollment = insertResult.rows[0] as any;

    console.log(`Successfully enrolled user ${userId} in course ${courseId}`);

    return {
      id: enrollment.id,
      courseId: course.courseId,
      userId: enrollment.profileId,
      groupId: enrollment.groupId,
      roleId: Number(enrollment.roleId),
      createdAt: enrollment.createdAt,
      isNewEnrollment: true
    };
  } catch (error) {
    console.error('createEnrollment error:', error);

    // Handle specific database errors
    if (error instanceof Error) {
      // Check for unique constraint violation (duplicate enrollment)
      if (error.message.includes('unique_group_profile') || error.message.includes('duplicate key')) {
        throw new Error('DUPLICATE_ENROLLMENT');
      }
    }

    throw new Error(`Failed to create enrollment: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
              Value: 'course-enrollment'
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
 * Handles POST /course/{id}/enroll
 *
 * Requirements:
 * - User must be authenticated (Authorization header required)
 * - Course must exist and be active
 * - Creates groupmember record with role_id=3 (STUDENT)
 * - Returns 409 for duplicate enrollments
 * - Emits CloudWatch custom metrics
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();

  console.log('Course enrollment Lambda invoked');
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Extract course ID from path parameters
    const courseId = event.pathParameters?.id;

    if (!courseId) {
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
      await publishMetric('CourseEnrollmentUnauthorized', 1);

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

    console.log(`Processing enrollment for user ${userId} in course ${courseId}`);

    // Create enrollment record
    const enrollment = await createEnrollment(courseId, userId);

    // If enrollment already existed, return 409 Conflict
    if (!enrollment.isNewEnrollment) {
      await publishMetric('CourseEnrollmentDuplicate', 1);

      const duration = Date.now() - startTime;

      return {
        statusCode: 409,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          error: 'User is already enrolled in this course',
          data: {
            enrollmentId: enrollment.id,
            enrolledAt: enrollment.createdAt
          },
          meta: {
            duration: `${duration}ms`
          }
        })
      };
    }

    // Publish success metrics
    await publishMetric('CourseEnrollmentSuccess', 1);
    await publishMetric('CourseEnrollmentRequests', 1);

    const duration = Date.now() - startTime;
    console.log(`Course enrollment completed in ${duration}ms`);

    // Return success response
    return {
      statusCode: 201,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        message: 'Successfully enrolled in course',
        data: {
          enrollmentId: enrollment.id,
          courseId: enrollment.courseId,
          userId: enrollment.userId,
          enrolledAt: enrollment.createdAt
        },
        meta: {
          duration: `${duration}ms`
        }
      })
    };
  } catch (error) {
    console.error('Course enrollment Lambda error:', error);

    // Publish error metric
    await publishMetric('CourseEnrollmentErrors', 1);

    const duration = Date.now() - startTime;

    // Handle specific error cases
    if (error instanceof Error) {
      if (error.message === 'Course not found') {
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            success: false,
            error: 'Course not found',
            meta: {
              duration: `${duration}ms`
            }
          })
        };
      }

      if (error.message === 'DUPLICATE_ENROLLMENT') {
        return {
          statusCode: 409,
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            success: false,
            error: 'User is already enrolled in this course',
            meta: {
              duration: `${duration}ms`
            }
          })
        };
      }
    }

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
