import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  generateDocumentDownloadPresignedUrls,
  generateDocumentUploadPresignedUrl,
  generateVideoDownloadPresignedUrls,
  generateVideoUploadPresignedUrl
} from '@cio/core/utils/s3';
import { generateFileKey } from '@cio/core/utils/upload';
import { getUploadLimits } from '@cio/core/config/upload-limits';
import {
  ZCourseDocumentPresignUrlUpload,
  ZCourseDownloadPresignedUrl,
  ZCoursePresignUrlUpload
} from '@cio/utils/validation/course';
import { getSessionUserId } from '../_shared/session';

const uploadLimits = getUploadLimits();
const MAX_FILE_SIZE = uploadLimits.videoBytes;
const MAX_DOCUMENT_SIZE = uploadLimits.documentBytes;

function response(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function body(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function tooLarge(fileSize: number | undefined, max: number): boolean {
  return fileSize !== undefined && fileSize > max;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const userId = await getSessionUserId(event);
  if (!userId) return response(401, { success: false, message: 'Unauthorized' });

  const path = event.rawPath || '';
  const input = body(event);
  if (input === undefined) return response(400, { success: false, message: 'Invalid JSON body' });

  try {
    if (path.endsWith('/video/upload')) {
      const parsed = ZCoursePresignUrlUpload.safeParse(input);
      if (!parsed.success)
        return response(400, { success: false, message: 'Invalid request body', errors: parsed.error.issues });
      if (tooLarge(parsed.data.fileSize, MAX_FILE_SIZE))
        return response(413, { success: false, message: 'File size exceeds maximum' });
      const fileKey = generateFileKey(parsed.data.fileName);
      const url = await generateVideoUploadPresignedUrl(fileKey, parsed.data.fileType);
      return response(200, { success: true, url, fileKey, message: 'Pre-signed URL generated successfully' });
    }
    if (path.endsWith('/document/upload')) {
      const parsed = ZCourseDocumentPresignUrlUpload.safeParse(input);
      if (!parsed.success)
        return response(400, { success: false, message: 'Invalid request body', errors: parsed.error.issues });
      if (tooLarge(parsed.data.fileSize, MAX_DOCUMENT_SIZE))
        return response(413, { success: false, message: 'File size exceeds maximum' });
      const fileKey = generateFileKey(parsed.data.fileName);
      const url = await generateDocumentUploadPresignedUrl(fileKey, parsed.data.fileType);
      return response(200, { success: true, url, fileKey, message: 'Document pre-signed URL generated successfully' });
    }
    if (path.endsWith('/video/download') || path.endsWith('/document/download')) {
      const parsed = ZCourseDownloadPresignedUrl.safeParse(input);
      if (!parsed.success)
        return response(400, { success: false, message: 'Invalid request body', errors: parsed.error.issues });
      const urls = path.endsWith('/video/download')
        ? await generateVideoDownloadPresignedUrls(parsed.data.keys)
        : await generateDocumentDownloadPresignedUrls(parsed.data.keys);
      return response(200, {
        success: true,
        urls,
        message: path.endsWith('/video/download')
          ? 'Video URLs retrieved successfully'
          : 'Document URLs retrieved successfully'
      });
    }
  } catch (error) {
    console.error('[course-presign-handler] error:', error);
    return response(500, {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to generate presigned URL'
    });
  }

  return response(404, { success: false, message: 'Not Found' });
}
