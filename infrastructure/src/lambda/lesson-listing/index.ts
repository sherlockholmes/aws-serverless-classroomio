/**
 * Lesson Listing Lambda Function
 *
 * Task 15.1: Implement lesson listing Lambda
 * Requirements: 9.2, 18.2
 * Design: Components § Lambda Functions § Lesson Handler
 *
 * This Lambda function handles GET /course/:id/lessons requests and returns lesson lists
 * for a specific course. It supports:
 * - Lesson ordering (by lesson.order field, fallback to created_at)
 * - User enrollment filtering (enrolled users see all, non-enrolled see only public lessons)
 * - Progress indicators for enrolled users
 * - Section grouping if lessons have section_id
 * - CloudWatch custom metrics for request tracking
 * - Connection reuse across Lambda invocations
 *
 * Performance targets:
 * - p95 response time < 500ms (Requirement 18.2)
 * - Cold start < 3s
 * - Database connection reuse for warm starts
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
 * Interface for lesson with progress
 */
interface LessonWithProgress {
  id: string;
  title: string;
  slug: string;
  order: number;
  isUnlocked: boolean;
  public: boolean;
  hasVideo: boolean;
  hasDocuments: boolean;
  createdAt: string;
  sectionId: string | null;
  sectionTitle?: string | null;
  progress?: {
    isComplete: boolean;
    percentComplete: number;
  };
}

/**
 * Check if user is enrolled in course
 */
async function isUserEnrolled(courseId: string, userId: string): Promise<boolean> {
  const db = getDbClient();

  try {
    const enrollmentQuery = sql`
      SELECT EXISTS(
        SELECT 1
        FROM groupmember gm
        INNER JOIN course c ON c.group_id = gm.group_id
        WHERE c.id = ${courseId}
          AND gm.profile_id = ${userId}
      ) as enrolled
    `;

    const result = await db.execute(enrollmentQuery);
    return result.rows[0]?.enrolled === true;
  } catch (error) {
    console.error('isUserEnrolled error:', error);
    return false;
  }
}

/**
 * Query layer: Get lessons for a course with progress indicators
 *
 * Requirements: 9.2, 18.2
 * Design: Components § Lambda Functions § Lesson Handler
 *
 * Uses raw SQL for performance and to avoid schema dependencies
 */
async function getLessonsForCourse(
  courseId: string,
  userId: string | null,
  isEnrolled: boolean
): Promise<LessonWithProgress[]> {
  const db = getDbClient();

  try {
    // Build the lessons query
    // If user is not enrolled, only show public lessons
    const visibilityFilter = isEnrolled ? sql`` : sql`AND l.public = true`;

    // Query lessons with section information and progress
    const lessonsQuery = sql`
      SELECT 
        l.id,
        l.title,
        l.slug,
        l.order,
        l.is_unlocked as "isUnlocked",
        l.public,
        l.videos,
        l.documents,
        l.created_at as "createdAt",
        l.section_id as "sectionId",
        cs.title as "sectionTitle",
        ${isEnrolled && userId ? sql`lc.is_complete as "isComplete"` : sql`NULL as "isComplete"`}
      FROM lesson l
      LEFT JOIN course_section cs ON l.section_id = cs.id
      ${isEnrolled && userId ? sql`LEFT JOIN lesson_completion lc ON l.id = lc.lesson_id AND lc.profile_id = ${userId}` : sql``}
      WHERE l.course_id = ${courseId}
        ${visibilityFilter}
      ORDER BY l.order ASC NULLS LAST, l.created_at ASC
    `;

    const result = await db.execute(lessonsQuery);

    const lessons: LessonWithProgress[] = result.rows.map((row: any) => {
      const lesson: LessonWithProgress = {
        id: row.id,
        title: row.title,
        slug: row.slug,
        order: row.order !== null ? Number(row.order) : 0,
        isUnlocked: row.isUnlocked,
        public: row.public,
        hasVideo: Array.isArray(row.videos) && row.videos.length > 0,
        hasDocuments: Array.isArray(row.documents) && row.documents.length > 0,
        createdAt: row.createdAt,
        sectionId: row.sectionId,
        sectionTitle: row.sectionTitle
      };

      // Add progress information if user is enrolled
      if (isEnrolled && userId) {
        lesson.progress = {
          isComplete: row.isComplete === true,
          percentComplete: row.isComplete === true ? 100 : 0
        };
      }

      return lesson;
    });

    return lessons;
  } catch (error) {
    console.error('getLessonsForCourse error:', error);
    throw new Error(
      `Failed to get lessons for course "${courseId}": ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Verify course exists
 */
async function verifyCourseExists(courseId: string): Promise<boolean> {
  const db = getDbClient();

  try {
    const courseQuery = sql`
      SELECT EXISTS(
        SELECT 1
        FROM course c
        WHERE c.id = ${courseId}
          AND c.status = 'ACTIVE'
      ) as exists
    `;

    const result = await db.execute(courseQuery);
    return result.rows[0]?.exists === true;
  } catch (error) {
    console.error('verifyCourseExists error:', error);
    return false;
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
              Value: 'lesson-listing'
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
 * Handles GET /course/{id}/lessons
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();

  console.log('Lesson listing Lambda invoked');
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

    // Extract user ID from Authorization header (optional)
    const userId = await getSessionUserId(event);

    console.log(`Fetching lessons for course ${courseId} (userId: ${userId || 'anonymous'})`);

    // Verify course exists
    const courseExists = await verifyCourseExists(courseId);

    if (!courseExists) {
      await publishMetric('LessonListingCourseNotFound', 1);

      return {
        statusCode: 404,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          error: 'Course not found'
        })
      };
    }

    // Check enrollment status if user is authenticated
    const isEnrolled = userId ? await isUserEnrolled(courseId, userId) : false;

    console.log(`User enrollment status: ${isEnrolled ? 'enrolled' : 'not enrolled'}`);

    // Query lessons from database
    const lessons = await getLessonsForCourse(courseId, userId, isEnrolled);

    // Publish custom metric
    await publishMetric('LessonListingRequests', 1);

    const duration = Date.now() - startTime;
    console.log(`Lesson listing completed in ${duration}ms - ${lessons.length} lessons returned`);

    // Return response
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        data: lessons,
        meta: {
          courseId,
          isEnrolled,
          totalLessons: lessons.length,
          duration: `${duration}ms`
        }
      })
    };
  } catch (error) {
    console.error('Lesson listing Lambda error:', error);

    // Publish error metric
    await publishMetric('LessonListingErrors', 1);

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
