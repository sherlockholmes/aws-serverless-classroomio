import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/environment';
import { NodejsFunction } from '../../constructs';
import { ApiDomainConstruct, ApiDomainProps } from './shared/domain-base';

/**
 * OrganizationDomain — groups this domain's Lambda + route construction.
 *
 * All resources are created on the ApiStack scope (this.stackScope), so every
 * CloudFormation logical ID is byte-identical to the pre-refactor single-stack
 * template (see phase6-design §1.1). Function/route/policy construction is
 * reproduced verbatim from the original api-stack.ts.
 */
export class OrganizationDomain extends ApiDomainConstruct {
  constructor(parentScope: Construct, id: string, config: EnvironmentConfig, props: ApiDomainProps) {
    super(parentScope, id, config, props);

    const scope = this.stackScope;
    const { httpApi, authEnv, emailQueue, sesConfigurationSetName } = this.props;

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
    const organizationHandlerFunction = new NodejsFunction(scope, 'OrganizationHandlerFunction', config, {
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
    organizationHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const organizationIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationIntegration',
      organizationHandlerFunction.function
    );

    // GET /organization (siteName / customDomain filters)
    httpApi.addRoutes({
      path: '/organization',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationIntegration
    });

    // GET /organization/first (self-hosted single-org mode)
    httpApi.addRoutes({
      path: '/organization/first',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationIntegration
    });

    // POST /organization/auto-join (requires a valid session, no org-role check)
    httpApi.addRoutes({
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
    const organizationCoursesHandlerFunction = new NodejsFunction(scope, 'OrganizationCoursesHandlerFunction', config, {
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
    organizationCoursesHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const organizationCoursesIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationCoursesIntegration',
      organizationCoursesHandlerFunction.function
    );

    // GET /organization/courses/public (no auth)
    httpApi.addRoutes({
      path: '/organization/courses/public',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationCoursesIntegration
    });

    // GET /organization/courses/enrolled (auth + org membership)
    httpApi.addRoutes({
      path: '/organization/courses/enrolled',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationCoursesIntegration
    });

    // GET /organization/courses/recommended (auth + org membership)
    httpApi.addRoutes({
      path: '/organization/courses/recommended',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationCoursesIntegration
    });

    // GET /organization/courses (auth + org membership, ADMIN/TUTOR only)
    httpApi.addRoutes({
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
    const organizationSetupHandlerFunction = new NodejsFunction(scope, 'OrganizationSetupHandlerFunction', config, {
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
    organizationSetupHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const organizationSetupIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationSetupIntegration',
      organizationSetupHandlerFunction.function
    );

    // GET /organization/setup (no auth)
    httpApi.addRoutes({
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
    const organizationTeamHandlerFunction = new NodejsFunction(scope, 'OrganizationTeamHandlerFunction', config, {
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
        EMAIL_QUEUE_URL: emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    organizationTeamHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Permission to enqueue inviteTeacher email sends (Task 7.2)
    emailQueue.grantSendMessages(organizationTeamHandlerFunction.function);

    const organizationTeamIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationTeamIntegration',
      organizationTeamHandlerFunction.function
    );

    // GET /organization/team (ADMIN or TUTOR)
    httpApi.addRoutes({
      path: '/organization/team',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationTeamIntegration
    });

    // POST /organization/team/invite (ADMIN only)
    httpApi.addRoutes({
      path: '/organization/team/invite',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationTeamIntegration
    });

    // DELETE /organization/team/{memberId} (ADMIN only)
    httpApi.addRoutes({
      path: '/organization/team/{memberId}',
      methods: [apigatewayv2.HttpMethod.DELETE],
      integration: organizationTeamIntegration
    });

    // GET/POST/PATCH /organization/link-invite (ADMIN only)
    httpApi.addRoutes({
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
    const organizationAudienceHandlerFunction = new NodejsFunction(
      scope,
      'OrganizationAudienceHandlerFunction',
      config,
      {
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
          EMAIL_QUEUE_URL: emailQueue.queueUrl
        }
      }
    );

    // Grant CloudWatch PutMetricData permission for custom metrics
    organizationAudienceHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Permission to enqueue studentOrgInvite email sends (Task 7.4)
    emailQueue.grantSendMessages(organizationAudienceHandlerFunction.function);

    const organizationAudienceIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationAudienceIntegration',
      organizationAudienceHandlerFunction.function
    );

    // GET /organization/audience (ADMIN or TUTOR)
    httpApi.addRoutes({
      path: '/organization/audience',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationAudienceIntegration
    });

    // DELETE /organization/audience/{memberId} (ADMIN only)
    httpApi.addRoutes({
      path: '/organization/audience/{memberId}',
      methods: [apigatewayv2.HttpMethod.DELETE],
      integration: organizationAudienceIntegration
    });

    // POST /organization/audience/resend-invite (ADMIN or TUTOR)
    httpApi.addRoutes({
      path: '/organization/audience/resend-invite',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationAudienceIntegration
    });

    // POST /organization/audience/revoke-invite (ADMIN or TUTOR)
    httpApi.addRoutes({
      path: '/organization/audience/revoke-invite',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationAudienceIntegration
    });

    // GET /organization/audience/{userId}/analytics (ADMIN or TUTOR)
    httpApi.addRoutes({
      path: '/organization/audience/{userId}/analytics',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: organizationAudienceIntegration
    });

    // POST /organization/audience/import (ADMIN or TUTOR)
    httpApi.addRoutes({
      path: '/organization/audience/import',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationAudienceIntegration
    });

    // POST /organization/audience/assign-courses (ADMIN or TUTOR)
    httpApi.addRoutes({
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
    const organizationMutationHandlerFunction = new NodejsFunction(
      scope,
      'OrganizationMutationHandlerFunction',
      config,
      {
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
      }
    );

    // Grant CloudWatch PutMetricData permission for custom metrics
    organizationMutationHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const organizationMutationIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OrganizationMutationIntegration',
      organizationMutationHandlerFunction.function
    );

    // POST /organization (session only)
    httpApi.addRoutes({
      path: '/organization',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationMutationIntegration
    });

    // PUT /organization (ADMIN only)
    httpApi.addRoutes({
      path: '/organization',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: organizationMutationIntegration
    });

    // POST /organization/plan (session OR API key)
    httpApi.addRoutes({
      path: '/organization/plan',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: organizationMutationIntegration
    });

    // PUT /organization/plan (session OR API key)
    httpApi.addRoutes({
      path: '/organization/plan',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: organizationMutationIntegration
    });

    // POST /organization/plan/cancel (session OR API key)
    httpApi.addRoutes({
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
    const dashHandlerFunction = new NodejsFunction(scope, 'DashHandlerFunction', config, {
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
    dashHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const dashIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'DashIntegration',
      dashHandlerFunction.function
    );

    // POST /dash/track (public, no auth)
    httpApi.addRoutes({
      path: '/dash/track',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: dashIntegration
    });

    // GET /dash/stats (org member)
    httpApi.addRoutes({
      path: '/dash/stats',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/login-activity (org admin)
    httpApi.addRoutes({
      path: '/dash/login-activity',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/login-streak (session only)
    httpApi.addRoutes({
      path: '/dash/login-streak',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/landing-stats (org member)
    httpApi.addRoutes({
      path: '/dash/landing-stats',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/country-breakdown (org member)
    httpApi.addRoutes({
      path: '/dash/country-breakdown',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/course-funnel (org member)
    httpApi.addRoutes({
      path: '/dash/course-funnel',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/popular-types (org member)
    httpApi.addRoutes({
      path: '/dash/popular-types',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: dashIntegration
    });

    // GET /dash/compliance-overview (org admin)
    httpApi.addRoutes({
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
    const onboardingHandlerFunction = new NodejsFunction(scope, 'OnboardingHandlerFunction', config, {
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
        EMAIL_QUEUE_URL: emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    onboardingHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Permission to enqueue welcome email sends (Task 7.3)
    emailQueue.grantSendMessages(onboardingHandlerFunction.function);

    const onboardingIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'OnboardingIntegration',
      onboardingHandlerFunction.function
    );

    // POST /onboarding/create-org (session only)
    httpApi.addRoutes({
      path: '/onboarding/create-org',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: onboardingIntegration
    });

    // POST /onboarding/update-metadata (session only)
    httpApi.addRoutes({
      path: '/onboarding/update-metadata',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: onboardingIntegration
    });

    // POST /onboarding/complete (session only)
    httpApi.addRoutes({
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
    const domainHandlerFunction = new NodejsFunction(scope, 'DomainHandlerFunction', config, {
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
    domainHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const domainIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'DomainIntegration',
      domainHandlerFunction.function
    );

    // POST /domain (org admin only)
    httpApi.addRoutes({
      path: '/domain',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: domainIntegration
    });
  }
}
