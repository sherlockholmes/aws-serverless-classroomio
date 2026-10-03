import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  renderCertificate,
  resolveTemplateId,
  DEFAULT_CERTIFICATE_DESIGN,
  type CertificateDesign
} from '@cio/certificates';
import { getCloudflarePdfBuffer, getCloudflarePngBuffer } from './cloudflare-render';
import { getCourseById, getCourseWithRelations } from '@cio/db/queries/course';
import { requireCourseMember } from '../_shared/course-membership';
import { marked } from 'marked';

function binaryResponse(
  statusCode: number,
  buffer: Buffer,
  contentType: string,
  filename?: string
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    isBase64Encoded: true,
    headers: {
      'content-type': contentType,
      ...(filename ? { 'content-disposition': `attachment; filename="${filename}"` } : {})
    },
    body: buffer.toString('base64')
  };
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

function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'certificate'
  );
}

function resolveDesign(stored: unknown): CertificateDesign {
  const blob = stored && typeof stored === 'object' ? (stored as Record<string, any>) : {};
  const design = blob.design && typeof blob.design === 'object' ? blob.design : {};
  const templateId = resolveTemplateId(design.templateId ?? blob.theme);
  return {
    ...DEFAULT_CERTIFICATE_DESIGN,
    ...design,
    templateId,
    signatories: design.signatories ?? DEFAULT_CERTIFICATE_DESIGN.signatories
  };
}

async function certificateInput(courseId: string, body: any) {
  const [course] = await getCourseById(courseId);
  if (!course) throw new Error('Course not found');
  const courseWithRelations = await getCourseWithRelations(courseId);
  const organization = courseWithRelations?.org ?? null;
  const issuedAt = body.issuedAt ? new Date(body.issuedAt) : new Date();
  const design = resolveDesign(course.certificate);
  const sequence = (body.studentId ?? String(issuedAt.getTime())).replace(/-/g, '').slice(-4).toUpperCase() || '0001';
  const certificateId = (design.idFormat ?? 'N° {seq}')
    .replace('{seq}', sequence)
    .replace('{year}', String(issuedAt.getFullYear()))
    .replace('{month}', String(issuedAt.getMonth() + 1).padStart(2, '0'));
  return {
    design,
    data: {
      recipientName: body.studentName,
      courseName: course.title,
      courseDescription: course.description ?? '',
      orgName: organization?.name ?? '',
      orgLogoUrl: organization?.avatarUrl ?? undefined,
      date: issuedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit' }),
      certificateId
    }
  };
}

function buildCourseHtml(input: any): string {
  const lessons = input.lessons
    .map(
      (lesson: any) =>
        `<section><h1>${lesson.lessonNumber} ${lesson.lessonTitle}</h1>${marked.parse(lesson.lessonNote)}</section>`
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif}section{page-break-after:always}</style></head><body><h1>${input.courseTitle}</h1>${lessons}</body></html>`;
}

function buildLessonHtml(input: any): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif}</style></head><body><h1>${input.number} ${input.title}</h1>${marked.parse(input.note)}</body></html>`;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const courseId = event.pathParameters?.courseId;
  if (!courseId) return jsonResponse(400, { success: false, message: 'Missing courseId' });
  const member = await requireCourseMember(event, courseId);
  if (!member) return jsonResponse(401, { success: false, message: 'Unauthorized' });
  const path = event.rawPath || '';
  const body = parseBody(event);
  if (body === undefined) return jsonResponse(400, { success: false, message: 'Invalid JSON body' });

  try {
    if (path.endsWith('/download/certificate') || path.endsWith('/download/certificate/png')) {
      if (!body.studentName || typeof body.studentName !== 'string')
        return jsonResponse(400, { success: false, message: 'Invalid request body' });
      const input = await certificateInput(courseId, body);
      const rendered = renderCertificate(input.design, input.data);
      const png = path.endsWith('/png');
      const buffer = png
        ? await getCloudflarePngBuffer(rendered.html, rendered.styles)
        : await getCloudflarePdfBuffer(rendered.html, rendered.styles);
      return binaryResponse(
        200,
        buffer,
        png ? 'image/png' : 'application/pdf',
        `certificate-${slugify(input.data.courseName)}.${png ? 'png' : 'pdf'}`
      );
    }
    if (path.endsWith('/download/content')) {
      if (!body.courseTitle || !Array.isArray(body.lessons))
        return jsonResponse(400, { success: false, message: 'Invalid request body' });
      const buffer = await getCloudflarePdfBuffer(buildCourseHtml(body));
      return binaryResponse(200, buffer, 'application/pdf', `${slugify(body.courseTitle)}.pdf`);
    }
    if (path.endsWith('/download/pdf')) {
      if (!body.title || !body.note) return jsonResponse(400, { success: false, message: 'Invalid request body' });
      const buffer = await getCloudflarePdfBuffer(buildLessonHtml(body));
      return binaryResponse(200, buffer, 'application/pdf', `${slugify(body.title)}.pdf`);
    }
  } catch (error) {
    console.error('[course-download-handler] error:', error);
    return jsonResponse(500, {
      success: false,
      message: error instanceof Error ? error.message : 'Failed to generate download'
    });
  }

  return jsonResponse(404, { success: false, message: 'Not Found' });
}
