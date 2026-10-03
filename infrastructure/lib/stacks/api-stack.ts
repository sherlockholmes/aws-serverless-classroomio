import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environment';
import { NodejsFunction } from '../constructs';

/**
 * API Stack Properties
 */
export interface ApiStackProps extends cdk.StackProps {
  migrationRoutesTable: dynamodb.ITable;
  /** SQS queue the email-worker Lambda consumes (Task 6.5). */
  emailQueue: sqs.IQueue;
  /** DynamoDB table used for the email idempotency backstop (Task 6.1). */
  jobMetadataTable: dynamodb.ITable;
}

/**
 * API Stack
 *
 * This stack provisions:
 * - API Gateway HTTP API for routing requests to Lambda functions
 * - Lambda functions for application routes (auth, courses, lessons, etc.)
 * - Migration router for strangler fig pattern
 * - Hono proxy Lambda for forwarding to legacy infrastructure
 * - Neon test Lambda for connection validation
 *
 * Requirements: 11.1, 11.2, 11.5, 3.1, 3.2, 3.3, 2.1, 2.2, 2.3
 * Design: Components § API Gateway HTTP API, Components § Lambda Functions
 */
export class ApiStack extends cdk.Stack {
  public readonly httpApi: apigatewayv2.HttpApi;
  public readonly neonTestFunction: NodejsFunction;
  public readonly migrationRouterFunction: NodejsFunction;
  public readonly courseListingFunction: NodejsFunction;
  public readonly courseDetailsFunction: NodejsFunction;
  public readonly courseEnrollmentFunction: NodejsFunction;
  public readonly courseMutationHandlerFunction: NodejsFunction;
  public readonly lessonListingFunction: NodejsFunction;
  public readonly lessonDetailsFunction: NodejsFunction;
  public readonly lessonProgressFunction: NodejsFunction;
  public readonly videoUrlGeneratorFunction: NodejsFunction;
  public readonly organizationHandlerFunction: NodejsFunction;
  public readonly authHandlerFunction: NodejsFunction;
  public readonly accountProfileFunction: NodejsFunction;
  public readonly accountHandlerFunction: NodejsFunction;
  public readonly organizationCoursesHandlerFunction: NodejsFunction;
  public readonly organizationSetupHandlerFunction: NodejsFunction;
  public readonly organizationTeamHandlerFunction: NodejsFunction;
  public readonly organizationAudienceHandlerFunction: NodejsFunction;
  public readonly organizationMutationHandlerFunction: NodejsFunction;
  public readonly dashHandlerFunction: NodejsFunction;
  public readonly onboardingHandlerFunction: NodejsFunction;
  public readonly domainHandlerFunction: NodejsFunction;
  public readonly courseSectionHandlerFunction: NodejsFunction;
  public readonly courseContentHandlerFunction: NodejsFunction;
  public readonly courseMarkHandlerFunction: NodejsFunction;
  public readonly courseAttendanceHandlerFunction: NodejsFunction;
  public readonly courseComplianceHandlerFunction: NodejsFunction;
  public readonly courseNewsfeedHandlerFunction: NodejsFunction;
  public readonly coursePresignHandlerFunction: NodejsFunction;
  public readonly coursePaymentRequestHandlerFunction: NodejsFunction;
  public readonly courseUtilityHandlerFunction: NodejsFunction;
  public readonly coursePeopleHandlerFunction: NodejsFunction;
  public readonly courseInviteHandlerFunction: NodejsFunction;
  public readonly lessonExtendedHandlerFunction: NodejsFunction;
  public readonly lessonMutationHandlerFunction: NodejsFunction;
  public readonly inviteHandlerFunction: NodejsFunction;
  public readonly courseExerciseHandlerFunction: NodejsFunction;
  public readonly courseSubmissionHandlerFunction: NodejsFunction;
  public readonly sesEmailIdentity: ses.EmailIdentity;
  public readonly sesConfigurationSet: ses.ConfigurationSet;
  public readonly emailWorkerFunction: NodejsFunction;

  constructor(scope: Construct, id: string, config: EnvironmentConfig, apiProps: ApiStackProps) {
    super(scope, id, apiProps);

    // Apply environment tags to all resources in this stack
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    /**
     * Neon Test Lambda Function
     *
     * Task 4.1: Test Neon connection pooling from Lambda
     * Requirements: 2.1, 2.2, 2.3, 2.6, 16.4
     *
     * This Lambda function validates:
     * - Connection to Neon PostgreSQL pooler endpoint
     * - SSL/TLS connection security
     * - Connection reuse across invocations (cold vs warm start)
     * - Query performance benchmarks
     * - Retry logic for scale-to-zero wake-up
     */
    this.neonTestFunction = new NodejsFunction(this, 'NeonTestFunction', config, {
      functionName: 'neon-test',
      entry: 'neon-test/index.ts',
      handler: 'handler',
      description: 'Test Lambda for Neon PostgreSQL connection validation',
      memorySize: 512,
      timeout: 30, // Allow time for cold start + retries
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
      }
    });

    // Grant CloudWatch Logs permissions (already included by default)
    // No additional IAM permissions needed for this test function

    /**
     * Task 7.1: API Gateway HTTP API
     *
     * Requirements: 11.1
     *
     * HTTP API (not REST API) for lower cost:
     * - $1.00 per million requests (vs $3.50 for REST API)
     * - No charges for unused capacity
     * - Native support for Lambda proxy integration
     *
     * Custom domain configuration is optional in dev environment.
     * For production, configure:
     * - ACM certificate for *.classroomio.com
     * - Route53 DNS record pointing to API Gateway domain
     */
    this.httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: `${config.environmentName}-classroomio-api`,
      description: `ClassroomIO HTTP API - ${config.environmentName} environment`,

      // CORS configuration - Task 7.2
      corsPreflight: {
        allowOrigins: config.allowedOrigins,
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.PATCH,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS
        ],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Api-Key'],
        allowCredentials: true,
        maxAge: cdk.Duration.hours(1)
      },

      // Custom domain configuration
      defaultDomainMapping: config.domain.certificateArn
        ? {
            domainName: new apigatewayv2.DomainName(this, 'ApiDomain', {
              domainName: config.domain.apiDomain ?? '',
              certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', config.domain.certificateArn)
            })
          }
        : undefined
    });

    /**
     * Task 7.3: Throttling Configuration
     *
     * Requirements: 5.2, 5.3
     *
     * HTTP API v2 throttling is configured at the stage level.
     * Default stage is automatically created by CDK.
     *
     * Throttling settings:
     * - Burst limit: 5000 requests (absorbs traffic spikes)
     * - Rate limit: 2000 req/s (sustained throughput)
     *
     * Additional protection layers:
     * - Lambda reserved concurrency (per function) - Task 14.2
     * - DynamoDB rate limiting (per user/IP) - Task 14.1
     *
     * Note: HTTP API v2 does NOT support Usage Plans like REST API v1.
     * For per-client throttling, implement in Lambda with DynamoDB.
     */
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as apigatewayv2.CfnStage;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = {
        throttlingBurstLimit: 5000,
        throttlingRateLimit: 2000
      };
    }

    // Create health check route for monitoring and validation
    const healthCheckIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'HealthCheckIntegration',
      this.neonTestFunction.function
    );

    this.httpApi.addRoutes({
      path: '/health',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: healthCheckIntegration
    });

    /**
     * Task 9.1: Migration Router Lambda
     *
     * Requirements: 3.1, 3.2, 3.3, 3.6
     *
     * Central routing Lambda that implements the strangler fig pattern:
     * - Receives ALL /{proxy+} requests
     * - Queries migration-routes DynamoDB table
     * - Implements longest prefix matching
     * - Routes to Lambda function OR Hono proxy
     * - Supports canary traffic splitting
     *
     * This Lambda will be the default route handler once Hono proxy is implemented.
     */
    this.migrationRouterFunction = new NodejsFunction(this, 'MigrationRouterFunction', config, {
      functionName: 'migration-router',
      entry: 'migration-router/index.ts',
      handler: 'handler',
      description: 'Migration router for strangler fig pattern',
      memorySize: 512,
      timeout: 29, // Match API Gateway timeout
      environment: {
        MIGRATION_ROUTES_TABLE: apiProps.migrationRoutesTable.tableName,
        HONO_PROXY_FUNCTION_NAME: 'hono-proxy' // Will be created in Task 10.1
      }
    });

    // Grant DynamoDB read permissions to migration router
    apiProps.migrationRoutesTable.grantReadData(this.migrationRouterFunction.function);

    // Grant Lambda invoke permissions (for calling target Lambda functions and Hono proxy)
    this.migrationRouterFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [
          // Allow invoking any Lambda in this account (migration router needs to route to domain handlers)
          `arn:aws:lambda:${config.region}:${config.account}:function:*`
        ]
      })
    );

    // TODO: Wire migration router to API Gateway /{proxy+} route after Hono proxy is implemented (Task 10.1)
    // For now, we keep explicit routes only

    /**
     * Task 8 (consolidated): Authentication Lambda Function (Better Auth Handler)
     *
     * Requirements: 4.1, 4.5, 9.6
     * Design: Request Flow § Web Request Flow (Authenticated)
     * Tasks: 8.1, 8.2, 8.3 (consolidated into single Lambda)
     *
     * This Lambda proxies all /auth/* routes to Better Auth's handler.
     * Handles login, logout, session validation, OAuth, SSO, and email verification.
     *
     * Routes handled:
     * - POST /auth/sign-in/email (email/password login)
     * - POST /auth/sign-in/social (OAuth - Google)
     * - POST /auth/sign-out (logout)
     * - GET /auth/session (session validation)
     * - POST /auth/sign-up/email (registration)
     * - GET/POST /auth/* (all Better Auth routes)
     *
     * Performance targets:
     * - p95 response time < 500ms
     * - Cold start < 3s
     */
    /**
     * Shared Better Auth runtime env for auth + session-validating Lambdas.
     * Values come from the deploy shell (process.env, sourced from apps/api/.env)
     * with production-safe fallbacks. BETTER_AUTH_SECRET MUST be consistent so
     * session cookies signed by the auth handler validate in other Lambdas.
     */
    const authEnv: Record<string, string> = {
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

    /**
     * SES Domain Identity + DKIM + Configuration Set
     *
     * Spec: .kiro/specs/ses-email-delivery
     * Task: 3.1 "Create the SES domain identity for example.com in
     * CDK, and verify 3 test-recipient email identities (stay in
     * SES_Sandbox)"
     * Task: 3.4 "Add SES configuration set with bounce/complaint ->
     * CloudWatch event destination"
     *
     * Verifies the `example.com` domain identity via the existing
     * Route 53 hosted zone (Identity.publicHostedZone adds the DKIM CNAME
     * records and the MAIL FROM MX/TXT records automatically -- no manual
     * DNS work needed, unlike a plain Identity.domain()).
     *
     * Intentional scope decision (see design.md Decision 1 + requirements.md
     * Requirement 2): this spec deliberately stays in SES_Sandbox rather
     * than requesting production access. Individual test-recipient
     * email identities (e.g. you@example.com) are verified separately,
     * out-of-band, via
     * `aws ses verify-email-identity` (see this task's own checklist in
     * tasks.md) -- CDK has no construct for "verify an arbitrary recipient
     * inbox by clicking a link they receive", so that part is a manual/CLI
     * step, not something this stack can encode.
     */
    this.sesConfigurationSet = new ses.ConfigurationSet(this, 'SesConfigurationSet', {
      configurationSetName: `classroomio-${config.environmentName}`
    });

    this.sesConfigurationSet.addEventDestination('BounceComplaintToCloudWatch', {
      destination: ses.EventDestination.cloudWatchDimensions([
        {
          source: ses.CloudWatchDimensionSource.MESSAGE_TAG,
          name: 'ses:configuration-set',
          defaultValue: 'none'
        }
      ]),
      events: [
        ses.EmailSendingEvent.SEND,
        ses.EmailSendingEvent.BOUNCE,
        ses.EmailSendingEvent.COMPLAINT,
        ses.EmailSendingEvent.REJECT
      ]
    });

    const sesHostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'SesHostedZone', {
      hostedZoneId: config.domain.hostedZoneId!,
      zoneName: 'example.com' // Root domain — example.com is a record within it
    });

    // `Identity.publicHostedZone(zone)` hardcodes the identity value to the
    // hosted zone's OWN zoneName (`example.com` here), which would verify
    // the entire root domain instead of just `example.com`
    // (Requirement 1.1 explicitly wants a domain identity scoped to
    // `example.com`, not its parent). Since `example.com` has no
    // separate delegated hosted zone for the `learn` subdomain (see
    // DNS_CONFIGURATION.md — everything lives in one zone), we build the
    // `Identity` value object directly instead of using the
    // `publicHostedZone` factory: this scopes the SES identity itself to
    // `example.com` while still pointing `hostedZone` at the real
    // Route 53 zone so `EmailIdentity` auto-creates the DKIM CNAME + MAIL
    // FROM MX/TXT records in that zone (identical mechanism to what
    // `Identity.publicHostedZone` does, just with a subdomain identity
    // value instead of the zone's own root name).
    const learnSubdomainIdentity: ses.Identity = {
      value: 'example.com',
      hostedZone: sesHostedZone
    };

    this.sesEmailIdentity = new ses.EmailIdentity(this, 'SesDomainIdentity', {
      identity: learnSubdomainIdentity,
      configurationSet: this.sesConfigurationSet,
      mailFromDomain: 'mail.example.com' // subdomain of the identity, not used to receive mail
    });

    new cdk.CfnOutput(this, 'SesDomainIdentityName', {
      value: this.sesEmailIdentity.emailIdentityName,
      description: 'SES verified domain identity (Easy DKIM via Route 53)',
      exportName: `${config.environmentName}-SesDomainIdentityName`
    });

    new cdk.CfnOutput(this, 'SesConfigurationSetName', {
      value: this.sesConfigurationSet.configurationSetName,
      description: 'SES configuration set name (bounce/complaint events -> CloudWatch)',
      exportName: `${config.environmentName}-SesConfigurationSetName`
    });

    /**
     * email-worker Lambda + SQS event source mapping
     *
     * Spec: .kiro/specs/ses-email-delivery
     * Task: 6.5 "Register email-worker in CDK with an SQS event source
     * mapping"
     *
     * NOT behind API Gateway -- no httpApi.addRoutes() call for this
     * function, since it's triggered by the Email_Queue (apiProps.emailQueue,
     * from QueueStack) rather than HTTP requests. Lives here in ApiStack
     * (not QueueStack) so it can reuse the same authEnv/bundleFromMonorepoRoot
     * NodejsFunction conventions every other handler in this stack uses.
     */
    // MonitoringStack's placeholder `lambdaFunctions` list (pre-existing
    // scaffold, unrelated to this spec) already CloudFormation-owns the
    // '/aws/lambda/email-worker-dev' log group. Import it by name instead
    // of letting NodejsFunction create a second one with the same name
    // (which CloudFormation rejects as "already exists") -- no stack
    // dependency on MonitoringStack needed since this is a plain name-based
    // import, not a cross-stack reference to a construct.
    const emailWorkerLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      'ExistingEmailWorkerLogGroup',
      `/aws/lambda/email-worker-${config.environmentName}`
    );

    this.emailWorkerFunction = new NodejsFunction(this, 'EmailWorkerFunction', config, {
      functionName: 'email-worker',
      entry: 'email-worker/index.ts',
      handler: 'handler',
      description: 'SQS-triggered Lambda that delivers queued emails via SES (@cio/email)',
      memorySize: 512,
      timeout: 30,
      bundleFromMonorepoRoot: true, // Needs @cio/email, @cio/jobs/payloads, @cio/db/queries/notifications bundled
      logGroup: emailWorkerLogGroup,
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        EMAIL_PROVIDER: 'ses',
        SES_CONFIGURATION_SET_NAME: this.sesConfigurationSet.configurationSetName,
        JOB_METADATA_TABLE_NAME: apiProps.jobMetadataTable.tableName,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // SES send permissions.
    //
    // While the account is in SES_Sandbox (this spec's Requirement 2 --
    // intentionally not requesting production access), AWS SES's IAM
    // authorization checks ses:SendEmail/SendRawEmail against BOTH the
    // sender identity ARN AND the verified recipient identity ARN, not
    // just the sender (documented sandbox-mode behavior; confirmed via a
    // live AccessDeniedException naming the recipient's identity ARN when
    // this policy was scoped to only the sender). Scoping to
    // `identity/*` within this account/region (rather than `resources:
    // ['*']`) keeps this least-privilege by resource TYPE while covering
    // every current and future verified recipient identity -- once
    // production access is requested later (Requirement 8.5's documented
    // follow-up), only the sender identity would actually be checked, but
    // this wildcard remains correct and doesn't need to be narrowed back.
    this.emailWorkerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          `arn:aws:ses:${config.region}:${config.account}:identity/*`,
          // SES also authorizes ses:SendEmail against the configuration-set
          // ARN itself (`ConfigurationSetName` on the send call), not just
          // the sender/recipient identity ARNs -- confirmed via a live
          // AccessDeniedException naming this configuration-set ARN once
          // the identity/* grant alone was in place.
          `arn:aws:ses:${config.region}:${config.account}:configuration-set/${this.sesConfigurationSet.configurationSetName}`
        ]
      })
    );

    // Idempotency backstop read/write (Task 6.1)
    apiProps.jobMetadataTable.grantReadWriteData(this.emailWorkerFunction.function);

    // SQS event source mapping — partial batch failure reporting so one bad
    // message doesn't force the whole batch to retry (design.md's
    // partial-batch-failure note; handler already returns batchItemFailures).
    this.emailWorkerFunction.function.addEventSource(
      new lambdaEventSources.SqsEventSource(apiProps.emailQueue, {
        batchSize: 10,
        reportBatchItemFailures: true
      })
    );

    new cdk.CfnOutput(this, 'EmailWorkerFunctionName', {
      value: this.emailWorkerFunction.function.functionName,
      description: 'email-worker Lambda function name',
      exportName: `${config.environmentName}-EmailWorkerFunctionName`
    });

    this.authHandlerFunction = new NodejsFunction(this, 'AuthHandlerFunction', config, {
      functionName: 'auth-handler',
      entry: 'auth-handler/index.ts',
      handler: 'handler',
      description: 'Authentication handler Lambda (Better Auth proxy for all /api/auth/* routes)',
      memorySize: 1024, // Higher memory for Better Auth processing
      timeout: 29, // Match API Gateway timeout for OAuth flows
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
        // better-auth's emailVerification/emailAndPassword hooks
        // (packages/db/src/auth/{email-verification,email-password}.ts)
        // call @cio/email's sendEmail() directly and synchronously --
        // they do NOT go through the Email_Queue/email-worker path (that
        // path is for apps/api's fire-and-forget enqueueTransactionalEmail
        // call sites, a different set of templates). This handler needs
        // its own SES wiring for signup verification / forgot-password /
        // password-reset-confirmation emails to actually send.
        EMAIL_PROVIDER: 'ses',
        SES_CONFIGURATION_SET_NAME: this.sesConfigurationSet.configurationSetName
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.authHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // SES send permissions -- see the identical, more detailed comment on
    // emailWorkerFunction's policy above for why this is scoped to
    // `identity/*` (SES_Sandbox authorizes against the recipient identity
    // too, not just the sender) rather than just this.sesEmailIdentity's ARN.
    this.authHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          `arn:aws:ses:${config.region}:${config.account}:identity/*`,
          `arn:aws:ses:${config.region}:${config.account}:configuration-set/${this.sesConfigurationSet.configurationSetName}`
        ]
      })
    );

    // Create auth routes - catch all /auth/* routes
    const authHandlerIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'AuthHandlerIntegration',
      this.authHandlerFunction.function
    );

    this.httpApi.addRoutes({
      path: '/api/auth/{proxy+}',
      methods: [
        apigatewayv2.HttpMethod.GET,
        apigatewayv2.HttpMethod.POST,
        apigatewayv2.HttpMethod.PUT,
        apigatewayv2.HttpMethod.PATCH,
        apigatewayv2.HttpMethod.DELETE
      ],
      integration: authHandlerIntegration
    });

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
    this.accountProfileFunction = new NodejsFunction(this, 'AccountProfileFunction', config, {
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
    this.accountProfileFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create account profile route
    const accountProfileIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'AccountProfileIntegration',
      this.accountProfileFunction.function
    );

    this.httpApi.addRoutes({
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
    this.accountHandlerFunction = new NodejsFunction(this, 'AccountHandlerFunction', config, {
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
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });

    this.accountHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*']
      })
    );

    const accountHandlerIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'AccountHandlerIntegration',
      this.accountHandlerFunction.function
    );

    this.httpApi.addRoutes({
      path: '/account',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: accountHandlerIntegration
    });

    /**
     * Task 13.1: Course Listing Lambda Function
     *
     * Requirements: 9.1, 18.1
     * Design: Performance Design § Database Query Performance
     *
     * This Lambda function handles GET /course requests and returns paginated course lists:
     * - Pagination support (page, limit query params)
     * - Organization filtering by orgId
     * - CloudWatch custom metrics for request tracking
     * - Connection reuse across Lambda invocations
     *
     * Performance targets:
     * - p95 response time < 500ms
     * - Cold start < 3s
     */
    this.courseListingFunction = new NodejsFunction(this, 'CourseListingFunction', config, {
      functionName: 'course-listing',
      entry: 'course-listing/index.ts',
      handler: 'handler',
      description: 'Course listing Lambda for paginated course retrieval',
      memorySize: 512,
      timeout: 15, // Sufficient for query + formatting
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.courseListingFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create course listing route
    const courseListingIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseListingIntegration',
      this.courseListingFunction.function
    );

    this.httpApi.addRoutes({
      path: '/course',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseListingIntegration
    });

    /**
     * Task 13.2: Course Details Lambda Function
     *
     * Requirements: 9.1, 18.1
     * Design: Request Flow § Web Request Flow
     *
     * This Lambda function handles GET /course/{id} requests and returns detailed course
     * information with lessons metadata and enrollment status:
     * - Course details with organization data
     * - Lessons metadata (ordered by lesson order)
     * - Enrollment status for authenticated users
     * - Public course visibility check
     * - CloudWatch custom metrics for request tracking
     * - Connection reuse across Lambda invocations
     *
     * Performance targets:
     * - p95 response time < 1000ms (Requirement 18.1)
     * - Cold start < 3s
     */
    this.courseDetailsFunction = new NodejsFunction(this, 'CourseDetailsFunction', config, {
      functionName: 'course-details',
      entry: 'course-details/index.ts',
      handler: 'handler',
      description: 'Course details Lambda for retrieving course with lessons metadata',
      memorySize: 512,
      timeout: 15, // Sufficient for query + formatting
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.courseDetailsFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create course details route with path parameter
    const courseDetailsIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseDetailsIntegration',
      this.courseDetailsFunction.function
    );

    this.httpApi.addRoutes({
      path: '/course/{id}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseDetailsIntegration
    });

    /**
     * Task 13.3: Course Enrollment Lambda Function
     *
     * Requirements: 9.1, 10.2
     * Design: Components § Lambda Functions § Course Handler
     *
     * This Lambda function handles POST /course/{id}/enroll requests and creates enrollment
     * records in the groupmember table:
     * - User authentication and authorization validation
     * - Enrollment record creation with role_id=3 (STUDENT)
     * - Duplicate enrollment handling (409 status)
     * - CloudWatch custom metrics for enrollment tracking
     * - Connection reuse across Lambda invocations
     *
     * Performance targets:
     * - p95 response time < 1000ms
     * - Cold start < 3s
     *
     * Database Schema:
     * - groupmember table: links profile_id to group_id with role_id
     * - role_id=3 is STUDENT role (from seed data)
     * - course.group_id links to group.id (organization group)
     * - Unique constraint: (group_id, profile_id) prevents duplicate enrollments
     */
    this.courseEnrollmentFunction = new NodejsFunction(this, 'CourseEnrollmentFunction', config, {
      functionName: 'course-enrollment',
      entry: 'course-enrollment/index.ts',
      handler: 'handler',
      description: 'Course enrollment Lambda for creating student enrollment records',
      memorySize: 512,
      timeout: 15, // Sufficient for enrollment creation
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.courseEnrollmentFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create course enrollment route with path parameter
    const courseEnrollmentIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseEnrollmentIntegration',
      this.courseEnrollmentFunction.function
    );

    this.httpApi.addRoutes({
      path: '/course/{id}/enroll',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseEnrollmentIntegration
    });

    /**
     * Course Mutation Handler: create / update / delete / clone
     *
     * Added outside the original missing-lambda-routes-404 56-task plan --
     * course creation (POST /course) was never assigned to any phase there.
     * Blocks the "create courses, register students" workflow, so added
     * directly here following the same NodejsFunction/auth conventions as
     * every other handler in this stack. See
     * infrastructure/src/lambda/course-mutation-handler/index.ts's module
     * doc for the two documented KNOWN GAPs (tag replacement on update,
     * minimal clone).
     *
     * Handles:
     * - POST   /course                 (org ADMIN only)
     * - PUT    /course/{courseId}       (course team member)
     * - DELETE /course/{courseId}       (course team member)
     * - POST   /course/{courseId}/clone (course team member)
     */
    this.courseMutationHandlerFunction = new NodejsFunction(this, 'CourseMutationHandlerFunction', config, {
      functionName: 'course-mutation-handler',
      entry: 'course-mutation-handler/index.ts',
      handler: 'handler',
      description: 'Course create/update/delete/clone Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/core + @cio/db + better-auth bundled
      // isomorphic-dompurify (via @cio/core/services/course/course ->
      // sanitize-html) pulls in jsdom, which reads its default stylesheet
      // relative to its own __dirname at module load time. esbuild's
      // single-file bundle would flatten that lookup and crash on cold
      // start (ENOENT), so this package is installed as real node_modules
      // instead of bundled. See NodejsFunctionProps.externalNodeModules.
      externalNodeModules: ['isomorphic-dompurify'],
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.courseMutationHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const courseMutationIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseMutationIntegration',
      this.courseMutationHandlerFunction.function
    );

    // POST /course (org ADMIN only)
    this.httpApi.addRoutes({
      path: '/course',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseMutationIntegration
    });

    // PUT/DELETE /course/{courseId} (course team member)
    this.httpApi.addRoutes({
      path: '/course/{courseId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseMutationIntegration
    });

    // POST /course/{courseId}/clone (course team member)
    this.httpApi.addRoutes({
      path: '/course/{courseId}/clone',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseMutationIntegration
    });

    /**
     * Task 15.1: Lesson Listing Lambda Function
     *
     * Requirements: 9.2, 18.2
     * Design: Components § Lambda Functions § Lesson Handler
     *
     * This Lambda function handles GET /course/{id}/lessons requests and returns lesson lists
     * for a specific course:
     * - Lesson ordering (by lesson.order field, fallback to created_at)
     * - User enrollment filtering (enrolled users see all, non-enrolled see only public lessons)
     * - Progress indicators for enrolled users
     * - Section grouping if lessons have section_id
     * - CloudWatch custom metrics for request tracking
     * - Connection reuse across Lambda invocations
     *
     * Performance targets:
     * - p95 response time < 500ms (Requirement 18.2)
     * - Cold start < 3s
     */
    this.lessonListingFunction = new NodejsFunction(this, 'LessonListingFunction', config, {
      functionName: 'lesson-listing',
      entry: 'lesson-listing/index.ts',
      handler: 'handler',
      description: 'Lesson listing Lambda for retrieving lessons with progress indicators',
      memorySize: 512,
      timeout: 15, // Sufficient for query + formatting
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.lessonListingFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create lesson listing route with path parameter
    const lessonListingIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LessonListingIntegration',
      this.lessonListingFunction.function
    );

    this.httpApi.addRoutes({
      path: '/course/{id}/lessons',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lessonListingIntegration
    });

    /**
     * Task 15.2: Lesson Details Lambda Function
     *
     * Requirements: 9.2, 18.2
     * Design: Request Flow § Web Request Flow
     *
     * This Lambda function handles GET /lesson/{id} requests and returns detailed lesson
     * information with video metadata and enrollment verification:
     * - Lesson content with markdown notes
     * - Video asset metadata (URLs, durations)
     * - Document metadata
     * - Section and course context
     * - Enrollment-based access control (private lessons require enrollment)
     * - User progress indicators for enrolled users
     * - CloudWatch custom metrics for request tracking
     * - Connection reuse across Lambda invocations
     *
     * Performance targets:
     * - p95 response time < 500ms (Requirement 18.2)
     * - Cold start < 3s
     *
     * Access control:
     * - Public lessons: accessible to everyone
     * - Private lessons: require user enrollment in parent course (403 Forbidden otherwise)
     */
    this.lessonDetailsFunction = new NodejsFunction(this, 'LessonDetailsFunction', config, {
      functionName: 'lesson-details',
      entry: 'lesson-details/index.ts',
      handler: 'handler',
      description: 'Lesson details Lambda for retrieving lesson content with video metadata',
      memorySize: 512,
      timeout: 15, // Sufficient for query + formatting
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.lessonDetailsFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create lesson details route with path parameter
    const lessonDetailsIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LessonDetailsIntegration',
      this.lessonDetailsFunction.function
    );

    this.httpApi.addRoutes({
      path: '/lesson/{id}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lessonDetailsIntegration
    });

    /**
     * Dashboard-compat alias: GET /course/{courseId}/lesson/{lessonId}
     *
     * The SvelteKit dashboard's typed RPC client still calls the
     * pre-migration Hono API shape (classroomio.course[':courseId'].lesson
     * [':lessonId'].$get) for lesson details — it hasn't been updated to
     * call /lesson/{id} directly. Rather than rewrite that call site (and
     * every other course/lesson/exercise/submission call still targeting
     * the monolith shape), alias this one route to the same Lambda so the
     * dashboard's existing request resolves. See lessonDetailsFunction's
     * handler for how it distinguishes {id} vs {lessonId}.
     */
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lessonDetailsIntegration
    });

    /**
     * Task 15.3: Lesson Progress Tracking Lambda Function
     *
     * Requirements: 9.2, 10.2
     * Design: Components § Lambda Functions § Lesson Handler
     *
     * This Lambda function handles POST /lesson/{id}/progress requests and creates/updates
     * progress records in the lesson_completion table. It supports:
     * - User authentication and authorization validation
     * - Enrollment verification (403 if user not enrolled in parent course)
     * - Progress record upsert (INSERT ... ON CONFLICT ... DO UPDATE)
     * - Completion percentage tracking (0-100)
     * - CloudWatch custom metrics for lesson completions
     * - Connection reuse across Lambda invocations
     *
     * Performance targets:
     * - p95 response time < 1000ms
     * - Cold start < 3s
     *
     * Database schema:
     * - lesson_completion table: id, lesson_id, profile_id, is_complete, created_at, updated_at
     * - Unique constraint: (lesson_id, profile_id) prevents duplicate records
     */
    this.lessonProgressFunction = new NodejsFunction(this, 'LessonProgressFunction', config, {
      functionName: 'lesson-progress',
      entry: 'lesson-progress/index.ts',
      handler: 'handler',
      description: 'Lesson progress Lambda for tracking user lesson completion',
      memorySize: 512,
      timeout: 15, // Sufficient for enrollment check + progress upsert
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.lessonProgressFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create lesson progress route with path parameter
    const lessonProgressIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LessonProgressIntegration',
      this.lessonProgressFunction.function
    );

    this.httpApi.addRoutes({
      path: '/lesson/{id}/progress',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lessonProgressIntegration
    });

    /**
     * Task 20.1: HLS Video URL Generation Lambda
     *
     * Requirements: 8.2, 8.3, 8.7, 18.3
     * Design: Components § S3 + CloudFront § Signed URL Generation
     *
     * Handles GET /lesson/{id}/video-url. Verifies the caller's session +
     * course enrollment (same pattern as lesson-details/lesson-progress),
     * resolves the lesson's HLS asset, and returns a CloudFront-signed URL
     * for master.m3u8 (1-hour expiration) using the trusted key group
     * created in the Storage stack (Task 18.3).
     *
     * CLOUDFRONT_PRIVATE_KEY is injected from the deploy shell env, the
     * same pattern used for BETTER_AUTH_SECRET — no Secrets Manager cost.
     */
    this.videoUrlGeneratorFunction = new NodejsFunction(this, 'VideoUrlGeneratorFunction', config, {
      functionName: 'video-url-generator',
      entry: 'video-url-generator/index.ts',
      handler: 'handler',
      description: 'HLS video URL generator Lambda (CloudFront signed URLs)',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        CDN_DOMAIN: config.domain.cdnDomain ?? '',
        CLOUDFRONT_KEY_PAIR_ID: process.env.CLOUDFRONT_KEY_PAIR_ID || '',
        CLOUDFRONT_PRIVATE_KEY: process.env.CLOUDFRONT_PRIVATE_KEY || ''
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.videoUrlGeneratorFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create video URL route with path parameter
    const videoUrlIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'VideoUrlIntegration',
      this.videoUrlGeneratorFunction.function
    );

    this.httpApi.addRoutes({
      path: '/lesson/{id}/video-url',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: videoUrlIntegration
    });

    /**
     * Organization Handler Lambda
     *
     * Handles GET /organization and GET /organization/first.
     * Required by the dashboard's root +layout.server.ts (getOrgSiteInfo)
     * on every SSR page load — without this route, organization resolution
     * throws (missing route) and SvelteKit renders its generic 500 page.
     *
     * Auth: PRIVATE_SERVER_KEY (dashboard SSR, no user session) OR a valid
     * Better Auth session (browser calls), mirroring apps/api's
     * authOrApiKeyMiddleware.
     */
    this.organizationHandlerFunction = new NodejsFunction(this, 'OrganizationHandlerFunction', config, {
      functionName: 'organization-handler',
      entry: 'organization-handler/index.ts',
      handler: 'handler',
      description: 'Organization resolution Lambda (siteName / customDomain / first-org lookup)',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.organizationHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const organizationIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationIntegration',
      this.organizationHandlerFunction.function
    );

    // GET /organization (siteName / customDomain filters)
    this.httpApi.addRoutes({
      path: '/organization',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationIntegration
    });

    // GET /organization/first (self-hosted single-org mode)
    this.httpApi.addRoutes({
      path: '/organization/first',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationIntegration
    });

    // POST /organization/auto-join (requires a valid session, no org-role check)
    this.httpApi.addRoutes({
      path: '/organization/auto-join',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationIntegration
    });

    /**
     * Organization Courses Lambda — GET /organization/courses/{public,enrolled,recommended}
     * and GET /organization/courses.
     *
     * Mirrors apps/api/src/routes/organization/organization.ts's four
     * `/courses*` handlers. Required by the dashboard's org + course
     * features (public catalog, LMS "my courses", "explore", instructor
     * course-management list) — see organization-courses-handler/index.ts
     * for the full route-to-handler mapping.
     *
     * Auth: /courses/public is unauthenticated; the other three require a
     * valid Better Auth session AND org membership (cio-org-id header +
     * orgRoles from the session), matching apps/api's authMiddleware +
     * orgMemberMiddleware. /courses additionally requires ADMIN/TUTOR role.
     */
    this.organizationCoursesHandlerFunction = new NodejsFunction(this, 'OrganizationCoursesHandlerFunction', config, {
      functionName: 'organization-courses-handler',
      entry: 'organization-courses-handler/index.ts',
      handler: 'handler',
      description: 'Organization courses Lambda (public / enrolled / recommended / org course listing)',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.organizationCoursesHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const organizationCoursesIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationCoursesIntegration',
      this.organizationCoursesHandlerFunction.function
    );

    // GET /organization/courses/public (no auth)
    this.httpApi.addRoutes({
      path: '/organization/courses/public',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationCoursesIntegration
    });

    // GET /organization/courses/enrolled (auth + org membership)
    this.httpApi.addRoutes({
      path: '/organization/courses/enrolled',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationCoursesIntegration
    });

    // GET /organization/courses/recommended (auth + org membership)
    this.httpApi.addRoutes({
      path: '/organization/courses/recommended',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationCoursesIntegration
    });

    // GET /organization/courses (auth + org membership, ADMIN/TUTOR only)
    this.httpApi.addRoutes({
      path: '/organization/courses',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationCoursesIntegration
    });

    /**
     * Organization Setup Lambda — GET /organization/setup.
     *
     * Mirrors apps/api/src/routes/organization/organization.ts's
     * `.get('/setup', ...)` handler (getOrgSetupData). Required by the
     * dashboard's org onboarding checklist — see
     * organization-setup-handler/index.ts for details.
     *
     * Auth: none — matches Hono, which registers no middleware on this route.
     */
    this.organizationSetupHandlerFunction = new NodejsFunction(this, 'OrganizationSetupHandlerFunction', config, {
      functionName: 'organization-setup-handler',
      entry: 'organization-setup-handler/index.ts',
      handler: 'handler',
      description: 'Organization setup progress Lambda (siteName -> setup checklist data)',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db bundled
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.organizationSetupHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const organizationSetupIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationSetupIntegration',
      this.organizationSetupHandlerFunction.function
    );

    // GET /organization/setup (no auth)
    this.httpApi.addRoutes({
      path: '/organization/setup',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationSetupIntegration
    });

    /**
     * Organization Team Lambda — team management + link-invite.
     *
     * Mirrors apps/api/src/routes/organization/organization.ts's `/team`,
     * `/team/invite`, `/team/:memberId` and `/link-invite` handlers. Required
     * by the dashboard's org settings "Team" page (invite/remove team
     * members, invite-by-link) — see organization-team-handler/index.ts for
     * the full route-to-handler mapping and the documented KNOWN GAP
     * (invite email send not ported).
     *
     * Auth: GET /team requires ADMIN or TUTOR (requireOrgTeamMember); every
     * mutation (team invite/remove, all three link-invite methods) requires
     * ADMIN (requireOrgAdmin).
     */
    this.organizationTeamHandlerFunction = new NodejsFunction(this, 'OrganizationTeamHandlerFunction', config, {
      functionName: 'organization-team-handler',
      entry: 'organization-team-handler/index.ts',
      handler: 'handler',
      description: 'Organization team management + link-invite Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        // Task 7.2 (.kiro/specs/ses-email-delivery): sends the inviteTeacher
        // email via the shared _shared/email-enqueue.ts SQS helper.
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.organizationTeamHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Permission to enqueue inviteTeacher email sends (Task 7.2)
    apiProps.emailQueue.grantSendMessages(this.organizationTeamHandlerFunction.function);

    const organizationTeamIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationTeamIntegration',
      this.organizationTeamHandlerFunction.function
    );

    // GET /organization/team (ADMIN or TUTOR)
    this.httpApi.addRoutes({
      path: '/organization/team',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationTeamIntegration
    });

    // POST /organization/team/invite (ADMIN only)
    this.httpApi.addRoutes({
      path: '/organization/team/invite',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationTeamIntegration
    });

    // DELETE /organization/team/{memberId} (ADMIN only)
    this.httpApi.addRoutes({
      path: '/organization/team/{memberId}',
      methods: [apigatewayv2.HttpMethod.DELETE],
      integration: organizationTeamIntegration
    });

    // GET/POST/PATCH /organization/link-invite (ADMIN only)
    this.httpApi.addRoutes({
      path: '/organization/link-invite',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST, apigatewayv2.HttpMethod.PATCH],
      integration: organizationTeamIntegration
    });

    /**
     * Organization Audience Lambda — audience (student) management.
     *
     * Mirrors apps/api/src/routes/organization/organization.ts's `/audience`
     * sub-routes. Required by the dashboard's org settings "Audience" page
     * (list/search students, resend/revoke invites, per-student analytics,
     * CSV import, bulk course/cohort assignment) — see
     * organization-audience-handler/index.ts for the full route-to-handler
     * mapping and the documented KNOWN GAPs (invite email sends, invite
     * audit rows, and real course/cohort enrollment during import/
     * assign-courses are not ported in this first pass).
     *
     * Auth: every route requires ADMIN or TUTOR (requireOrgTeamMember)
     * EXCEPT the DELETE, which requires ADMIN only (requireOrgAdmin) — this
     * matches the real Hono middleware wiring exactly, not the informal
     * "all mutations are admin-only" shorthand.
     */
    this.organizationAudienceHandlerFunction = new NodejsFunction(this, 'OrganizationAudienceHandlerFunction', config, {
      functionName: 'organization-audience-handler',
      entry: 'organization-audience-handler/index.ts',
      handler: 'handler',
      description: 'Organization audience (student) management Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        // Task 7.4 (.kiro/specs/ses-email-delivery): sends the
        // studentOrgInvite email via the shared _shared/email-enqueue.ts
        // SQS helper.
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.organizationAudienceHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Permission to enqueue studentOrgInvite email sends (Task 7.4)
    apiProps.emailQueue.grantSendMessages(this.organizationAudienceHandlerFunction.function);

    const organizationAudienceIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationAudienceIntegration',
      this.organizationAudienceHandlerFunction.function
    );

    // GET /organization/audience (ADMIN or TUTOR)
    this.httpApi.addRoutes({
      path: '/organization/audience',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationAudienceIntegration
    });

    // DELETE /organization/audience/{memberId} (ADMIN only)
    this.httpApi.addRoutes({
      path: '/organization/audience/{memberId}',
      methods: [apigatewayv2.HttpMethod.DELETE],
      integration: organizationAudienceIntegration
    });

    // POST /organization/audience/resend-invite (ADMIN or TUTOR)
    this.httpApi.addRoutes({
      path: '/organization/audience/resend-invite',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationAudienceIntegration
    });

    // POST /organization/audience/revoke-invite (ADMIN or TUTOR)
    this.httpApi.addRoutes({
      path: '/organization/audience/revoke-invite',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationAudienceIntegration
    });

    // GET /organization/audience/{userId}/analytics (ADMIN or TUTOR)
    this.httpApi.addRoutes({
      path: '/organization/audience/{userId}/analytics',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationAudienceIntegration
    });

    // POST /organization/audience/import (ADMIN or TUTOR)
    this.httpApi.addRoutes({
      path: '/organization/audience/import',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationAudienceIntegration
    });

    // POST /organization/audience/assign-courses (ADMIN or TUTOR)
    this.httpApi.addRoutes({
      path: '/organization/audience/assign-courses',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationAudienceIntegration
    });

    /**
     * Organization Mutation Lambda — create/update org + plan lifecycle.
     *
     * Mirrors apps/api/src/routes/organization/organization.ts's
     * `.post('/', ...)`, `.put('/', ...)`, `.post('/plan', ...)`,
     * `.put('/plan', ...)` and `.post('/plan/cancel', ...)` handlers.
     * Required by the dashboard's onboarding "create organization" flow, org
     * settings "General" save, and the Polar billing checkout/webhook flows
     * — see organization-mutation-handler/index.ts for the full
     * route-to-handler mapping and the documented KNOWN GAPs (simplified
     * validation, omitted plan-entitlement gates on update, omitted
     * primary-workspace resolution on plan create).
     *
     * Auth: POST / requires a session only (authMiddleware); PUT / requires
     * ADMIN (orgAdminMiddleware / requireOrgAdmin); all three /plan* routes
     * accept EITHER a valid session OR a valid PRIVATE_SERVER_KEY bearer
     * token (authOrApiKeyMiddleware).
     */
    this.organizationMutationHandlerFunction = new NodejsFunction(this, 'OrganizationMutationHandlerFunction', config, {
      functionName: 'organization-mutation-handler',
      entry: 'organization-mutation-handler/index.ts',
      handler: 'handler',
      description: 'Organization create/update + plan lifecycle Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.organizationMutationHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const organizationMutationIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationMutationIntegration',
      this.organizationMutationHandlerFunction.function
    );

    // POST /organization (session only)
    this.httpApi.addRoutes({
      path: '/organization',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationMutationIntegration
    });

    // PUT /organization (ADMIN only)
    this.httpApi.addRoutes({
      path: '/organization',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: organizationMutationIntegration
    });

    // POST /organization/plan (session OR API key)
    this.httpApi.addRoutes({
      path: '/organization/plan',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationMutationIntegration
    });

    // PUT /organization/plan (session OR API key)
    this.httpApi.addRoutes({
      path: '/organization/plan',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: organizationMutationIntegration
    });

    // POST /organization/plan/cancel (session OR API key)
    this.httpApi.addRoutes({
      path: '/organization/plan/cancel',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationMutationIntegration
    });

    /**
     * Dash Handler Lambda
     *
     * Handles the org dashboard analytics routes: GET /dash/stats,
     * /dash/login-activity, /dash/login-streak, /dash/landing-stats,
     * /dash/country-breakdown, /dash/course-funnel, /dash/popular-types,
     * /dash/compliance-overview, and POST /dash/track. Mirrors
     * apps/api/src/routes/dash/stats.ts's `dashAnalyticsRouter` — see
     * dash-handler/index.ts for the full route-to-handler mapping and the
     * documented KNOWN GAPs.
     *
     * Auth: /dash/track is public (no auth); /dash/stats,
     * /dash/landing-stats, /dash/country-breakdown, /dash/course-funnel,
     * /dash/popular-types require org membership (requireOrgMember);
     * /dash/login-activity and /dash/compliance-overview require org ADMIN
     * (requireOrgAdmin); /dash/login-streak requires only a valid session
     * (getSessionUserId, no org check).
     */
    this.dashHandlerFunction = new NodejsFunction(this, 'DashHandlerFunction', config, {
      functionName: 'dash-handler',
      entry: 'dash-handler/index.ts',
      handler: 'handler',
      description:
        'Org dashboard analytics Lambda (stats, login activity/streak, landing/country/funnel/popular-types, compliance overview, track ingest)',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + @cio/core + better-auth bundled
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.dashHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const dashIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'DashIntegration',
      this.dashHandlerFunction.function
    );

    // POST /dash/track (public, no auth)
    this.httpApi.addRoutes({
      path: '/dash/track',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: dashIntegration
    });

    // GET /dash/stats (org member)
    this.httpApi.addRoutes({
      path: '/dash/stats',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/login-activity (org admin)
    this.httpApi.addRoutes({
      path: '/dash/login-activity',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/login-streak (session only)
    this.httpApi.addRoutes({
      path: '/dash/login-streak',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/landing-stats (org member)
    this.httpApi.addRoutes({
      path: '/dash/landing-stats',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/country-breakdown (org member)
    this.httpApi.addRoutes({
      path: '/dash/country-breakdown',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/course-funnel (org member)
    this.httpApi.addRoutes({
      path: '/dash/course-funnel',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/popular-types (org member)
    this.httpApi.addRoutes({
      path: '/dash/popular-types',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/compliance-overview (org admin)
    this.httpApi.addRoutes({
      path: '/dash/compliance-overview',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    /**
     * Onboarding Handler Lambda
     *
     * Handles POST /onboarding/create-org, /onboarding/update-metadata, and
     * /onboarding/complete. Mirrors apps/api/src/routes/onboarding/onboarding.ts's
     * `onboardingRouter` — see onboarding-handler/index.ts for the full
     * route-to-handler mapping and the documented KNOWN GAPs.
     *
     * Auth: all three routes require a valid session only (getSessionUserId,
     * no org-role check) — matches Hono's `authMiddleware`.
     */
    this.onboardingHandlerFunction = new NodejsFunction(this, 'OnboardingHandlerFunction', config, {
      functionName: 'onboarding-handler',
      entry: 'onboarding-handler/index.ts',
      handler: 'handler',
      description: 'Post-signup onboarding Lambda (create org, update metadata, complete)',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + @cio/core + better-auth bundled
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        // Task 7.3 (.kiro/specs/ses-email-delivery): sends the welcome
        // email via the shared _shared/email-enqueue.ts SQS helper.
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.onboardingHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Permission to enqueue welcome email sends (Task 7.3)
    apiProps.emailQueue.grantSendMessages(this.onboardingHandlerFunction.function);

    const onboardingIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OnboardingIntegration',
      this.onboardingHandlerFunction.function
    );

    // POST /onboarding/create-org (session only)
    this.httpApi.addRoutes({
      path: '/onboarding/create-org',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: onboardingIntegration
    });

    // POST /onboarding/update-metadata (session only)
    this.httpApi.addRoutes({
      path: '/onboarding/update-metadata',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: onboardingIntegration
    });

    // POST /onboarding/complete (session only)
    this.httpApi.addRoutes({
      path: '/onboarding/complete',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: onboardingIntegration
    });

    /**
     * Domain Handler Lambda
     *
     * Handles POST /domain (connect/refresh/remove a custom domain).
     * Mirrors apps/api/src/routes/domain/domain.ts's `domainRouter` and its
     * underlying service, apps/api/src/services/org/domain.ts — see
     * domain-handler/index.ts for the full route-to-handler mapping and the
     * documented KNOWN GAPs.
     *
     * Auth: ADMIN only (requireOrgAdmin) — matches Hono's `orgAdminMiddleware`.
     *
     * Talks to the third-party Approximated DNS proxy service via plain
     * `fetch`, so it needs the four APPROXIMATED_* env vars below in
     * addition to the shared authEnv (for requireOrgAdmin's session lookup).
     */
    this.domainHandlerFunction = new NodejsFunction(this, 'DomainHandlerFunction', config, {
      functionName: 'domain-handler',
      entry: 'domain-handler/index.ts',
      handler: 'handler',
      description: 'Custom domain connect/refresh/remove Lambda (Approximated integration)',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + @cio/core + better-auth + tldts bundled
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        APPROXIMATED_API_KEY: process.env.APPROXIMATED_API_KEY || '',
        APPROXIMATED_TARGET_ADDRESS: process.env.APPROXIMATED_TARGET_ADDRESS || '',
        APPROXIMATED_DNS_TARGET_IP: process.env.APPROXIMATED_DNS_TARGET_IP || '',
        APPROXIMATED_DNS_TARGET_CNAME: process.env.APPROXIMATED_DNS_TARGET_CNAME || ''
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.domainHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const domainIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'DomainIntegration',
      this.domainHandlerFunction.function
    );

    // POST /domain (org admin only)
    this.httpApi.addRoutes({
      path: '/domain',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: domainIntegration
    });

    /**
     * Task 6.1 (Fase 3): Course Section Handler
     *
     * Handles:
     * - POST   /course/{courseId}/section
     * - POST   /course/{courseId}/section/promote-ungrouped
     * - PUT    /course/{courseId}/section/{sectionId}
     * - DELETE /course/{courseId}/section/{sectionId}
     * - POST   /course/{courseId}/section/reorder
     *
     * Mirrors apps/api/src/routes/course/section.ts. All five routes use
     * `requireCourseMember` (matching the Hono router's
     * `courseMemberMiddleware` on every route, including writes).
     */
    this.courseSectionHandlerFunction = new NodejsFunction(this, 'CourseSectionHandlerFunction', config, {
      functionName: 'course-section-handler',
      entry: 'course-section-handler/index.ts',
      handler: 'handler',
      description: 'Course section CRUD Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/core + @cio/db + better-auth bundled
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.courseSectionHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const courseSectionIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseSectionIntegration',
      this.courseSectionHandlerFunction.function
    );

    // POST /course/{courseId}/section
    this.httpApi.addRoutes({
      path: '/course/{courseId}/section',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseSectionIntegration
    });

    // POST /course/{courseId}/section/promote-ungrouped
    this.httpApi.addRoutes({
      path: '/course/{courseId}/section/promote-ungrouped',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseSectionIntegration
    });

    // POST /course/{courseId}/section/reorder
    this.httpApi.addRoutes({
      path: '/course/{courseId}/section/reorder',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseSectionIntegration
    });

    // PUT/DELETE /course/{courseId}/section/{sectionId}
    this.httpApi.addRoutes({
      path: '/course/{courseId}/section/{sectionId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseSectionIntegration
    });

    /**
     * Task 6.1 (Fase 3): Course Content Handler
     *
     * Handles:
     * - PUT    /course/{courseId}/content/reorder
     * - PUT    /course/{courseId}/content
     * - DELETE /course/{courseId}/content
     *
     * Mirrors apps/api/src/routes/course/content.ts. All three routes use
     * `requireCourseTeamMember` (matching the Hono router's
     * `courseTeamMemberMiddleware`). KNOWN GAP: the automation-key/MCP
     * branch of `/content/reorder`'s auth is not ported — see
     * course-content-handler/index.ts's module doc.
     */
    this.courseContentHandlerFunction = new NodejsFunction(this, 'CourseContentHandlerFunction', config, {
      functionName: 'course-content-handler',
      entry: 'course-content-handler/index.ts',
      handler: 'handler',
      description: 'Course content bulk update/reorder/delete Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/core + @cio/db + better-auth bundled
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.courseContentHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const courseContentIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseContentIntegration',
      this.courseContentHandlerFunction.function
    );

    // PUT /course/{courseId}/content/reorder
    this.httpApi.addRoutes({
      path: '/course/{courseId}/content/reorder',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: courseContentIntegration
    });

    // PUT/DELETE /course/{courseId}/content
    this.httpApi.addRoutes({
      path: '/course/{courseId}/content',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseContentIntegration
    });

    /**
     * Course Mark Handler — GET /course/{courseId}/mark and /gradebook.
     *
     * Reuses the mark query layer and the same course-member authorization as
     * apps/api/src/routes/course/mark.ts. No external service permissions are
     * required beyond the shared database/session configuration.
     */
    this.courseMarkHandlerFunction = new NodejsFunction(this, 'CourseMarkHandlerFunction', config, {
      functionName: 'course-mark-handler',
      entry: 'course-mark-handler/index.ts',
      handler: 'handler',
      description: 'Course marks and gradebook Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true,
      environment: {
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || '',
        CLOUDFLARE_RENDERING_API_KEY: process.env.CLOUDFLARE_RENDERING_API_KEY || ''
      }
    });

    this.courseMarkHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*']
      })
    );

    const courseMarkIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseMarkIntegration',
      this.courseMarkHandlerFunction.function
    );

    this.httpApi.addRoutes({
      path: '/course/{courseId}/mark',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseMarkIntegration
    });

    this.httpApi.addRoutes({
      path: '/course/{courseId}/mark/gradebook',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseMarkIntegration
    });

    /**
     * Course Attendance Handler — POST /course/{courseId}/attendance.
     *
     * Reuses ZAttendanceUpsert and the DB upsert query used by Hono. The
     * route is course-member scoped and has no queue or storage dependency.
     */
    this.courseAttendanceHandlerFunction = new NodejsFunction(this, 'CourseAttendanceHandlerFunction', config, {
      functionName: 'course-attendance-handler',
      entry: 'course-attendance-handler/index.ts',
      handler: 'handler',
      description: 'Course attendance upsert Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true,
      environment: {
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    this.courseAttendanceHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*']
      })
    );

    const courseAttendanceIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseAttendanceIntegration',
      this.courseAttendanceHandlerFunction.function
    );

    this.httpApi.addRoutes({
      path: '/course/{courseId}/attendance',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseAttendanceIntegration
    });

    /**
     * Course Compliance Handler — GET/POST /course/{courseId}/compliance*.
     *
     * Mirrors apps/api/src/routes/course/compliance.ts. Course overview and
     * mutations require course-team membership; learner history allows any
     * course member and applies the learner/team access check in the handler.
     */
    this.courseComplianceHandlerFunction = new NodejsFunction(this, 'CourseComplianceHandlerFunction', config, {
      functionName: 'course-compliance-handler',
      entry: 'course-compliance-handler/index.ts',
      handler: 'handler',
      description: 'Course compliance overview, history, and mutations Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true,
      environment: {
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    this.courseComplianceHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*']
      })
    );

    const courseComplianceIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseComplianceIntegration',
      this.courseComplianceHandlerFunction.function
    );

    this.httpApi.addRoutes({
      path: '/course/{courseId}/compliance',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseComplianceIntegration
    });

    this.httpApi.addRoutes({
      path: '/course/{courseId}/compliance/learners/{profileId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseComplianceIntegration
    });

    this.httpApi.addRoutes({
      path: '/course/{courseId}/compliance/reset',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseComplianceIntegration
    });

    this.httpApi.addRoutes({
      path: '/course/{courseId}/compliance/extend',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseComplianceIntegration
    });

    this.httpApi.addRoutes({
      path: '/course/{courseId}/compliance/waive',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseComplianceIntegration
    });

    /**
     * Course Newsfeed Handler — feed, reaction, comment, and thread routes.
     *
     * Mirrors apps/api/src/routes/course/newsfeed.ts. Notifications are
     * enqueued through Email_Queue and processed by email-worker.
     */
    this.courseNewsfeedHandlerFunction = new NodejsFunction(this, 'CourseNewsfeedHandlerFunction', config, {
      functionName: 'course-newsfeed-handler',
      entry: 'course-newsfeed-handler/index.ts',
      handler: 'handler',
      description: 'Course newsfeed, reactions, comments, and threads Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true,
      externalNodeModules: ['isomorphic-dompurify'],
      environment: {
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });

    this.courseNewsfeedHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*']
      })
    );

    const courseNewsfeedIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseNewsfeedIntegration',
      this.courseNewsfeedHandlerFunction.function
    );
    apiProps.emailQueue.grantSendMessages(this.courseNewsfeedHandlerFunction.function);

    this.httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: courseNewsfeedIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed/{feedId}',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseNewsfeedIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed/{feedId}/react',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: courseNewsfeedIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed/{feedId}/comments',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseNewsfeedIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed/{feedId}/comment',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseNewsfeedIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed/comment/{commentId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseNewsfeedIntegration
    });

    /** Course presigned upload/download URLs. */
    this.coursePresignHandlerFunction = new NodejsFunction(this, 'CoursePresignHandlerFunction', config, {
      functionName: 'course-presign-handler',
      entry: 'course-presign-handler/index.ts',
      handler: 'handler',
      description: 'Course video and document presigned URL Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true,
      environment: {
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });
    this.coursePresignHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['cloudwatch:PutMetricData'], resources: ['*'] })
    );
    const coursePresignIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CoursePresignIntegration',
      this.coursePresignHandlerFunction.function
    );
    this.httpApi.addRoutes({
      path: '/course/presign/{proxy+}',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: coursePresignIntegration
    });

    /** Public payment request form endpoint. */
    this.coursePaymentRequestHandlerFunction = new NodejsFunction(this, 'CoursePaymentRequestHandlerFunction', config, {
      functionName: 'course-payment-request-handler',
      entry: 'course-payment-request-handler/index.ts',
      handler: 'handler',
      description: 'Public course payment request Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true,
      environment: {
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });
    this.coursePaymentRequestHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['cloudwatch:PutMetricData'], resources: ['*'] })
    );
    apiProps.emailQueue.grantSendMessages(this.coursePaymentRequestHandlerFunction.function);
    const coursePaymentRequestIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CoursePaymentRequestIntegration',
      this.coursePaymentRequestHandlerFunction.function
    );
    this.httpApi.addRoutes({
      path: '/course/{courseId}/payment-request',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: coursePaymentRequestIntegration
    });

    /** Public stateless course utilities, currently Katex rendering. */
    this.courseUtilityHandlerFunction = new NodejsFunction(this, 'CourseUtilityHandlerFunction', config, {
      functionName: 'course-utility-handler',
      entry: 'course-utility-handler/index.ts',
      handler: 'handler',
      description: 'Course stateless utility Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true,
      environment: {
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });
    this.courseUtilityHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['cloudwatch:PutMetricData'], resources: ['*'] })
    );
    const courseUtilityIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseUtilityIntegration',
      this.courseUtilityHandlerFunction.function
    );
    this.httpApi.addRoutes({
      path: '/course/katex',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseUtilityIntegration
    });

    const courseDownloadIntegration = courseUtilityIntegration;
    this.httpApi.addRoutes({
      path: '/course/{courseId}/download/{proxy+}',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseDownloadIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/download/{proxy+}',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseDownloadIntegration
    });

    /** Course member management and progress reset routes. */
    this.coursePeopleHandlerFunction = new NodejsFunction(this, 'CoursePeopleHandlerFunction', config, {
      functionName: 'course-people-handler',
      entry: 'course-people-handler/index.ts',
      handler: 'handler',
      description: 'Course member management Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true,
      externalNodeModules: ['isomorphic-dompurify'],
      environment: {
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });
    this.coursePeopleHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['cloudwatch:PutMetricData'], resources: ['*'] })
    );
    apiProps.emailQueue.grantSendMessages(this.coursePeopleHandlerFunction.function);
    const coursePeopleIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CoursePeopleIntegration',
      this.coursePeopleHandlerFunction.function
    );
    this.httpApi.addRoutes({
      path: '/course/{courseId}/members',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: coursePeopleIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/members/{memberId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: coursePeopleIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/members/{memberId}/reset-progress',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: coursePeopleIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/members/{userId}/analytics',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: coursePeopleIntegration
    });

    /** Course invite creation, audit, and revocation routes. */
    this.courseInviteHandlerFunction = new NodejsFunction(this, 'CourseInviteHandlerFunction', config, {
      functionName: 'course-invite-handler',
      entry: 'course-invite-handler/index.ts',
      handler: 'handler',
      description: 'Course student invitation Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true,
      environment: {
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });
    this.courseInviteHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['cloudwatch:PutMetricData'], resources: ['*'] })
    );
    apiProps.emailQueue.grantSendMessages(this.courseInviteHandlerFunction.function);
    const courseInviteIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseInviteIntegration',
      this.courseInviteHandlerFunction.function
    );
    this.httpApi.addRoutes({
      path: '/course/{courseId}/invites',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: courseInviteIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/invites/{inviteId}/revoke',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseInviteIntegration
    });
    this.httpApi.addRoutes({
      path: '/course/{courseId}/invites/{inviteId}/audit',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseInviteIntegration
    });

    /**
     * Task 6.3 (Fase 3): Lesson Extended Handler
     *
     * Handles the lesson sub-routes not covered by lesson-details /
     * lesson-progress / video-url-generator:
     * - GET/POST      /course/{courseId}/lesson/{lessonId}/comment
     * - PUT/DELETE    /course/{courseId}/lesson/comment/{commentId}
     * - GET/PUT       /course/{courseId}/lesson/{lessonId}/completion
     * - GET/PUT       /course/{courseId}/lesson/{lessonId}/watch-progress
     * - GET           /course/{courseId}/lesson/{lessonId}/history
     * - GET/POST      /course/{courseId}/lesson/{lessonId}/language
     * - GET/PUT       /course/{courseId}/lesson/{lessonId}/language/{locale}
     *
     * Mirrors apps/api/src/routes/course/lesson.ts's comment/completion/
     * watch-progress/history sub-routes plus
     * apps/api/src/routes/course/lesson-language.ts. All routes use
     * `requireCourseMember` (matching the Hono router's
     * `courseMemberMiddleware` on every one of these routes). KNOWN GAP:
     * evaluateCourseCertification is not fired after lesson completion /
     * watch-progress-driven completion — see
     * lesson-extended-handler/index.ts's module doc.
     */
    this.lessonExtendedHandlerFunction = new NodejsFunction(this, 'LessonExtendedHandlerFunction', config, {
      functionName: 'lesson-extended-handler',
      entry: 'lesson-extended-handler/index.ts',
      handler: 'handler',
      description: 'Lesson comment/completion/watch-progress/history/language Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/core + @cio/db + better-auth bundled
      // Comment + language services call sanitizeHtml/sanitizeOptionalHtml
      // (isomorphic-dompurify -> jsdom), which reads its default stylesheet
      // relative to its own __dirname at import time. esbuild's
      // single-file bundle breaks that path resolution and crashes on cold
      // start (ENOENT). Install as real node_modules instead of bundling —
      // same workaround as course-mutation-handler.
      externalNodeModules: ['isomorphic-dompurify'],
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.lessonExtendedHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    apiProps.emailQueue.grantSendMessages(this.lessonExtendedHandlerFunction.function);

    const lessonExtendedIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LessonExtendedIntegration',
      this.lessonExtendedHandlerFunction.function
    );

    // GET/POST /course/{courseId}/lesson/{lessonId}/comment
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/comment',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: lessonExtendedIntegration
    });

    // PUT/DELETE /course/{courseId}/lesson/comment/{commentId}
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/comment/{commentId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: lessonExtendedIntegration
    });

    // GET/PUT /course/{courseId}/lesson/{lessonId}/completion
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/completion',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT],
      integration: lessonExtendedIntegration
    });

    // GET/PUT /course/{courseId}/lesson/{lessonId}/watch-progress
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/watch-progress',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT],
      integration: lessonExtendedIntegration
    });

    // GET /course/{courseId}/lesson/{lessonId}/history
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/history',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lessonExtendedIntegration
    });

    // GET/POST /course/{courseId}/lesson/{lessonId}/language
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/language',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: lessonExtendedIntegration
    });

    // GET/PUT /course/{courseId}/lesson/{lessonId}/language/{locale}
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/language/{locale}',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT],
      integration: lessonExtendedIntegration
    });

    /**
     * Task: Lesson Mutation Handler
     *
     * Handles the lesson CRUD routes not covered by lesson-details (GET
     * /course/{courseId}/lesson/{lessonId}) or lesson-extended-handler
     * (comment/completion/watch-progress/history/language sub-routes):
     * - GET    /course/{courseId}/lesson              (list)
     * - POST   /course/{courseId}/lesson               (create)
     * - PUT    /course/{courseId}/lesson/{lessonId}    (update)
     * - DELETE /course/{courseId}/lesson/{lessonId}    (delete)
     * - POST   /course/{courseId}/lesson/reorder        (reorder)
     *
     * Mirrors the "Lesson CRUD routes" section of apps/api/src/routes/
     * course/lesson.ts. All five routes use `requireCourseMember`
     * (matching the Hono router's `courseMemberMiddleware` on every route,
     * including writes). This was the last remaining gap in course
     * authoring from AWS: without it, sections created via
     * course-section-handler had no way to be populated with lessons.
     * KNOWN GAPS (notify-session-update, download/pdf) are documented in
     * lesson-mutation-handler/index.ts's module doc; the dispatcher
     * returns a clean 404 for both rather than crashing.
     */
    this.lessonMutationHandlerFunction = new NodejsFunction(this, 'LessonMutationHandlerFunction', config, {
      functionName: 'lesson-mutation-handler',
      entry: 'lesson-mutation-handler/index.ts',
      handler: 'handler',
      description: 'Lesson CRUD (create/list/update/delete/reorder) Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/core + @cio/db + better-auth bundled
      // @cio/core/services/lesson/lesson (the module this handler imports
      // createLesson/updateLessonService/deleteLessonService/listLessons/
      // reorderLessons from) also has a module-level `sanitizeHtml` import
      // (isomorphic-dompurify -> jsdom) for its comment functions, which we
      // don't call but which still gets bundled since esbuild bundles the
      // whole module. jsdom reads its default stylesheet relative to its
      // own __dirname at import time, which esbuild's single-file bundle
      // breaks (ENOENT ".../default-stylesheet.css" on cold start —
      // confirmed for this handler, same as course-mutation-handler /
      // lesson-extended-handler). Install as real node_modules instead of
      // bundling.
      externalNodeModules: ['isomorphic-dompurify'],
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.lessonMutationHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const lessonMutationIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LessonMutationIntegration',
      this.lessonMutationHandlerFunction.function
    );

    // GET/POST /course/{courseId}/lesson
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: lessonMutationIntegration
    });

    // POST /course/{courseId}/lesson/reorder
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/reorder',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lessonMutationIntegration
    });

    // PUT/DELETE /course/{courseId}/lesson/{lessonId}
    // Note: GET on this exact path is already registered above to
    // lessonDetailsIntegration (the dashboard-compat alias) — HTTP API
    // allows different methods on the same path to route to different
    // integrations, so this only adds PUT/DELETE.
    this.httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: lessonMutationIntegration
    });

    /**
     * Task 6.11 (Fase 3): Invite Handler
     *
     * Handles the organization/link invite accept flows:
     * - GET  /invite/organization/pending
     * - POST /invite/organization/{inviteId}/accept-by-id
     * - GET  /invite/organization/{token}/preview
     * - POST /invite/organization/{token}/accept
     * - GET  /invite/link/{token}/preview
     * - POST /invite/link/{token}/accept
     *
     * Mirrors apps/api/src/routes/invite/invite.ts's `inviteRouter`. This
     * route group had NO Lambda at all prior to this change — every
     * "Accept invitation" link 404'd at API Gateway. `GET /invite/student/
     * {token}` (course-level invite preview) is NOT included — see
     * invite-handler/index.ts's module doc KNOWN GAP (b); the dispatcher
     * returns a clean 404 for it rather than crashing.
     *
     * Auth is mixed per-route, matching the real Hono middleware exactly:
     * `pending`/`{inviteId}/accept-by-id`/`{token}/accept` (org + link)
     * require a session (getSessionUser); `{token}/preview` (org + link)
     * require the PRIVATE_SERVER_KEY API key (isValidApiKey), matching the
     * dashboard's SSR-only preview calls.
     */
    this.inviteHandlerFunction = new NodejsFunction(this, 'InviteHandlerFunction', config, {
      functionName: 'invite-handler',
      entry: 'invite-handler/index.ts',
      handler: 'handler',
      description: 'Organization/link invite preview + accept Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled for session validation
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs)
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.inviteHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const inviteIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'InviteIntegration',
      this.inviteHandlerFunction.function
    );

    // GET /invite/organization/pending (session, lenient)
    this.httpApi.addRoutes({
      path: '/invite/organization/pending',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: inviteIntegration
    });

    // POST /invite/organization/{inviteId}/accept-by-id (session)
    this.httpApi.addRoutes({
      path: '/invite/organization/{inviteId}/accept-by-id',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: inviteIntegration
    });

    // GET /invite/organization/{token}/preview (API key)
    this.httpApi.addRoutes({
      path: '/invite/organization/{token}/preview',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: inviteIntegration
    });

    // POST /invite/organization/{token}/accept (session)
    this.httpApi.addRoutes({
      path: '/invite/organization/{token}/accept',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: inviteIntegration
    });

    // GET /invite/link/{token}/preview (API key)
    this.httpApi.addRoutes({
      path: '/invite/link/{token}/preview',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: inviteIntegration
    });

    // POST /invite/link/{token}/accept (session)
    this.httpApi.addRoutes({
      path: '/invite/link/{token}/accept',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: inviteIntegration
    });

    /**
     * Task: Course Exercise Handler
     *
     * Handles:
     * - GET    /course/{courseId}/exercise
     * - GET    /course/{courseId}/exercise/{exerciseId}/submissions
     * - POST   /course/{courseId}/exercise/{exerciseId}/notify              (KNOWN GAP -> 404)
     * - GET    /course/{courseId}/exercise/{exerciseId}/notify/{jobId}      (KNOWN GAP -> 404)
     * - GET    /course/{courseId}/exercise/{exerciseId}
     * - POST   /course/{courseId}/exercise
     * - POST   /course/{courseId}/exercise/from-template
     * - PUT    /course/{courseId}/exercise/{exerciseId}
     * - DELETE /course/{courseId}/exercise/{exerciseId}
     * - POST   /course/{courseId}/exercise/{exerciseId}/submission          (the core "take a quiz" action)
     * - POST   /course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/init
     * - POST   /course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/complete
     * - GET    /course/{courseId}/exercise/{exerciseId}/submission/{submissionId}/question/{questionId}/video-recording/playback
     * - GET    /course/{courseId}/exercise/template
     * - GET    /course/{courseId}/exercise/template/{id}
     * - GET    /course/{courseId}/exercise/template/tag/{tag}
     *
     * Mirrors apps/api/src/routes/course/exercise.ts's `exerciseRouter`.
     * Prior to this task there was NO Lambda for any
     * `/course/{courseId}/exercise*` route — students could not take an
     * exercise/quiz at all via AWS. KNOWN GAPS (automation-key/MCP auth,
     * notify/notify-status, compliance-cycle sync, certificate issuance)
     * are documented in course-exercise-handler/index.ts's module doc.
     */
    this.courseExerciseHandlerFunction = new NodejsFunction(this, 'CourseExerciseHandlerFunction', config, {
      functionName: 'course-exercise-handler',
      entry: 'course-exercise-handler/index.ts',
      handler: 'handler',
      description: 'Exercise CRUD, submission creation/auto-grading, templates, video-recording answers Lambda',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/core + @cio/db + @cio/question-types + better-auth bundled
      // @cio/core/services/exercise/exercise imports sanitizeHtml/
      // sanitizeOptionalHtml/sanitizeUnknownStrings at module scope
      // (isomorphic-dompurify -> jsdom), which reads its default
      // stylesheet relative to its own on-disk package location at
      // import time. esbuild's single-file bundle breaks that (ENOENT on
      // cold start — confirmed for course-mutation-handler/
      // lesson-extended-handler/lesson-mutation-handler). Install as real
      // node_modules instead of bundling — same workaround.
      externalNodeModules: ['isomorphic-dompurify'],
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        // Needed to enqueue the teacher-facing submissionReceived email
        // fired from createSubmissionService (SQS, not BullMQ).
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.courseExerciseHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Permission to enqueue submissionReceived email sends
    apiProps.emailQueue.grantSendMessages(this.courseExerciseHandlerFunction.function);

    const courseExerciseIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseExerciseIntegration',
      this.courseExerciseHandlerFunction.function
    );

    // GET/POST /course/{courseId}/exercise
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // POST /course/{courseId}/exercise/from-template
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/from-template',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/template
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/template',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/template/tag/{tag}
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/template/tag/{tag}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/template/{id}
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/template/{id}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    // GET/PUT/DELETE /course/{courseId}/exercise/{exerciseId}
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/{exerciseId}/submissions
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/submissions',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    // POST /course/{courseId}/exercise/{exerciseId}/submission
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/submission',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // POST /course/{courseId}/exercise/{exerciseId}/notify (KNOWN GAP -> 404)
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/notify',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/{exerciseId}/notify/{jobId} (KNOWN GAP -> 404)
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/notify/{jobId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    // POST /course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/init
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/init',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // POST /course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/complete
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/complete',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/{exerciseId}/submission/{submissionId}/question/{questionId}/video-recording/playback
    this.httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/submission/{submissionId}/question/{questionId}/video-recording/playback',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    /**
     * Task: Course Submission Handler
     *
     * Handles:
     * - GET    /course/{courseId}/submission/for-grading
     * - PUT    /course/{courseId}/submission/{submissionId}
     * - DELETE /course/{courseId}/submission/{submissionId}
     * - PUT    /course/{courseId}/submission/{submissionId}/answer
     * - PUT    /course/{courseId}/submission/{submissionId}/grades
     *
     * Mirrors apps/api/src/routes/course/submission.ts's
     * `submissionRouter`. All five routes are team-only
     * (courseTeamMemberMiddleware in Hono -> requireCourseTeamMember
     * here). KNOWN GAP: compliance-cycle progress sync is not fired on
     * grading transitions — see course-submission-handler/index.ts's
     * module doc.
     */
    this.courseSubmissionHandlerFunction = new NodejsFunction(this, 'CourseSubmissionHandlerFunction', config, {
      functionName: 'course-submission-handler',
      entry: 'course-submission-handler/index.ts',
      handler: 'handler',
      description: 'Submission grading/management Lambda (for-grading board, update, delete, answer, grades)',
      memorySize: 512,
      timeout: 15,
      bundleFromMonorepoRoot: true, // Needs @cio/db + @cio/question-types + better-auth bundled
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        CONNECTION_TIMEOUT_MS: String(config.database.connectionTimeoutMs),
        // Needed to enqueue the student-facing submissionGraded email
        // fired from updateSubmissionService/updateSubmissionGradesBatch
        // (SQS, not BullMQ).
        EMAIL_QUEUE_URL: apiProps.emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    this.courseSubmissionHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Permission to enqueue submissionGraded email sends
    apiProps.emailQueue.grantSendMessages(this.courseSubmissionHandlerFunction.function);

    const courseSubmissionIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseSubmissionIntegration',
      this.courseSubmissionHandlerFunction.function
    );

    // GET /course/{courseId}/submission/for-grading
    this.httpApi.addRoutes({
      path: '/course/{courseId}/submission/for-grading',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseSubmissionIntegration
    });

    // PUT/DELETE /course/{courseId}/submission/{submissionId}
    this.httpApi.addRoutes({
      path: '/course/{courseId}/submission/{submissionId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseSubmissionIntegration
    });

    // PUT /course/{courseId}/submission/{submissionId}/answer
    this.httpApi.addRoutes({
      path: '/course/{courseId}/submission/{submissionId}/answer',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: courseSubmissionIntegration
    });

    // PUT /course/{courseId}/submission/{submissionId}/grades
    this.httpApi.addRoutes({
      path: '/course/{courseId}/submission/{submissionId}/grades',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: courseSubmissionIntegration
    });

    // TODO: In subsequent tasks, we will:
    // 1. Implement migration router Lambda - Task 9.1
    // 2. Create Lambda functions for domain handlers - Tasks 8-11, 13-15
    // 3. Configure routing and integrations

    // Outputs
    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: this.httpApi.url!,
      description: 'HTTP API Gateway URL',
      exportName: `${config.environmentName}-HttpApiUrl`
    });

    new cdk.CfnOutput(this, 'HttpApiId', {
      value: this.httpApi.httpApiId,
      description: 'HTTP API Gateway ID',
      exportName: `${config.environmentName}-HttpApiId`
    });

    new cdk.CfnOutput(this, 'HealthCheckUrl', {
      value: `${this.httpApi.url}health`,
      description: 'Health check endpoint URL'
    });

    new cdk.CfnOutput(this, 'NeonTestFunctionName', {
      value: this.neonTestFunction.function.functionName,
      description: 'Neon test Lambda function name',
      exportName: `${config.environmentName}-NeonTestFunctionName`
    });

    new cdk.CfnOutput(this, 'NeonTestFunctionArn', {
      value: this.neonTestFunction.function.functionArn,
      description: 'Neon test Lambda function ARN'
    });

    new cdk.CfnOutput(this, 'NeonTestInvokeCommand', {
      value: `aws lambda invoke --function-name ${this.neonTestFunction.function.functionName} --region ${config.region} /tmp/neon-test-output.json && cat /tmp/neon-test-output.json | jq`,
      description: 'Command to invoke Neon test Lambda'
    });

    new cdk.CfnOutput(this, 'CourseListingFunctionName', {
      value: this.courseListingFunction.function.functionName,
      description: 'Course listing Lambda function name',
      exportName: `${config.environmentName}-CourseListingFunctionName`
    });

    new cdk.CfnOutput(this, 'CourseListingFunctionArn', {
      value: this.courseListingFunction.function.functionArn,
      description: 'Course listing Lambda function ARN'
    });

    new cdk.CfnOutput(this, 'CourseListingUrl', {
      value: `${this.httpApi.url}course`,
      description: 'Course listing endpoint URL'
    });

    new cdk.CfnOutput(this, 'CourseListingTestCommand', {
      value: `curl "${this.httpApi.url}course?orgId=<ORG_ID>&page=1&limit=20"`,
      description: 'Command to test course listing endpoint'
    });

    new cdk.CfnOutput(this, 'CourseDetailsFunctionName', {
      value: this.courseDetailsFunction.function.functionName,
      description: 'Course details Lambda function name',
      exportName: `${config.environmentName}-CourseDetailsFunctionName`
    });

    new cdk.CfnOutput(this, 'CourseDetailsFunctionArn', {
      value: this.courseDetailsFunction.function.functionArn,
      description: 'Course details Lambda function ARN'
    });

    new cdk.CfnOutput(this, 'CourseDetailsUrl', {
      value: `${this.httpApi.url}course/{id}`,
      description: 'Course details endpoint URL (replace {id} with course UUID)'
    });

    new cdk.CfnOutput(this, 'CourseDetailsTestCommand', {
      value: `curl "${this.httpApi.url}course/<COURSE_ID>"`,
      description: 'Command to test course details endpoint'
    });

    new cdk.CfnOutput(this, 'CourseEnrollmentFunctionName', {
      value: this.courseEnrollmentFunction.function.functionName,
      description: 'Course enrollment Lambda function name',
      exportName: `${config.environmentName}-CourseEnrollmentFunctionName`
    });

    new cdk.CfnOutput(this, 'CourseEnrollmentFunctionArn', {
      value: this.courseEnrollmentFunction.function.functionArn,
      description: 'Course enrollment Lambda function ARN'
    });

    new cdk.CfnOutput(this, 'CourseEnrollmentUrl', {
      value: `${this.httpApi.url}course/{id}/enroll`,
      description: 'Course enrollment endpoint URL (replace {id} with course UUID)'
    });

    new cdk.CfnOutput(this, 'CourseEnrollmentTestCommand', {
      value: `curl -X POST "${this.httpApi.url}course/<COURSE_ID>/enroll" -H "Authorization: Bearer <JWT_TOKEN>"`,
      description: 'Command to test course enrollment endpoint'
    });

    new cdk.CfnOutput(this, 'LessonListingFunctionName', {
      value: this.lessonListingFunction.function.functionName,
      description: 'Lesson listing Lambda function name',
      exportName: `${config.environmentName}-LessonListingFunctionName`
    });

    new cdk.CfnOutput(this, 'LessonListingFunctionArn', {
      value: this.lessonListingFunction.function.functionArn,
      description: 'Lesson listing Lambda function ARN'
    });

    new cdk.CfnOutput(this, 'LessonListingUrl', {
      value: `${this.httpApi.url}course/{id}/lessons`,
      description: 'Lesson listing endpoint URL (replace {id} with course UUID)'
    });

    new cdk.CfnOutput(this, 'LessonListingTestCommand', {
      value: `curl "${this.httpApi.url}course/<COURSE_ID>/lessons"`,
      description: 'Command to test lesson listing endpoint'
    });

    new cdk.CfnOutput(this, 'LessonDetailsFunctionName', {
      value: this.lessonDetailsFunction.function.functionName,
      description: 'Lesson details Lambda function name',
      exportName: `${config.environmentName}-LessonDetailsFunctionName`
    });

    new cdk.CfnOutput(this, 'LessonDetailsFunctionArn', {
      value: this.lessonDetailsFunction.function.functionArn,
      description: 'Lesson details Lambda function ARN'
    });

    new cdk.CfnOutput(this, 'LessonDetailsUrl', {
      value: `${this.httpApi.url}lesson/{id}`,
      description: 'Lesson details endpoint URL (replace {id} with lesson UUID)'
    });

    new cdk.CfnOutput(this, 'LessonDetailsTestCommand', {
      value: `curl "${this.httpApi.url}lesson/<LESSON_ID>"`,
      description: 'Command to test lesson details endpoint'
    });

    new cdk.CfnOutput(this, 'LessonProgressFunctionName', {
      value: this.lessonProgressFunction.function.functionName,
      description: 'Lesson progress Lambda function name',
      exportName: `${config.environmentName}-LessonProgressFunctionName`
    });

    new cdk.CfnOutput(this, 'LessonProgressFunctionArn', {
      value: this.lessonProgressFunction.function.functionArn,
      description: 'Lesson progress Lambda function ARN'
    });

    new cdk.CfnOutput(this, 'LessonProgressUrl', {
      value: `${this.httpApi.url}lesson/{id}/progress`,
      description: 'Lesson progress endpoint URL (replace {id} with lesson UUID)'
    });

    new cdk.CfnOutput(this, 'LessonProgressTestCommand', {
      value: `curl -X POST "${this.httpApi.url}lesson/<LESSON_ID>/progress" -H "Authorization: Bearer <JWT_TOKEN>" -H "Content-Type: application/json" -d '{"percentComplete": 75, "isComplete": false}'`,
      description: 'Command to test lesson progress endpoint'
    });
  }
}
