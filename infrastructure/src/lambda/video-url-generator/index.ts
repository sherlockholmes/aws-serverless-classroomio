/**
 * HLS Video URL Generation Lambda
 *
 * Task 20.1: Implement video URL generation Lambda
 * Requirements: 8.2, 8.3, 8.7, 18.3
 * Design: Components § S3 + CloudFront § Signed URL Generation
 *
 * Handles GET /lesson/:id/video-url. Verifies the caller's session and
 * course enrollment, resolves the lesson's HLS asset (assets.hls_manifest_key
 * via asset_usages), and returns a CloudFront-signed URL for master.m3u8
 * with a 1-hour expiration.
 *
 * Auth model: same as lesson-details/lesson-progress — Better Auth session
 * cookie validated via getSessionUserId (see ../_shared/session.ts). Public
 * lessons are viewable without enrollment; private lessons require it.
 *
 * Signing: @aws-sdk/cloudfront-signer, using the CLOUDFRONT_KEY_PAIR_ID /
 * CLOUDFRONT_PRIVATE_KEY env vars (public key lives in CDK as a CloudFront
 * PublicKey/KeyGroup — see storage-stack.ts Task 18.3; the private key is
 * injected at deploy time, mirroring the BETTER_AUTH_SECRET pattern. No
 * Secrets Manager cost incurred.)
 */

import { Pool, neonConfig } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CloudWatch } from '@aws-sdk/client-cloudwatch';
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { getSessionUserId } from '../_shared/session';

neonConfig.webSocketConstructor = ws;

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

const cloudwatch = new CloudWatch({ region: process.env.REGION || 'us-east-1' });

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour, per design § Signed URL Generation

function getDbClient() {
  if (!pool || !db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    pool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 0,
      connectionTimeoutMillis: Number(process.env.CONNECTION_TIMEOUT_MS) || 10000
    });

    db = drizzle(pool);
  }

  return db;
}

interface LessonAssetRow {
  lessonId: string;
  lessonPublic: boolean;
  courseId: string;
  groupId: string;
  hlsManifestKey: string | null;
  assetStatus: string | null;
}

/**
 * Resolve the lesson, its parent course/group (for enrollment checks), and
 * its attached HLS asset (if any) via asset_usages(target_type='lesson').
 */
async function getLessonAsset(lessonId: string): Promise<LessonAssetRow | null> {
  const db = getDbClient();

  const result = await db.execute(sql`
    SELECT
      l.id as "lessonId",
      l.public as "lessonPublic",
      l.course_id as "courseId",
      c.group_id as "groupId",
      a.hls_manifest_key as "hlsManifestKey",
      a.status as "assetStatus"
    FROM lesson l
    INNER JOIN course c ON c.id = l.course_id
    LEFT JOIN asset_usages au ON au.target_type = 'lesson' AND au.target_id = l.id::text AND au.slot_type = 'lesson_video'
    LEFT JOIN assets a ON a.id = au.asset_id
    WHERE l.id = ${lessonId}
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as unknown as LessonAssetRow;
}

async function isUserEnrolled(groupId: string, userId: string): Promise<boolean> {
  const db = getDbClient();

  const result = await db.execute(sql`
    SELECT EXISTS(
      SELECT 1 FROM groupmember gm
      WHERE gm.group_id = ${groupId} AND gm.profile_id = ${userId}
    ) as enrolled
  `);

  return result.rows[0]?.enrolled === true;
}

async function publishMetric(metricName: string, value: number = 1) {
  try {
    await cloudwatch.putMetricData({
      Namespace: 'ClassroomIO/Lambda',
      MetricData: [
        {
          MetricName: metricName,
          Value: value,
          Unit: 'Count',
          Timestamp: new Date(),
          Dimensions: [{ Name: 'Function', Value: 'video-url-generator' }]
        }
      ]
    });
  } catch (error) {
    console.error('Failed to publish metric:', error);
  }
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

/**
 * Lambda handler
 *
 * Handles GET /lesson/{id}/video-url
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const startTime = Date.now();

  try {
    const lessonId = event.pathParameters?.id;
    if (!lessonId) {
      return jsonResponse(400, { success: false, error: 'Missing required path parameter: id' });
    }

    const keyPairId = process.env.CLOUDFRONT_KEY_PAIR_ID;
    const privateKey = process.env.CLOUDFRONT_PRIVATE_KEY;
    const cdnDomain = process.env.CDN_DOMAIN;

    if (!keyPairId || !privateKey || !cdnDomain) {
      console.error(
        'Missing CloudFront signing configuration (CLOUDFRONT_KEY_PAIR_ID / CLOUDFRONT_PRIVATE_KEY / CDN_DOMAIN)'
      );
      return jsonResponse(500, { success: false, error: 'Video URL signing is not configured' });
    }

    const lessonAsset = await getLessonAsset(lessonId);

    if (!lessonAsset) {
      await publishMetric('VideoUrlLessonNotFound');
      return jsonResponse(404, { success: false, error: 'Lesson not found' });
    }

    if (!lessonAsset.hlsManifestKey || lessonAsset.assetStatus !== 'active') {
      await publishMetric('VideoUrlAssetNotAvailable');
      return jsonResponse(404, { success: false, error: 'No HLS video available for this lesson' });
    }

    // Session validation (Better Auth) — same pattern as lesson-details/lesson-progress.
    const userId = await getSessionUserId(event);

    let isEnrolled = false;
    if (userId) {
      isEnrolled = await isUserEnrolled(lessonAsset.groupId, userId);
    }

    // Public lessons are viewable by anyone; private lessons require enrollment.
    if (!lessonAsset.lessonPublic && !isEnrolled) {
      await publishMetric('VideoUrlUnauthorized');
      return jsonResponse(403, {
        success: false,
        error: 'Access denied: You must be enrolled in the course to view this video'
      });
    }

    const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);
    const manifestUrl = `https://${cdnDomain}/${lessonAsset.hlsManifestKey}`;

    const signedUrl = getSignedUrl({
      url: manifestUrl,
      keyPairId,
      privateKey,
      dateLessThan: expiresAt.toISOString()
    });

    await publishMetric('VideoUrlRequests');

    const duration = Date.now() - startTime;

    return jsonResponse(200, {
      success: true,
      data: {
        masterPlaylistUrl: signedUrl,
        expiresAt: expiresAt.toISOString()
      },
      meta: { isEnrolled, duration: `${duration}ms` }
    });
  } catch (error) {
    console.error('Video URL generator Lambda error:', error);
    await publishMetric('VideoUrlErrors');

    const duration = Date.now() - startTime;
    return jsonResponse(500, {
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      meta: { duration: `${duration}ms` }
    });
  }
}
