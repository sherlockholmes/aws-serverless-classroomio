/**
 * Course Listing Lambda Function
 *
 * Task 13.1: Implement course listing Lambda
 * Requirements: 9.1, 18.1
 * Design: Performance Design § Database Query Performance
 *
 * This Lambda function handles GET /course requests and returns paginated course lists
 * with organization filtering. It supports:
 * - Pagination (page, limit query params)
 * - Organization filtering by orgId
 * - CloudWatch custom metrics for request tracking
 * - Connection reuse across Lambda invocations
 *
 * Performance targets:
 * - p95 response time < 500ms
 * - Cold start < 3s
 * - Database connection reuse for warm starts
 */

import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CloudWatch } from '@aws-sdk/client-cloudwatch';

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
 * Query layer: Get paginated courses by organization with metadata
 *
 * Requirements: 9.1, 18.1
 * Design: Performance Design § Database Query Performance
 *
 * Uses raw SQL for performance and to avoid schema dependencies
 */
async function getCoursesByOrganization(
  orgId: string,
  page: number,
  limit: number
): Promise<{ courses: any[]; total: number }> {
  const db = getDbClient();
  const offset = (page - 1) * limit;

  try {
    // Count total courses for pagination metadata
    const countQuery = sql`
      SELECT COUNT(*) as count
      FROM course c
      INNER JOIN "group" g ON c.group_id = g.id
      WHERE g.organization_id = ${orgId}
        AND c.status = 'ACTIVE'
    `;

    const countResult = await db.execute(countQuery);
    const totalCourses = Number(countResult.rows[0]?.count || 0);

    // Get paginated courses with lesson and exercise counts
    const coursesQuery = sql`
      SELECT 
        c.id,
        c.title,
        c.description,
        c.slug,
        c.logo,
        c.banner_image as "bannerImage",
        c.is_published as "isPublished",
        c.type,
        c.cost,
        c.currency,
        c.created_at as "createdAt",
        c.updated_at as "updatedAt",
        COUNT(DISTINCT l.id) as "lessonCount",
        (
          SELECT COUNT(*)
          FROM exercise ex
          LEFT JOIN lesson el ON el.id = ex.lesson_id
          WHERE ex.course_id = c.id OR el.course_id = c.id
        ) as "exerciseCount"
      FROM course c
      INNER JOIN "group" g ON c.group_id = g.id
      LEFT JOIN lesson l ON c.id = l.course_id
      WHERE g.organization_id = ${orgId}
        AND c.status = 'ACTIVE'
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    const coursesResult = await db.execute(coursesQuery);

    const courses = coursesResult.rows.map((row: any) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      slug: row.slug,
      logo: row.logo,
      bannerImage: row.bannerImage,
      isPublished: row.isPublished,
      type: row.type,
      cost: Number(row.cost),
      currency: row.currency,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lessonCount: Number(row.lessonCount),
      exerciseCount: Number(row.exerciseCount)
    }));

    return {
      courses,
      total: totalCourses
    };
  } catch (error) {
    console.error('getCoursesByOrganization error:', error);
    throw new Error(
      `Failed to get courses for organization "${orgId}": ${error instanceof Error ? error.message : 'Unknown error'}`
    );
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
              Value: 'course-listing'
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
 * Parse and validate pagination parameters
 */
function parsePaginationParams(queryParams: Record<string, string | undefined> | undefined): {
  page: number;
  limit: number;
} {
  const page = Math.max(1, Number(queryParams?.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(queryParams?.limit) || 20));

  return { page, limit };
}

/**
 * Lambda handler
 *
 * Handles GET /course?page=1&limit=20&orgId=<uuid>
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();

  console.log('Course listing Lambda invoked');
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Extract orgId from query parameters or headers
    const orgId = event.queryStringParameters?.orgId || event.headers?.['x-org-id'];

    if (!orgId) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          error: 'Missing required parameter: orgId'
        })
      };
    }

    // Parse pagination parameters
    const { page, limit } = parsePaginationParams(event.queryStringParameters);

    console.log(`Fetching courses for org ${orgId} (page ${page}, limit ${limit})`);

    // Query courses from database
    const { courses, total } = await getCoursesByOrganization(orgId, page, limit);

    // Calculate pagination metadata
    const totalPages = Math.ceil(total / limit);

    // Publish custom metric
    await publishMetric('CourseListingRequests', 1);

    const duration = Date.now() - startTime;
    console.log(`Course listing completed in ${duration}ms - ${courses.length} courses returned`);

    // Return response
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        data: courses,
        pagination: {
          page,
          limit,
          total,
          totalPages
        },
        meta: {
          duration: `${duration}ms`
        }
      })
    };
  } catch (error) {
    console.error('Course listing Lambda error:', error);

    // Publish error metric
    await publishMetric('CourseListingErrors', 1);

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
