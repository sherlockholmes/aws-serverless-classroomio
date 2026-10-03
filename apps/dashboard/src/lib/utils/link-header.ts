/**
 * Caps the size of SvelteKit's auto-generated `Link: rel=modulepreload`
 * response header.
 *
 * SvelteKit lists every JS/CSS chunk a page (and its nested layouts) needs
 * as `modulepreload`/`preload` entries in a single `Link` header so browsers
 * can start fetching them before parsing the HTML. On deeply nested routes
 * (e.g. /courses/[id], which pulls in the course layout, sidebar, header,
 * AI assistant panel, etc.) this header can exceed 15-20KB by itself.
 *
 * CloudFront rejects origin responses whose total header size is too large
 * with a bare 502 "Error from cloudfront" (no error body, no app-level log —
 * confirmed via reproduction: the SvelteKit server itself returns 200 with
 * ~22KB of headers, cache-control/CSP/Link included, but CloudFront never
 * forwards it to the viewer). This is a known SvelteKit/proxy interaction —
 * see https://github.com/sveltejs/kit/issues/11084 and
 * https://github.com/sveltejs/kit/issues/8549 (Rich Harris: dropping the
 * Link header just falls back to the preload-helper emitted inline in the
 * HTML `<head>`, so functionality is preserved, only the *early* preload
 * hint is lost).
 *
 * Rather than tuning a reverse-proxy buffer size (not configurable on
 * Amplify Compute / CloudFront the way it is on nginx), drop the header
 * entirely once it crosses a safe threshold. The equivalent `<link>` /
 * `modulepreload` tags SvelteKit also inlines in the HTML `<head>` still
 * preload the same chunks, just without the head-start.
 */
const MAX_LINK_HEADER_BYTES = 8192;

export function capLinkHeader(response: Response): Response {
  const link = response.headers.get('link');
  if (!link || link.length <= MAX_LINK_HEADER_BYTES) return response;

  response.headers.delete('link');
  return response;
}
