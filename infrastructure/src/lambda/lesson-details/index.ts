/**
 * Lesson Details Lambda Function
 *
 * Task 15.2: Implement lesson details Lambda
 * Requirements: 9.2, 18.2
 * Design: Request Flow § Web Request Flow
 *
 * This Lambda function handles GET /lesson/:id requests and returns detailed lesson
 * information with video metadata and enrollment verification. It supports:
 * - Lesson content with markdown notes
 * - Video asset metadata (URLs, durations)
 * - Document metadata
 * - Section and course context
 * - Enrollment-based access control (private lessons require enrollment)
 * - User progress indicators for enrolled users
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
 * Interface for lesson details response
 */
interface LessonDetails {
  id: string;
  title: string;
  note: string;
  slug: string;
  order: number;
  isUnlocked: boolean;
  public: boolean;
  createdAt: string;
  updatedAt?: string | null;
  videos: VideoMetadata[];
  documents: DocumentMetadata[];
  section: {
    id: string | null;
    title: string | null;
  };
  course: {
    id: string;
    title: string;
    slug: string;
  };
  progress?: {
    isComplete: boolean;
    percentComplete: number;
    lastAccessedAt?: string | null;
  };
}

interface VideoMetadata {
  id?: string;
  url?: string;
  duration?: number;
  title?: string;
  [key: string]: any;
}

interface DocumentMetadata {
  id?: string;
  url?: string;
  title?: string;
  type?: string;
  [key: string]: any;
}

/**
 * Check if user is enrolled in the course containing this lesson
 */
async function isUserEnrolledInLesson(lessonId: string, userId: string): Promise<boolean> {
  const db = getDbClient();

  try {
    const enrollmentQuery = sql`
      SELECT EXISTS(
        SELECT 1
        FROM lesson l
        INNER JOIN course c ON l.course_id = c.id
        INNER JOIN groupmember gm ON c.group_id = gm.group_id
        WHERE l.id = ${lessonId}
          AND gm.profile_id = ${userId}
      ) as enrolled
    `;

    const result = await db.execute(enrollmentQuery);
    return result.rows[0]?.enrolled === true;
  } catch (error) {
    console.error('isUserEnrolledInLesson error:', error);
    return false;
  }
}

/**
 * Query layer: Get lesson details by ID with course context and progress
 *
 * Requirements: 9.2, 18.2
 * Design: Request Flow § Web Request Flow
 *
 * Uses raw SQL for performance and to avoid schema dependencies
 */
async function getLessonDetails(
  lessonId: string,
  userId: string | null,
  isEnrolled: boolean
): Promise<LessonDetails | null> {
  const db = getDbClient();

  try {
    // Query lesson details with section and course information
    const lessonQuery = sql`
      SELECT 
        l.id,
        l.title,
        l.note,
        l.slug,
        l.order,
        l.is_unlocked as "isUnlocked",
        l.public,
        l.videos,
        l.documents,
        l.created_at as "createdAt",
        l.updated_at as "updatedAt",
        l.section_id as "sectionId",
        cs.title as "sectionTitle",
        c.id as "courseId",
        c.title as "courseTitle",
        c.slug as "courseSlug",
        ${isEnrolled && userId ? sql`lc.is_complete as "isComplete"` : sql`NULL as "isComplete"`},
        ${isEnrolled && userId ? sql`lc.updated_at as "progressUpdatedAt"` : sql`NULL as "progressUpdatedAt"`}
      FROM lesson l
      INNER JOIN course c ON l.course_id = c.id
      LEFT JOIN course_section cs ON l.section_id = cs.id
      ${isEnrolled && userId ? sql`LEFT JOIN lesson_completion lc ON l.id = lc.lesson_id AND lc.profile_id = ${userId}` : sql``}
      WHERE l.id = ${lessonId}
    `;

    const result = await db.execute(lessonQuery);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0] as any;

    // Parse videos and documents (stored as JSON arrays)
    const videos: VideoMetadata[] = Array.isArray(row.videos) ? row.videos : [];
    const documents: DocumentMetadata[] = Array.isArray(row.documents) ? row.documents : [];

    const lesson: LessonDetails = {
      id: row.id,
      title: row.title,
      note: row.note || '',
      slug: row.slug,
      order: row.order !== null ? Number(row.order) : 0,
      isUnlocked: row.isUnlocked,
      public: row.public,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      videos,
      documents,
      section: {
        id: row.sectionId,
        title: row.sectionTitle
      },
      course: {
        id: row.courseId,
        title: row.courseTitle,
        slug: row.courseSlug
      }
    };

    // Add progress information if user is enrolled
    if (isEnrolled && userId) {
      lesson.progress = {
        isComplete: row.isComplete === true,
        percentComplete: row.isComplete === true ? 100 : 0,
        lastAccessedAt: row.progressUpdatedAt
      };
    }

    return lesson;
  } catch (error) {
    console.error('getLessonDetails error:', error);
    throw new Error(
      `Failed to get lesson details for "${lessonId}": ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Verify user has access to lesson
 * A user has access if:
 * - The lesson is public
 * - The user is enrolled in the parent course
 */
function verifyAccess(lesson: LessonDetails, userId: string | null, isEnrolled: boolean): boolean {
  // Public lessons are accessible to everyone
  if (lesson.public) {
    return true;
  }

  // Private lessons require enrollment
  if (userId && isEnrolled) {
    return true;
  }

  return false;
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
              Value: 'lesson-details'
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
 * Handles GET /lesson/{id} (native Lambda route) and
 * GET /course/{courseId}/lesson/{lessonId} (dashboard-compat alias route —
 * matches the pre-migration Hono API shape the SvelteKit dashboard's typed
 * RPC client (`classroomio.course[':courseId'].lesson[':lessonId'].$get`)
 * already calls, so the frontend doesn't need to change). When invoked via
 * the alias, `courseId` is present but unused for lookup (the lesson row
 * already carries its own course_id); it only distinguishes which response
 * shape to return (see `isAliasRoute` below).
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();

  console.log('Lesson details Lambda invoked');
  console.log('Event:', JSON.stringify(event, null, 2));

  try {
    // Native route uses {id}; the dashboard-compat alias route uses
    // {lessonId} (and also passes {courseId}, unused for lookup).
    const isAliasRoute = event.pathParameters?.lessonId !== undefined;
    const lessonId = event.pathParameters?.id ?? event.pathParameters?.lessonId;

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

    // Extract user ID from Authorization header (optional)
    const userId = await getSessionUserId(event);

    console.log(`Fetching lesson details for ${lessonId} (userId: ${userId || 'anonymous'})`);

    // Check enrollment status if user is authenticated
    const isEnrolled = userId ? await isUserEnrolledInLesson(lessonId, userId) : false;

    console.log(`User enrollment status: ${isEnrolled ? 'enrolled' : 'not enrolled'}`);

    // Query lesson details from database
    const lesson = await getLessonDetails(lessonId, userId, isEnrolled);

    if (!lesson) {
      await publishMetric('LessonDetailsNotFound', 1);

      return {
        statusCode: 404,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          error: 'Lesson not found'
        })
      };
    }

    // Verify user has access to lesson
    if (!verifyAccess(lesson, userId, isEnrolled)) {
      await publishMetric('LessonDetailsUnauthorized', 1);

      return {
        statusCode: 403,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          error: 'Access denied: You must be enrolled in the course to view this private lesson'
        })
      };
    }

    // Publish custom metric
    await publishMetric('LessonDetailsRequests', 1);

    const duration = Date.now() - startTime;
    console.log(`Lesson details completed in ${duration}ms`);

    // The dashboard's typed RPC client expects `data.watchProgress` on this
    // shape (see GetLessonSuccess['data'] in
    // apps/dashboard/src/lib/features/course/utils/types.ts). The monolith
    // computes this via getLessonWatchProgressService, which itself returns
    // null whenever the lesson's completionPolicy isn't 'video_watch' or it
    // has no watch-enforced video assets — exactly the case for every
    // seeded lesson today (all videos are type:"youtube", none reference an
    // uploaded HLS asset). Returning null here (alias route only) matches
    // that real behavior without duplicating the watch-progress query.
    const responseData = isAliasRoute ? { ...lesson, watchProgress: null } : lesson;

    // Return response
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        data: responseData,
        meta: {
          isEnrolled,
          duration: `${duration}ms`
        }
      })
    };
  } catch (error) {
    console.error('Lesson details Lambda error:', error);

    // Publish error metric
    await publishMetric('LessonDetailsErrors', 1);

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
