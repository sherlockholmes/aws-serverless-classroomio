import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import katex from 'katex';
import { handler as downloadHandler } from '../course-download-handler';

function response(statusCode: number, body: string, contentType = 'text/html'): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': contentType }, body };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath || '';
  if (path.includes('/download/')) return downloadHandler(event);
  if (path !== '/course/katex')
    return response(404, JSON.stringify({ success: false, message: 'Not Found' }), 'application/json');

  const query = event.rawQueryString || '';
  if (!query) return response(400, JSON.stringify({ success: false, error: 'Validation error' }), 'application/json');

  try {
    const latex = query.replaceAll('&plus;', '+').replaceAll('&space;', '');
    const html = katex.renderToString(latex, { output: 'mathml', throwOnError: false });
    return response(200, html);
  } catch (error) {
    console.error('[course-utility-handler] katex error:', error);
    return response(500, JSON.stringify({ success: false, error: 'Failed to render LaTeX' }), 'application/json');
  }
}
