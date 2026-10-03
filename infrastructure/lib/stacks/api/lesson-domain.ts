import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/environment';
import { NodejsFunction } from '../../constructs';
import { ApiDomainConstruct, ApiDomainProps } from './shared/domain-base';

/**
 * LessonDomain — groups this domain's Lambda + route construction.
 *
 * All resources are created on the ApiStack scope (this.stackScope), so every
 * CloudFormation logical ID is byte-identical to the pre-refactor single-stack
 * template (see phase6-design §1.1). Function/route/policy construction is
 * reproduced verbatim from the original api-stack.ts.
 */
export class LessonDomain extends ApiDomainConstruct {
  public readonly lessonListingFunction: NodejsFunction;
  public readonly lessonDetailsFunction: NodejsFunction;
  public readonly lessonProgressFunction: NodejsFunction;
  constructor(parentScope: Construct, id: string, config: EnvironmentConfig, props: ApiDomainProps) {
    super(parentScope, id, config, props);

    const scope = this.stackScope;
    const { httpApi, authEnv, emailQueue, sesConfigurationSetName } = this.props;

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
    const lessonListingFunction = new NodejsFunction(scope, 'LessonListingFunction', config, {
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
    lessonListingFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create lesson listing route with path parameter
    const lessonListingIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LessonListingIntegration',
      lessonListingFunction.function
    );

    httpApi.addRoutes({
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
    const lessonDetailsFunction = new NodejsFunction(scope, 'LessonDetailsFunction', config, {
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
    lessonDetailsFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create lesson details route with path parameter
    const lessonDetailsIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LessonDetailsIntegration',
      lessonDetailsFunction.function
    );

    httpApi.addRoutes({
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
    httpApi.addRoutes({
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
    const lessonProgressFunction = new NodejsFunction(scope, 'LessonProgressFunction', config, {
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
    lessonProgressFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create lesson progress route with path parameter
    const lessonProgressIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LessonProgressIntegration',
      lessonProgressFunction.function
    );

    httpApi.addRoutes({
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
    const videoUrlGeneratorFunction = new NodejsFunction(scope, 'VideoUrlGeneratorFunction', config, {
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
    videoUrlGeneratorFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Create video URL route with path parameter
    const videoUrlIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'VideoUrlIntegration',
      videoUrlGeneratorFunction.function
    );

    httpApi.addRoutes({
      path: '/lesson/{id}/video-url',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: videoUrlIntegration
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
    const lessonExtendedHandlerFunction = new NodejsFunction(scope, 'LessonExtendedHandlerFunction', config, {
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
        EMAIL_QUEUE_URL: emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    lessonExtendedHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    emailQueue.grantSendMessages(lessonExtendedHandlerFunction.function);

    const lessonExtendedIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LessonExtendedIntegration',
      lessonExtendedHandlerFunction.function
    );

    // GET/POST /course/{courseId}/lesson/{lessonId}/comment
    httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/comment',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: lessonExtendedIntegration
    });

    // PUT/DELETE /course/{courseId}/lesson/comment/{commentId}
    httpApi.addRoutes({
      path: '/course/{courseId}/lesson/comment/{commentId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: lessonExtendedIntegration
    });

    // GET/PUT /course/{courseId}/lesson/{lessonId}/completion
    httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/completion',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT],
      integration: lessonExtendedIntegration
    });

    // GET/PUT /course/{courseId}/lesson/{lessonId}/watch-progress
    httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/watch-progress',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT],
      integration: lessonExtendedIntegration
    });

    // GET /course/{courseId}/lesson/{lessonId}/history
    httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/history',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: lessonExtendedIntegration
    });

    // GET/POST /course/{courseId}/lesson/{lessonId}/language
    httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}/language',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: lessonExtendedIntegration
    });

    // GET/PUT /course/{courseId}/lesson/{lessonId}/language/{locale}
    httpApi.addRoutes({
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
    const lessonMutationHandlerFunction = new NodejsFunction(scope, 'LessonMutationHandlerFunction', config, {
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
    lessonMutationHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const lessonMutationIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'LessonMutationIntegration',
      lessonMutationHandlerFunction.function
    );

    // GET/POST /course/{courseId}/lesson
    httpApi.addRoutes({
      path: '/course/{courseId}/lesson',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: lessonMutationIntegration
    });

    // POST /course/{courseId}/lesson/reorder
    httpApi.addRoutes({
      path: '/course/{courseId}/lesson/reorder',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: lessonMutationIntegration
    });

    // PUT/DELETE /course/{courseId}/lesson/{lessonId}
    // Note: GET on this exact path is already registered above to
    // lessonDetailsIntegration (the dashboard-compat alias) — HTTP API
    // allows different methods on the same path to route to different
    // integrations, so this only adds PUT/DELETE.
    httpApi.addRoutes({
      path: '/course/{courseId}/lesson/{lessonId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: lessonMutationIntegration
    });

    this.lessonListingFunction = lessonListingFunction;
    this.lessonDetailsFunction = lessonDetailsFunction;
    this.lessonProgressFunction = lessonProgressFunction;
  }
}
