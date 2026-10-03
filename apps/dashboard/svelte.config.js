import 'dotenv/config';

import adapterNode from '@sveltejs/adapter-node';
import { getCspDomains } from './src/lib/utils/csp-domains.js';
import path from 'path';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const IS_CLOUDFLARE = process.env.CI_ENVIRONMENT === 'cloudflare';
// CI_ENVIRONMENT=amplify switches to the community amplify-adapter (SSR on
// AWS Amplify Hosting Compute / Lambda). Used by the Amplify Hosting build
// pipeline (amplify.yml at repo root) for the example.com dashboard.
// AWS does not maintain an official SvelteKit adapter; see
// https://github.com/gzimbron/amplify-adapter and
// https://docs.aws.amazon.com/amplify/latest/userguide/get-started-sveltekit.html
const IS_AMPLIFY = process.env.CI_ENVIRONMENT === 'amplify';

const adapterCloudflare = IS_CLOUDFLARE ? (await import('@sveltejs/adapter-cloudflare')).default : null;
const adapterAmplify = IS_AMPLIFY ? (await import('amplify-adapter')).default : null;
const isSelfHosted = process.env.PUBLIC_IS_SELFHOSTED === 'true';
const csp = getCspDomains(isSelfHosted, process.env.PUBLIC_SERVER_URL);

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: [vitePreprocess({})],
  kit: {
    // Default: Node server (Render, Docker). Opt into Cloudflare Pages or Amplify Hosting via CI_ENVIRONMENT.
    adapter: IS_CLOUDFLARE ? adapterCloudflare() : IS_AMPLIFY ? adapterAmplify() : adapterNode(),
    alias: {
      $lib: path.resolve('./src/lib'),
      $features: path.resolve('./src/lib/features'),
      $mail: path.resolve('./src/mail'),
      '$src/tools': path.resolve('./node_modules/@cio/ui/src/tools/index.ts'),
      '$src/base/*': path.resolve('./node_modules/@cio/ui/src/base/*'),
      '@cio/ui': path.resolve('./node_modules/@cio/ui/src'),
      '@cio/ui/*': path.resolve('./node_modules/@cio/ui/src/*'),
      '@cio/api': path.resolve('./node_modules/@cio/api/dist'),
      '@cio/api/*': path.resolve('./node_modules/@cio/api/dist/*'),
      '@cio/utils': path.resolve('./node_modules/@cio/utils/dist'),
      '@cio/utils/*': path.resolve('./node_modules/@cio/utils/dist/*'),
      '@cio/db/types': path.resolve('./node_modules/@cio/db/src/types.ts')
    },
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'script-src': ['self', ...csp.scriptSrc, 'unsafe-hashes', 'unsafe-eval'],
        'style-src': ['self', 'unsafe-inline', ...csp.styleSrc],
        'style-src-elem': ['self', 'unsafe-inline', ...csp.styleSrc],
        // data: covers inlined woff2 (e.g. PDF.js / icon fonts); file fonts use 'self'
        'font-src': ['self', 'data:', ...csp.fontSrc],
        'img-src': ['self', 'data:', ...csp.mediaSrc, 'blob:', 'http://localhost:9000'],
        'media-src': [
          'self',
          ...csp.mediaSrc,
          'data:',
          'blob:',
          'http://localhost:9000',
          ...(csp.apiOrigin ? [csp.apiOrigin] : [])
        ],
        'frame-src': ['self', ...csp.frameSrc],
        'connect-src': [
          'self',
          'blob:',
          'http://localhost:3002',
          'http://localhost:9000',
          ...(csp.apiOrigin ? [csp.apiOrigin] : []),
          ...csp.connectSrc
        ],
        'worker-src': ['self', 'blob:'],
        'object-src': ['none'],
        'base-uri': ['self'],
        'form-action': ['self'],
        // 'self' allows same-origin iframes (e.g. widget preview at /widget-preview). 'none' blocks all embedding.
        'frame-ancestors': ['self'],
        'upgrade-insecure-requests': true
      },
      reportOnly: {
        'default-src': ['self'],
        'script-src': ['self', ...csp.scriptSrc, 'unsafe-hashes', 'unsafe-eval'],
        'style-src': ['self', 'unsafe-inline', ...csp.styleSrc],
        'style-src-elem': ['self', 'unsafe-inline', ...csp.styleSrc],
        'font-src': ['self', 'data:', ...csp.fontSrc],
        'img-src': ['self', 'data:', ...csp.mediaSrc, 'blob:', 'http://localhost:9000'],
        'media-src': [
          'self',
          ...csp.mediaSrc,
          'data:',
          'blob:',
          'http://localhost:9000',
          ...(csp.apiOrigin ? [csp.apiOrigin] : [])
        ],
        'frame-src': ['self', ...csp.frameSrc],
        'connect-src': [
          'self',
          'blob:',
          'http://localhost:3002',
          'http://localhost:9000',
          ...(csp.apiOrigin ? [csp.apiOrigin] : []),
          ...csp.connectSrc
        ],
        'worker-src': ['self', 'blob:'],
        'object-src': ['none'],
        'base-uri': ['self'],
        'form-action': ['self'],
        'frame-ancestors': ['self'],
        'report-uri': ['/csp-report']
      }
    }
  }
};

export default config;
