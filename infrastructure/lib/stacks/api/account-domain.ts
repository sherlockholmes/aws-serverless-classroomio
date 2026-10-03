import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/environment';
import { NodejsFunction } from '../../constructs';
import { ApiDomainConstruct, ApiDomainProps } from './shared/domain-base';

/**
 * AccountDomain — groups this domain's Lambda + route construction.
 *
 * All resources are created on the ApiStack scope (this.stackScope), so every
 * CloudFormation logical ID is byte-identical to the pre-refactor single-stack
 * template (see phase6-design §1.1). Function/route/policy construction is
 * reproduced verbatim from the original api-stack.ts.
 */
export class AccountDomain extends ApiDomainConstruct {
  constructor(parentScope: Construct, id: string, config: EnvironmentConfig, props: ApiDomainProps) {
    super(parentScope, id, config, props);

    const scope = this.stackScope;
    const { httpApi, authEnv, emailQueue, sesConfigurationSetName } = this.props;

    /**
     * Task 11.1: Account Profile Lambda Function
     *
     * Requirements: 9.6
     * Design: Creating a New Route § Route Pattern
     *
     * This Lambda function handles GET and PUT /account/profile requests for the
     * authenticated user's profile information:
     * - Session validation using Better Auth
     * - Profile query from Neon PostgreSQL
     * - Returns 401 if session invalid
     * - Returns 404 if profile not found
     * - CloudWatch custom metrics for request tracking
     * - Connection reuse across Lambda invocations
     *
     * Performance targets:
     * - p95 response time < 500ms
     * - Cold start < 3s
     */
    const accountProfileFunction = new NodejsFunction(scope, 'AccountProfileFunction', config, {
      functionName: 'account-profile',
      entry: 'account-profile/index.ts',
      handler: 'handler',
      description: 'Account profile Lambda for retrieving authenticated user profile',
      memorySize: 512,
      timeout: 15, // Sufficient for session validation + query
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for getSession
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    accountProfileFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create account profile route
    const accountProfileIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'AccountProfileIntegration',
      accountProfileFunction.function
    );

    httpApi.addRoutes({
      path: '/account/profile',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT],
      integration: accountProfileIntegration
    });

    /**
     * Account Handler Lambda Function
     *
     * Handles GET /account requests — the dashboard's typed RPC client
     * (`classroomio.account.$get()`, called from
     * apps/dashboard/src/lib/features/app/init.svelte.ts's setupApp on every
     * authenticated app init) calls this route, not /account/profile. Without
     * it, post-login dashboard initialization 404s and never completes.
     * Mirrors apps/api/src/routes/account/account.ts's `.get('/', ...)`
     * (backed by getAccountData): session validation, profile lookup, org
     * memberships, and per-org resource usage for admin/tutor members.
     *
     * See infrastructure/src/lambda/account-handler/index.ts for the
     * cloud-mode-only scoping note (self-hosted auto-enroll + license status
     * intentionally not ported — no-ops in cloud mode, matching the
     * monolith's own guards).
     */
    const accountHandlerFunction = new NodejsFunction(scope, 'AccountHandlerFunction', config, {
      functionName: 'account-handler',
      entry: 'account-handler/index.ts',
      handler: 'handler',
      description: 'Account handler Lambda for GET /account (profile + org memberships)',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for getSession
      environment: {
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        EMAIL_QUEUE_URL: emailQueue.queueUrl
      }
    });

    accountHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*']
      })
    );

    const accountHandlerIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'AccountHandlerIntegration',
      accountHandlerFunction.function
    );

    httpApi.addRoutes({
      path: '/account',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: accountHandlerIntegration
    });
  }
}
