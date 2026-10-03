import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { EnvironmentConfig } from '../lib/config/environment';
import { QueueStack } from '../lib/stacks/queue-stack';
import { StorageStack } from '../lib/stacks/storage-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { CicdStack } from '../lib/stacks/cicd-stack';

/** True when running under the vitest test runner (it sets `VITEST=true`). */
const IS_VITEST = process.env.VITEST === 'true' || process.env.VITEST === '1';

/**
 * The environment config module builds its dev/staging/production config
 * objects ONCE at module load, reading `process.env` at that moment (see
 * `buildDomainConfig`/`allowedOrigins` in `lib/config/environment.ts`). To make
 * per-test env-var overrides take effect, we must re-evaluate that module AFTER
 * the overrides are applied, so the config objects are rebuilt against the
 * current `process.env`.
 *
 * This runs under two runtimes with different module systems:
 *  - vitest (Vite ESM transform): reset Vite's registry with `vi.resetModules()`
 *    then re-`import()` the module.
 *  - ts-node (CommonJS, used by the throwaway snapshot script): evict the module
 *    from `require.cache` then re-`require()` it.
 */
async function loadEnvironmentConfig(envName: string): Promise<EnvironmentConfig> {
  // Prefer vitest's module reset when available.
  if (IS_VITEST) {
    const vitest = (await import('vitest')) as { vi: { resetModules: () => void } };
    vitest.vi.resetModules();
    const mod = (await import('../lib/config/environment')) as typeof import('../lib/config/environment');

    return mod.getEnvironmentConfig(envName);
  }

  const modulePath = require.resolve('../lib/config/environment');
  delete require.cache[modulePath];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../lib/config/environment') as typeof import('../lib/config/environment');

  return mod.getEnvironmentConfig(envName);
}

/**
 * The exact set of process.env keys the stacks read when synthesizing. The
 * helper saves and restores ONLY these so the no-domain and full-domain test
 * cases cannot leak into each other.
 */
const MANAGED_ENV_KEYS = [
  'API_DOMAIN',
  'CDN_DOMAIN',
  'HOSTED_ZONE_ID',
  'CERTIFICATE_ARN',
  'CLOUDFRONT_CERTIFICATE_ARN',
  'ALLOWED_ORIGINS',
  'BUCKET_PREFIX',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'PUBLIC_SERVER_URL',
  'PUBLIC_IS_SELFHOSTED',
  'TRUSTED_ORIGINS',
  'DASHBOARD_ORIGIN',
  'PRIVATE_SERVER_KEY',
  'ALARM_EMAIL',
  'CDK_DEFAULT_ACCOUNT',
  'CDK_DEFAULT_REGION'
] as const;

/**
 * Save/restore the managed process.env keys around a synth, applying the
 * provided overrides. A key set to `undefined` in `envVars` is explicitly
 * deleted for the duration of the call.
 */
export function applyEnv(envVars: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();

  for (const key of MANAGED_ENV_KEYS) {
    saved.set(key, process.env[key]);
    // Clear every managed key first so a leftover value from the ambient
    // shell cannot bleed into a "no-domain" synth.
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(envVars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export type SynthApiResult = {
  app: cdk.App;
  config: EnvironmentConfig;
  queue: QueueStack;
  storage: StorageStack;
  api: ApiStack;
  t: Template;
  ts: Template;
  tq: Template;
};

/**
 * Synthesize QueueStack + StorageStack + ApiStack for the given environment and
 * env-var overrides, returning each stack plus its `Template`.
 *
 * `env` is pinned to `{ account, region }` from the resolved config (mirroring
 * `bin/app.ts`) so IAM ARNs resolve to plain-string literals rather than
 * `Fn::Join` tokens — this is what lets `iam.test.ts` match the tightened
 * `migration-router` invoke ARN directly, and keeps the before/after baseline
 * identical to the suite's synth.
 *
 * `Template.fromStack` synthesizes CloudFormation WITHOUT Lambda asset
 * bundling, so this runs regardless of the `@neondatabase/serverless` bundling
 * blocker that defeats a full `cdk synth`.
 */
export async function synthApi(
  envVars: Record<string, string | undefined> = {},
  envName = 'dev'
): Promise<SynthApiResult> {
  const restore = applyEnv(envVars);

  try {
    // Skip Lambda asset bundling: the `OUTPUT` asset-hash on the monorepo
    // handlers would otherwise invoke Docker/esbuild (and hit the
    // `@neondatabase/serverless` / `ws` bundling blocker). With no stacks in
    // the bundling allow-list, CDK uses a placeholder asset instead of running
    // the bundler, which is exactly what the Template assertions need — none of
    // them inspect the bundled code, only the CloudFormation template shape.
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const config = await loadEnvironmentConfig(envName);
    const env = { account: config.account, region: config.region };

    const queue = new QueueStack(app, 'Q', config, { env });
    const storage = new StorageStack(app, 'S', config, { env });
    const api = new ApiStack(app, `ClassroomIO-${config.environmentName}-Api`, config, {
      env,
      migrationRoutesTable: queue.migrationRoutesTable,
      emailQueue: queue.emailQueue,
      jobMetadataTable: queue.jobMetadataTable
    });

    return {
      app,
      config,
      queue,
      storage,
      api,
      t: Template.fromStack(api),
      ts: Template.fromStack(storage),
      tq: Template.fromStack(queue)
    };
  } finally {
    restore();
  }
}

export type SynthCicdResult = {
  app: cdk.App;
  config: EnvironmentConfig;
  cicd: CicdStack;
  t: Template;
};

/** Synthesize CicdStack for the OIDC/deploy-role assertions. */
export async function synthCicd(
  envVars: Record<string, string | undefined> = {},
  envName = 'dev'
): Promise<SynthCicdResult> {
  const restore = applyEnv(envVars);

  try {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const config = await loadEnvironmentConfig(envName);
    const env = { account: config.account, region: config.region };
    const cicd = new CicdStack(app, `ClassroomIO-${config.environmentName}-CICD`, config, { env });

    return { app, config, cicd, t: Template.fromStack(cicd) };
  } finally {
    restore();
  }
}

/** The five env vars that enable the full custom-domain code path in tests. */
export const FULL_DOMAIN_ENV: Record<string, string> = {
  API_DOMAIN: 'api.example.org',
  CDN_DOMAIN: 'cdn.example.org',
  HOSTED_ZONE_ID: 'Z123456789ABCDEFGHIJK',
  CERTIFICATE_ARN: 'arn:aws:acm:us-east-1:111111111111:certificate/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  CLOUDFRONT_CERTIFICATE_ARN: 'arn:aws:acm:us-east-1:111111111111:certificate/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
};
