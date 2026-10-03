import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { EnvironmentConfig } from '../../../config/environment';

/**
 * Shared IAM helpers for ApiStack domain constructs.
 *
 * Each helper returns the IDENTICAL statement/grant that used to be written
 * inline in `api-stack.ts`, with ONE pre-authorized exception: the
 * `migration-router` invoke scope is tightened (see `migrationRouterInvoke`).
 * The required `cloudwatch:PutMetricData` and SES `identity/*` wildcards are
 * preserved with their explanatory comments — they are genuinely required and
 * must NOT be narrowed.
 */

/**
 * CloudWatch custom-metrics grant.
 *
 * `cloudwatch:PutMetricData` does NOT support resource-level permissions, so
 * `resources: ['*']` is required and acceptable (kept from the original inline
 * statement, with its comment).
 */
export function cloudwatchPutMetric(): iam.PolicyStatement {
  return new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['cloudwatch:PutMetricData'],
    resources: ['*'] // CloudWatch metrics don't support resource-level permissions
  });
}

/**
 * SES send grant for email-worker / auth-handler.
 *
 * Scoped to `identity/*` within this account/region PLUS the configuration-set
 * ARN. The `identity/*` wildcard is REQUIRED while the account is in SES
 * sandbox (SES authorizes ses:SendEmail against the recipient identity ARN too,
 * not just the sender — confirmed via a live AccessDeniedException). It must NOT
 * be narrowed. This is a faithful reproduction of the original inline policy, so
 * it is NOT a tightening.
 */
export function sesSend(config: EnvironmentConfig, configurationSetName: string): iam.PolicyStatement {
  return new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['ses:SendEmail', 'ses:SendRawEmail'],
    resources: [
      `arn:aws:ses:${config.region}:${config.account}:identity/*`,
      // SES also authorizes ses:SendEmail against the configuration-set ARN
      // itself (ConfigurationSetName on the send call), not just the
      // sender/recipient identity ARNs — confirmed via a live
      // AccessDeniedException naming this configuration-set ARN once the
      // identity/* grant alone was in place.
      `arn:aws:ses:${config.region}:${config.account}:configuration-set/${configurationSetName}`
    ]
  });
}

/**
 * Grant a function permission to enqueue email sends on the shared queue.
 *
 * `queue.grantSendMessages` is already least-privilege (scoped to the one queue
 * ARN); this wrapper exists only so domain constructs call a single shared
 * helper. Behavior is unchanged.
 */
export function grantEmailSend(queue: sqs.IQueue, fn: lambda.IFunction): void {
  queue.grantSendMessages(fn);
}

/**
 * `migration-router` Lambda invoke policy — TIGHTENED (pre-authorized Phase 6
 * IAM least-privilege deviation #1).
 *
 * BEFORE: `arn:aws:lambda:<region>:<account>:function:*` (any Lambda in the
 * account). AFTER: scoped to this environment's functions only
 * (`function:*-<env>`), matching the `<name>-<env>` physical-name convention
 * every NodejsFunction here follows and the scope CICD's own Lambda policy
 * already uses.
 *
 * Behavior-neutral today: the router's `/{proxy+}` wiring is still a TODO, so it
 * invokes nothing. CAVEAT: `HONO_PROXY_FUNCTION_NAME` is currently the literal
 * `hono-proxy` (no `-<env>` suffix). When the `hono-proxy` Lambda is finally
 * wired up it MUST follow the `<name>-<env>` naming (so it becomes
 * `hono-proxy-<env>` and this ARN pattern covers it) — otherwise this pattern
 * must be revisited.
 */
export function migrationRouterInvoke(config: EnvironmentConfig): iam.PolicyStatement {
  return new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['lambda:InvokeFunction'],
    resources: [
      // Scoped to this environment's functions only (least privilege).
      // See the function doc for the hono-proxy naming caveat.
      `arn:aws:lambda:${config.region}:${config.account}:function:*-${config.environmentName}`
    ]
  });
}
