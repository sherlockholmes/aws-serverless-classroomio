import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/environment';
import { NodejsFunction } from '../../constructs';
import { ApiDomainConstruct, ApiDomainProps } from './shared/domain-base';

/**
 * CourseDomain — groups this domain's Lambda + route construction.
 *
 * All resources are created on the ApiStack scope (this.stackScope), so every
 * CloudFormation logical ID is byte-identical to the pre-refactor single-stack
 * template (see phase6-design §1.1). Function/route/policy construction is
 * reproduced verbatim from the original api-stack.ts.
 */
export class CourseDomain extends ApiDomainConstruct {
  public readonly courseListingFunction: NodejsFunction;
  public readonly courseDetailsFunction: NodejsFunction;
  public readonly courseEnrollmentFunction: NodejsFunction;
  constructor(parentScope: Construct, id: string, config: EnvironmentConfig, props: ApiDomainProps) {
    super(parentScope, id, config, props);

    const scope = this.stackScope;
    const { httpApi, authEnv, emailQueue, sesConfigurationSetName } = this.props;

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
    const courseListingFunction = new NodejsFunction(scope, 'CourseListingFunction', config, {
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
    courseListingFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create course listing route
    const courseListingIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseListingIntegration',
      courseListingFunction.function
    );

    httpApi.addRoutes({
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
    const courseDetailsFunction = new NodejsFunction(scope, 'CourseDetailsFunction', config, {
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
    courseDetailsFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create course details route with path parameter
    const courseDetailsIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseDetailsIntegration',
      courseDetailsFunction.function
    );

    httpApi.addRoutes({
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
    const courseEnrollmentFunction = new NodejsFunction(scope, 'CourseEnrollmentFunction', config, {
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
    courseEnrollmentFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create course enrollment route with path parameter
    const courseEnrollmentIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseEnrollmentIntegration',
      courseEnrollmentFunction.function
    );

    httpApi.addRoutes({
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
    const courseMutationHandlerFunction = new NodejsFunction(scope, 'CourseMutationHandlerFunction', config, {
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
    courseMutationHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const courseMutationIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseMutationIntegration',
      courseMutationHandlerFunction.function
    );

    // POST /course (org ADMIN only)
    httpApi.addRoutes({
      path: '/course',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseMutationIntegration
    });

    // PUT/DELETE /course/{courseId} (course team member)
    httpApi.addRoutes({
      path: '/course/{courseId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseMutationIntegration
    });

    // POST /course/{courseId}/clone (course team member)
    httpApi.addRoutes({
      path: '/course/{courseId}/clone',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseMutationIntegration
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
    const courseSectionHandlerFunction = new NodejsFunction(scope, 'CourseSectionHandlerFunction', config, {
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
    courseSectionHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const courseSectionIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseSectionIntegration',
      courseSectionHandlerFunction.function
    );

    // POST /course/{courseId}/section
    httpApi.addRoutes({
      path: '/course/{courseId}/section',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseSectionIntegration
    });

    // POST /course/{courseId}/section/promote-ungrouped
    httpApi.addRoutes({
      path: '/course/{courseId}/section/promote-ungrouped',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseSectionIntegration
    });

    // POST /course/{courseId}/section/reorder
    httpApi.addRoutes({
      path: '/course/{courseId}/section/reorder',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseSectionIntegration
    });

    // PUT/DELETE /course/{courseId}/section/{sectionId}
    httpApi.addRoutes({
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
    const courseContentHandlerFunction = new NodejsFunction(scope, 'CourseContentHandlerFunction', config, {
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
    courseContentHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const courseContentIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseContentIntegration',
      courseContentHandlerFunction.function
    );

    // PUT /course/{courseId}/content/reorder
    httpApi.addRoutes({
      path: '/course/{courseId}/content/reorder',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: courseContentIntegration
    });

    // PUT/DELETE /course/{courseId}/content
    httpApi.addRoutes({
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
    const courseMarkHandlerFunction = new NodejsFunction(scope, 'CourseMarkHandlerFunction', config, {
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

    courseMarkHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*']
      })
    );

    const courseMarkIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseMarkIntegration',
      courseMarkHandlerFunction.function
    );

    httpApi.addRoutes({
      path: '/course/{courseId}/mark',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseMarkIntegration
    });

    httpApi.addRoutes({
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
    const courseAttendanceHandlerFunction = new NodejsFunction(scope, 'CourseAttendanceHandlerFunction', config, {
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

    courseAttendanceHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*']
      })
    );

    const courseAttendanceIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseAttendanceIntegration',
      courseAttendanceHandlerFunction.function
    );

    httpApi.addRoutes({
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
    const courseComplianceHandlerFunction = new NodejsFunction(scope, 'CourseComplianceHandlerFunction', config, {
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

    courseComplianceHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*']
      })
    );

    const courseComplianceIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseComplianceIntegration',
      courseComplianceHandlerFunction.function
    );

    httpApi.addRoutes({
      path: '/course/{courseId}/compliance',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseComplianceIntegration
    });

    httpApi.addRoutes({
      path: '/course/{courseId}/compliance/learners/{profileId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseComplianceIntegration
    });

    httpApi.addRoutes({
      path: '/course/{courseId}/compliance/reset',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseComplianceIntegration
    });

    httpApi.addRoutes({
      path: '/course/{courseId}/compliance/extend',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseComplianceIntegration
    });

    httpApi.addRoutes({
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
    const courseNewsfeedHandlerFunction = new NodejsFunction(scope, 'CourseNewsfeedHandlerFunction', config, {
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
        EMAIL_QUEUE_URL: emailQueue.queueUrl
      }
    });

    courseNewsfeedHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*']
      })
    );

    const courseNewsfeedIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseNewsfeedIntegration',
      courseNewsfeedHandlerFunction.function
    );
    emailQueue.grantSendMessages(courseNewsfeedHandlerFunction.function);

    httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: courseNewsfeedIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed/{feedId}',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseNewsfeedIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed/{feedId}/react',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: courseNewsfeedIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed/{feedId}/comments',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseNewsfeedIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed/{feedId}/comment',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseNewsfeedIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/newsfeed/comment/{commentId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseNewsfeedIntegration
    });

    /** Course presigned upload/download URLs. */
    const coursePresignHandlerFunction = new NodejsFunction(scope, 'CoursePresignHandlerFunction', config, {
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
    coursePresignHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['cloudwatch:PutMetricData'], resources: ['*'] })
    );
    const coursePresignIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CoursePresignIntegration',
      coursePresignHandlerFunction.function
    );
    httpApi.addRoutes({
      path: '/course/presign/{proxy+}',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: coursePresignIntegration
    });

    /** Public payment request form endpoint. */
    const coursePaymentRequestHandlerFunction = new NodejsFunction(
      scope,
      'CoursePaymentRequestHandlerFunction',
      config,
      {
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
          EMAIL_QUEUE_URL: emailQueue.queueUrl
        }
      }
    );
    coursePaymentRequestHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['cloudwatch:PutMetricData'], resources: ['*'] })
    );
    emailQueue.grantSendMessages(coursePaymentRequestHandlerFunction.function);
    const coursePaymentRequestIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CoursePaymentRequestIntegration',
      coursePaymentRequestHandlerFunction.function
    );
    httpApi.addRoutes({
      path: '/course/{courseId}/payment-request',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: coursePaymentRequestIntegration
    });

    /** Public stateless course utilities, currently Katex rendering. */
    const courseUtilityHandlerFunction = new NodejsFunction(scope, 'CourseUtilityHandlerFunction', config, {
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
    courseUtilityHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['cloudwatch:PutMetricData'], resources: ['*'] })
    );
    const courseUtilityIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseUtilityIntegration',
      courseUtilityHandlerFunction.function
    );
    httpApi.addRoutes({
      path: '/course/katex',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseUtilityIntegration
    });

    const courseDownloadIntegration = courseUtilityIntegration;
    httpApi.addRoutes({
      path: '/course/{courseId}/download/{proxy+}',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseDownloadIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/download/{proxy+}',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseDownloadIntegration
    });

    /** Course member management and progress reset routes. */
    const coursePeopleHandlerFunction = new NodejsFunction(scope, 'CoursePeopleHandlerFunction', config, {
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
        EMAIL_QUEUE_URL: emailQueue.queueUrl
      }
    });
    coursePeopleHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['cloudwatch:PutMetricData'], resources: ['*'] })
    );
    emailQueue.grantSendMessages(coursePeopleHandlerFunction.function);
    const coursePeopleIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CoursePeopleIntegration',
      coursePeopleHandlerFunction.function
    );
    httpApi.addRoutes({
      path: '/course/{courseId}/members',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: coursePeopleIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/members/{memberId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: coursePeopleIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/members/{memberId}/reset-progress',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: coursePeopleIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/members/{userId}/analytics',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: coursePeopleIntegration
    });

    /** Course invite creation, audit, and revocation routes. */
    const courseInviteHandlerFunction = new NodejsFunction(scope, 'CourseInviteHandlerFunction', config, {
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
        EMAIL_QUEUE_URL: emailQueue.queueUrl
      }
    });
    courseInviteHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['cloudwatch:PutMetricData'], resources: ['*'] })
    );
    emailQueue.grantSendMessages(courseInviteHandlerFunction.function);
    const courseInviteIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseInviteIntegration',
      courseInviteHandlerFunction.function
    );
    httpApi.addRoutes({
      path: '/course/{courseId}/invites',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: courseInviteIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/invites/{inviteId}/revoke',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseInviteIntegration
    });
    httpApi.addRoutes({
      path: '/course/{courseId}/invites/{inviteId}/audit',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseInviteIntegration
    });

    this.courseListingFunction = courseListingFunction;
    this.courseDetailsFunction = courseDetailsFunction;
    this.courseEnrollmentFunction = courseEnrollmentFunction;
  }
}
