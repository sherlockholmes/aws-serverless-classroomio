import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/environment';
import { NodejsFunction } from '../../constructs';
import { ApiDomainConstruct, ApiDomainProps } from './shared/domain-base';

/**
 * LearningDomain — groups this domain's Lambda + route construction.
 *
 * All resources are created on the ApiStack scope (this.stackScope), so every
 * CloudFormation logical ID is byte-identical to the pre-refactor single-stack
 * template (see phase6-design §1.1). Function/route/policy construction is
 * reproduced verbatim from the original api-stack.ts.
 */
export class LearningDomain extends ApiDomainConstruct {
  constructor(parentScope: Construct, id: string, config: EnvironmentConfig, props: ApiDomainProps) {
    super(parentScope, id, config, props);

    const scope = this.stackScope;
    const { httpApi, authEnv, emailQueue, sesConfigurationSetName } = this.props;

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
    const courseExerciseHandlerFunction = new NodejsFunction(scope, 'CourseExerciseHandlerFunction', config, {
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
        EMAIL_QUEUE_URL: emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    courseExerciseHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Permission to enqueue submissionReceived email sends
    emailQueue.grantSendMessages(courseExerciseHandlerFunction.function);

    const courseExerciseIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseExerciseIntegration',
      courseExerciseHandlerFunction.function
    );

    // GET/POST /course/{courseId}/exercise
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // POST /course/{courseId}/exercise/from-template
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/from-template',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/template
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/template',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/template/tag/{tag}
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/template/tag/{tag}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/template/{id}
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/template/{id}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    // GET/PUT/DELETE /course/{courseId}/exercise/{exerciseId}
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/{exerciseId}/submissions
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/submissions',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    // POST /course/{courseId}/exercise/{exerciseId}/submission
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/submission',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // POST /course/{courseId}/exercise/{exerciseId}/notify (KNOWN GAP -> 404)
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/notify',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/{exerciseId}/notify/{jobId} (KNOWN GAP -> 404)
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/notify/{jobId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseExerciseIntegration
    });

    // POST /course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/init
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/init',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // POST /course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/complete
    httpApi.addRoutes({
      path: '/course/{courseId}/exercise/{exerciseId}/question/{questionId}/video-recording/upload/complete',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: courseExerciseIntegration
    });

    // GET /course/{courseId}/exercise/{exerciseId}/submission/{submissionId}/question/{questionId}/video-recording/playback
    httpApi.addRoutes({
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
    const courseSubmissionHandlerFunction = new NodejsFunction(scope, 'CourseSubmissionHandlerFunction', config, {
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
        EMAIL_QUEUE_URL: emailQueue.queueUrl
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    courseSubmissionHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // Permission to enqueue submissionGraded email sends
    emailQueue.grantSendMessages(courseSubmissionHandlerFunction.function);

    const courseSubmissionIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'CourseSubmissionIntegration',
      courseSubmissionHandlerFunction.function
    );

    // GET /course/{courseId}/submission/for-grading
    httpApi.addRoutes({
      path: '/course/{courseId}/submission/for-grading',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: courseSubmissionIntegration
    });

    // PUT/DELETE /course/{courseId}/submission/{submissionId}
    httpApi.addRoutes({
      path: '/course/{courseId}/submission/{submissionId}',
      methods: [apigatewayv2.HttpMethod.PUT, apigatewayv2.HttpMethod.DELETE],
      integration: courseSubmissionIntegration
    });

    // PUT /course/{courseId}/submission/{submissionId}/answer
    httpApi.addRoutes({
      path: '/course/{courseId}/submission/{submissionId}/answer',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: courseSubmissionIntegration
    });

    // PUT /course/{courseId}/submission/{submissionId}/grades
    httpApi.addRoutes({
      path: '/course/{courseId}/submission/{submissionId}/grades',
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: courseSubmissionIntegration
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
    const inviteHandlerFunction = new NodejsFunction(scope, 'InviteHandlerFunction', config, {
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
    inviteHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    const inviteIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'InviteIntegration',
      inviteHandlerFunction.function
    );

    // GET /invite/organization/pending (session, lenient)
    httpApi.addRoutes({
      path: '/invite/organization/pending',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: inviteIntegration
    });

    // POST /invite/organization/{inviteId}/accept-by-id (session)
    httpApi.addRoutes({
      path: '/invite/organization/{inviteId}/accept-by-id',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: inviteIntegration
    });

    // GET /invite/organization/{token}/preview (API key)
    httpApi.addRoutes({
      path: '/invite/organization/{token}/preview',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: inviteIntegration
    });

    // POST /invite/organization/{token}/accept (session)
    httpApi.addRoutes({
      path: '/invite/organization/{token}/accept',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: inviteIntegration
    });

    // GET /invite/link/{token}/preview (API key)
    httpApi.addRoutes({
      path: '/invite/link/{token}/preview',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: inviteIntegration
    });

    // POST /invite/link/{token}/accept (session)
    httpApi.addRoutes({
      path: '/invite/link/{token}/accept',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: inviteIntegration
    });
  }
}
