/**
 * Course newsfeed Lambda.
 *
 * Mirrors apps/api/src/routes/course/newsfeed.ts. Notifications use the
 * shared SQS email helper consumed by the email-worker Lambda.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { sanitizeHtml } from '@cio/core/utils/sanitize-html';
import { buildEmailBranding, buildEmailFromName } from '@cio/email';
import { TENANT_ROOT_DOMAIN } from '@cio/utils/constants/domains';
import { enqueueTemplateEmail } from '../_shared/email-enqueue';
import {
  createNewsfeed,
  createNewsfeedComment,
  deleteNewsfeed,
  deleteNewsfeedComment,
  getNewsfeedByCourseIdPaginated,
  getNewsfeedById,
  getNewsfeedForEmail,
  getNewsfeedCommentAuthorAndCourse,
  getNewsfeedCommentById,
  getNewsfeedCommentDepth,
  getNewsfeedCommentThread,
  updateNewsfeed,
  updateNewsfeedComment,
  countNewsfeedCommentDescendants
} from '@cio/db/queries/newsfeed';
import { getGroupMemberIdByCourseAndProfile, isCourseTeamMemberOrOrgAdmin } from '@cio/db/queries/group';
import { requireCourseMember, requireCourseTeamMember } from '../_shared/course-membership';
import {
  ZNewsfeedCommentCreate,
  ZNewsfeedCommentGetParam,
  ZNewsfeedCommentThreadQuery,
  ZNewsfeedCommentUpdate,
  ZNewsfeedCreate,
  ZNewsfeedGetParam,
  ZNewsfeedListQuery,
  ZNewsfeedReactionUpdate,
  ZNewsfeedUpdate
} from '@cio/utils/validation/newsfeed';

async function sendPostEmail(feedId: string, authorId: string): Promise<void> {
  const feedData = await getNewsfeedForEmail(feedId, authorId);
  if (!feedData?.courseId || !feedData.courseTitle || !feedData.organization?.siteName) return;
  const branding = buildEmailBranding({
    name: feedData.organization.name,
    avatarUrl: feedData.organization.avatarUrl,
    theme: feedData.organization.theme
  });
  const postLink = `https://${feedData.organization.siteName}.${TENANT_ROOT_DOMAIN}/courses/${feedData.courseId}?feedId=${feedData.feedId}`;
  const from = buildEmailFromName(`${feedData.organization.name || 'ClassroomIO'} - ClassroomIO`);
  await Promise.all(
    feedData.courseMembers.map((member) =>
      member.email
        ? enqueueTemplateEmail({
            kind: 'template',
            template: 'newsfeedPost',
            to: member.email,
            fields: {
              courseTitle: feedData.courseTitle,
              teacherName: feedData.author?.fullname || 'A teacher',
              content: feedData.content || '',
              postLink,
              orgName: feedData.organization?.name || 'ClassroomIO',
              branding
            },
            from,
            replyTo: feedData.author?.email || 'noreply@classroomio.com'
          })
        : undefined
    )
  );
}

async function sendCommentEmail(feedId: string, comment: string, commenterId: string): Promise<void> {
  const feedData = await getNewsfeedForEmail(feedId);
  if (
    !feedData?.courseId ||
    !feedData.courseTitle ||
    !feedData.organization?.siteName ||
    !feedData.author?.email ||
    feedData.author.groupMemberId === commenterId
  )
    return;
  const branding = buildEmailBranding({
    name: feedData.organization.name,
    avatarUrl: feedData.organization.avatarUrl,
    theme: feedData.organization.theme
  });
  const postLink = `https://${feedData.organization.siteName}.${TENANT_ROOT_DOMAIN}/courses/${feedData.courseId}?feedId=${feedData.feedId}`;
  await enqueueTemplateEmail({
    kind: 'template',
    template: 'newsfeedComment',
    to: feedData.author.email,
    fields: {
      courseTitle: feedData.courseTitle,
      comment,
      postLink,
      orgName: feedData.organization.name || 'ClassroomIO',
      branding
    },
    from: buildEmailFromName(`${feedData.organization.name || 'ClassroomIO'} - ClassroomIO`),
    replyTo: 'noreply@classroomio.com'
  });
}

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function errorResponse(error: unknown, fallback: string): APIGatewayProxyResultV2 {
  return jsonResponse(500, { success: false, message: error instanceof Error ? error.message : fallback });
}

async function commentPermission(commentId: number, userId: string, teamAllowed: boolean): Promise<number | null> {
  const comment = await getNewsfeedCommentAuthorAndCourse(commentId);
  if (!comment?.courseId) return 404;
  const memberId = await getGroupMemberIdByCourseAndProfile(comment.courseId, userId);
  if (memberId && memberId === comment.authorId) return null;
  if (teamAllowed && (await isCourseTeamMemberOrOrgAdmin(comment.courseId, userId))) return null;
  return 403;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const courseId = event.pathParameters?.courseId;
  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method ?? 'GET';
  if (!courseId) return jsonResponse(400, { success: false, message: 'Missing courseId' });

  const feedMatch = new RegExp(`/course/${courseId}/newsfeed(?:/([^/]+))?$`).exec(path);
  const feedId = feedMatch?.[1];
  const commentsMatch = new RegExp(`/course/${courseId}/newsfeed/([^/]+)/comments$`).exec(path);
  const commentCreateMatch = new RegExp(`/course/${courseId}/newsfeed/([^/]+)/comment$`).exec(path);
  const commentMutationMatch = new RegExp(`/course/${courseId}/newsfeed/comment/(\\d+)$`).exec(path);
  const reactionMatch = new RegExp(`/course/${courseId}/newsfeed/([^/]+)/react$`).exec(path);

  if (method === 'GET' && !feedId) {
    const member = await requireCourseMember(event, courseId);
    if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });
    const query = Object.fromEntries(
      new URL(event.rawQueryString ? `https://local/?${event.rawQueryString}` : 'https://local/').searchParams
    );
    const validation = ZNewsfeedListQuery.safeParse(query);
    if (!validation.success)
      return jsonResponse(400, { success: false, message: 'Invalid query', errors: validation.error.issues });
    try {
      const data = await getNewsfeedByCourseIdPaginated(courseId, validation.data);
      return jsonResponse(200, { success: true, data });
    } catch (error) {
      console.error('[course-newsfeed-handler] list error:', error);
      return errorResponse(error, 'Failed to list newsfeed');
    }
  }

  if (method === 'POST' && !feedId) {
    const member = await requireCourseTeamMember(event, courseId);
    if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });
    const body = parseBody(event);
    if (body === undefined) return jsonResponse(400, { success: false, message: 'Invalid JSON body' });
    const validation = ZNewsfeedCreate.safeParse(body);
    if (!validation.success)
      return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
    try {
      const authorId = await getGroupMemberIdByCourseAndProfile(courseId, member.userId);
      if (!authorId) return jsonResponse(403, { success: false, error: 'User is not a member of this course' });
      const data = await createNewsfeed({
        courseId,
        authorId,
        content: sanitizeHtml(validation.data.content),
        isPinned: validation.data.isPinned ?? false
      });
      void sendPostEmail(data.id, authorId).catch((error) =>
        console.error('[course-newsfeed-handler] post email error:', error)
      );
      return jsonResponse(201, { success: true, data });
    } catch (error) {
      console.error('[course-newsfeed-handler] create error:', error);
      return errorResponse(error, 'Failed to create newsfeed');
    }
  }

  if (commentsMatch && method === 'GET') {
    const member = await requireCourseMember(event, courseId);
    if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });
    const query = Object.fromEntries(
      new URL(event.rawQueryString ? `https://local/?${event.rawQueryString}` : 'https://local/').searchParams
    );
    const validation = ZNewsfeedCommentThreadQuery.safeParse(query);
    if (!validation.success)
      return jsonResponse(400, { success: false, message: 'Invalid query', errors: validation.error.issues });
    try {
      const data = await getNewsfeedCommentThread(commentsMatch[1], {
        rootId: validation.data.rootId,
        cursor: validation.data.cursor,
        childCursor: validation.data.childCursor,
        rootLimit: validation.data.limit,
        childLimit: validation.data.childLimit,
        maxDepth: validation.data.maxDepth
      });
      return jsonResponse(200, { success: true, data });
    } catch (error) {
      console.error('[course-newsfeed-handler] comments error:', error);
      return errorResponse(error, 'Failed to fetch newsfeed comments');
    }
  }

  if (commentCreateMatch && method === 'POST') {
    const member = await requireCourseMember(event, courseId);
    if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });
    const body = parseBody(event);
    const validation = ZNewsfeedCommentCreate.safeParse(body);
    if (!validation.success)
      return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
    try {
      const authorId = await getGroupMemberIdByCourseAndProfile(courseId, member.userId);
      if (!authorId) return jsonResponse(403, { success: false, error: 'User is not a member of this course' });
      const feed = await getNewsfeedById(commentCreateMatch[1]);
      if (!feed || feed.courseId !== courseId)
        return jsonResponse(404, { success: false, message: 'Newsfeed item not found' });
      if (validation.data.parentId) {
        const parent = await getNewsfeedCommentById(validation.data.parentId);
        if (!parent || parent.courseNewsfeedId !== commentCreateMatch[1])
          return jsonResponse(400, { success: false, message: 'Invalid parent comment' });
        if ((await getNewsfeedCommentDepth(validation.data.parentId)) + 1 > 50)
          return jsonResponse(400, { success: false, message: 'Reply is nested too deeply' });
      }
      const sanitizedContent = sanitizeHtml(validation.data.content);
      const data = await createNewsfeedComment({
        courseNewsfeedId: commentCreateMatch[1],
        authorId,
        content: sanitizedContent,
        parentId: validation.data.parentId ?? null,
        replyToCommentId: null
      });
      void sendCommentEmail(commentCreateMatch[1], sanitizedContent, authorId).catch((error) =>
        console.error('[course-newsfeed-handler] comment email error:', error)
      );
      return jsonResponse(201, { success: true, data });
    } catch (error) {
      console.error('[course-newsfeed-handler] comment create error:', error);
      return errorResponse(error, 'Failed to create newsfeed comment');
    }
  }

  if (commentMutationMatch && (method === 'PUT' || method === 'DELETE')) {
    const member = await requireCourseMember(event, courseId);
    if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });
    const commentId = Number(commentMutationMatch[1]);
    const permission = await commentPermission(commentId, member.userId, method === 'DELETE');
    if (permission)
      return jsonResponse(permission, {
        success: false,
        message: permission === 404 ? 'Comment not found' : 'Not authorized'
      });
    if (method === 'PUT') {
      const validation = ZNewsfeedCommentUpdate.safeParse(parseBody(event));
      if (!validation.success)
        return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
      try {
        return jsonResponse(200, {
          success: true,
          data: await updateNewsfeedComment(commentId, sanitizeHtml(validation.data.content))
        });
      } catch (error) {
        console.error('[course-newsfeed-handler] comment update error:', error);
        return errorResponse(error, 'Failed to update newsfeed comment');
      }
    }
    try {
      const deletedDescendantCount = await countNewsfeedCommentDescendants(commentId);
      const data = await deleteNewsfeedComment(commentId);
      return jsonResponse(200, { success: true, data: data ? { ...data, deletedDescendantCount } : null });
    } catch (error) {
      console.error('[course-newsfeed-handler] comment delete error:', error);
      return errorResponse(error, 'Failed to delete newsfeed comment');
    }
  }

  if (reactionMatch && method === 'PUT') {
    const member = await requireCourseMember(event, courseId);
    if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });
    const validation = ZNewsfeedReactionUpdate.safeParse(parseBody(event));
    if (!validation.success) {
      return jsonResponse(400, { success: false, message: 'Invalid request body', errors: validation.error.issues });
    }

    try {
      const data = await updateNewsfeed(reactionMatch[1], { reaction: validation.data.reaction });
      return data
        ? jsonResponse(200, { success: true, data })
        : jsonResponse(404, { success: false, message: 'Newsfeed item not found' });
    } catch (error) {
      console.error('[course-newsfeed-handler] reaction error:', error);
      return errorResponse(error, 'Failed to update newsfeed reaction');
    }
  }

  if (feedId) {
    const paramValidation = ZNewsfeedGetParam.safeParse({ feedId });
    if (!paramValidation.success) return jsonResponse(400, { success: false, message: 'Invalid route parameters' });
    if (method === 'GET') {
      const member = await requireCourseMember(event, courseId);
      if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });
      try {
        const data = await getNewsfeedById(feedId);
        return data
          ? jsonResponse(200, { success: true, data })
          : jsonResponse(404, { success: false, message: 'Newsfeed item not found' });
      } catch (error) {
        console.error('[course-newsfeed-handler] get error:', error);
        return errorResponse(error, 'Failed to fetch newsfeed item');
      }
    }
    const member =
      method === 'PUT' && path.endsWith('/react')
        ? await requireCourseMember(event, courseId)
        : await requireCourseTeamMember(event, courseId);
    if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });
    const body = parseBody(event);
    try {
      if (method === 'PUT' && path.endsWith('/react')) {
        const validation = ZNewsfeedReactionUpdate.safeParse(body);
        if (!validation.success)
          return jsonResponse(400, {
            success: false,
            message: 'Invalid request body',
            errors: validation.error.issues
          });
        return jsonResponse(200, {
          success: true,
          data: await updateNewsfeed(feedId, { reaction: validation.data.reaction })
        });
      }
      if (method === 'PUT') {
        const validation = ZNewsfeedUpdate.safeParse(body);
        if (!validation.success)
          return jsonResponse(400, {
            success: false,
            message: 'Invalid request body',
            errors: validation.error.issues
          });
        return jsonResponse(200, {
          success: true,
          data: await updateNewsfeed(feedId, {
            ...validation.data,
            content: validation.data.content ? sanitizeHtml(validation.data.content) : undefined
          })
        });
      }
      if (method === 'DELETE') return jsonResponse(200, { success: true, data: await deleteNewsfeed(feedId) });
    } catch (error) {
      console.error('[course-newsfeed-handler] mutation error:', error);
      return errorResponse(error, 'Failed to mutate newsfeed');
    }
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
