import * as sqs from 'aws-cdk-lib/aws-sqs';
import { EnvironmentConfig } from '../../../config/environment';

/**
 * Shared, non-secret Lambda environment builders for ApiStack domain
 * constructs.
 *
 * Every value these produce is BYTE-IDENTICAL to the inline literals that used
 * to live in `api-stack.ts`; they are pure extractions of previously-duplicated
 * expressions. The refactor's empty before/after template diff is the proof
 * (see .agents/tasks/phase6-verification.md).
 */

/**
 * Shared Better Auth runtime env for auth + session-validating Lambdas.
 *
 * Built ONCE in ApiStack and spread (`...authEnv`) into every handler that
 * validates a session. Values come from the deploy shell (process.env, sourced
 * from apps/api/.env) with production-safe fallbacks. BETTER_AUTH_SECRET MUST be
 * consistent so session cookies signed by the auth handler validate in other
 * Lambdas.
 *
 * NOTE: the `config.domain.apiDomain`-based fallbacks can embed `undefined` when
 * no custom domain is configured. That is PRE-EXISTING behavior carried over
 * verbatim from the original inline `authEnv`; it is intentionally NOT "fixed"
 * here, because changing a resolved env value would be a behavior change.
 */
export function buildAuthEnv(config: EnvironmentConfig): Record<string, string> {
  return {
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || '',
    PUBLIC_SERVER_URL: process.env.PUBLIC_SERVER_URL || `https://${config.domain.apiDomain}`,
    PUBLIC_IS_SELFHOSTED: process.env.PUBLIC_IS_SELFHOSTED || 'false',
    // Better Auth's trusted origins for CSRF/session validation. Uses the
    // same allowedOrigins as CORS (app.example.com,
    // example.com) plus the API's own domain — previously this
    // derived a root domain from cdnDomain (e.g. "example.com"), which
    // never actually matched the dashboard's real origin.
    TRUSTED_ORIGINS:
      process.env.TRUSTED_ORIGINS || [...config.allowedOrigins, `https://${config.domain.apiDomain}`].join(','),
    // Admin dashboard origin for email links built server-side
    // (getDashboardBaseUrl/getAppBaseUrl in @cio/core). Falls back to the
    // first configured CORS origin (app.example.com) rather than
    // empty string — an empty DASHBOARD_ORIGIN previously made those
    // helpers fall through to the upstream ClassroomIO SaaS domain
    // (app.classroomio.com), which isn't this deployment's admin host.
    DASHBOARD_ORIGIN: process.env.DASHBOARD_ORIGIN || config.allowedOrigins[0] || '',
    // Server-to-server auth shared with the dashboard's SSR layer
    // (getApiKeyHeaders in apps/dashboard) — mirrors apps/api's
    // PRIVATE_SERVER_KEY / apiKeyMiddleware.
    PRIVATE_SERVER_KEY: process.env.PRIVATE_SERVER_KEY || ''
  };
}

/** `CONNECTION_TIMEOUT_MS` env fragment (Neon connection timeout). */
export function connectionTimeoutEnv(config: EnvironmentConfig): Record<string, string> {
  return { CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs) };
}

/** `EMAIL_QUEUE_URL` env fragment for handlers that enqueue email sends. */
export function emailQueueEnv(queue: sqs.IQueue): Record<string, string> {
  return { EMAIL_QUEUE_URL: queue.queueUrl };
}

/** SES provider + configuration-set env fragment for SES-sending handlers. */
export function sesEnv(configSetName: string): Record<string, string> {
  return { EMAIL_PROVIDER: 'ses', SES_CONFIGURATION_SET_NAME: configSetName };
}
