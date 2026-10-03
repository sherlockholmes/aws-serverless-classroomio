import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environment';
import { NodejsFunction } from '../constructs';
import { buildAuthEnv } from './api/shared/lambda-defaults';
import { ApiDomainProps } from './api/shared/domain-base';
import { SharedApiInfra } from './api/shared-infra';
import { MessagingDomain } from './api/messaging-domain';
import { IdentityDomain } from './api/identity-domain';
import { AccountDomain } from './api/account-domain';
import { CourseDomain } from './api/course-domain';
import { LessonDomain } from './api/lesson-domain';
import { LearningDomain } from './api/learning-domain';
import { OrganizationDomain } from './api/organization-domain';

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
 *
 * Phase 6 refactor: the ~3000-line monolithic constructor is split into
 * per-domain constructs under `lib/stacks/api/*` plus shared helpers under
 * `lib/stacks/api/shared/*`. Every domain construct creates its resources on
 * THIS stack scope, so the synthesized CloudFormation template (and every
 * logical ID) is byte-identical to the pre-refactor stack, with the single
 * documented exception of the `migration-router` invoke IAM tightening. See
 * `.agents/tasks/phase6-verification.md`.
 */
export class ApiStack extends cdk.Stack {
  public readonly httpApi: apigatewayv2.HttpApi;
  public readonly neonTestFunction: NodejsFunction;
  public readonly migrationRouterFunction: NodejsFunction;
  /**
   * SES domain identity. Only created when a custom domain + hosted zone are
   * configured (Route 53-backed Easy DKIM). Undefined for a no-domain deploy —
   * email still sends via SES using the EMAIL_FROM identity verified
   * out-of-band.
   */
  public readonly sesEmailIdentity?: ses.EmailIdentity;
  public readonly sesConfigurationSet: ses.ConfigurationSet;
  public readonly emailWorkerFunction: NodejsFunction;

  constructor(scope: Construct, id: string, config: EnvironmentConfig, apiProps: ApiStackProps) {
    super(scope, id, apiProps);

    // Apply environment tags to all resources in this stack
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    // ---- Shared API infrastructure (HTTP API, health, migration router) ----
    const sharedInfra = new SharedApiInfra(this, 'SharedInfra', config, {
      migrationRoutesTable: apiProps.migrationRoutesTable
    });
    this.httpApi = sharedInfra.httpApi;
    this.neonTestFunction = sharedInfra.neonTestFunction;
    this.migrationRouterFunction = sharedInfra.migrationRouterFunction;

    // ---- Messaging (SES config set + optional identity, email-worker + SQS) ----
    const messaging = new MessagingDomain(this, 'MessagingDomain', config, {
      emailQueue: apiProps.emailQueue,
      jobMetadataTable: apiProps.jobMetadataTable
    });
    this.sesConfigurationSet = messaging.sesConfigurationSet;
    this.sesEmailIdentity = messaging.sesEmailIdentity;
    this.emailWorkerFunction = messaging.emailWorkerFunction;

    /**
     * Shared Better Auth runtime env, built ONCE and injected into every
     * session-validating domain Lambda (see buildAuthEnv). BETTER_AUTH_SECRET
     * MUST be consistent so cookies signed by the auth handler validate
     * elsewhere.
     */
    const authEnv = buildAuthEnv(config);

    // Shared context handed to each domain construct.
    const domainProps: ApiDomainProps = {
      httpApi: this.httpApi,
      authEnv,
      emailQueue: apiProps.emailQueue,
      jobMetadataTable: apiProps.jobMetadataTable,
      sesConfigurationSetName: this.sesConfigurationSet.configurationSetName
    };

    // ---- Per-domain Lambda + route construction ----
    new IdentityDomain(this, 'IdentityDomain', config, domainProps);
    new AccountDomain(this, 'AccountDomain', config, domainProps);
    const courseDomain = new CourseDomain(this, 'CourseDomain', config, domainProps);
    const lessonDomain = new LessonDomain(this, 'LessonDomain', config, domainProps);
    new LearningDomain(this, 'LearningDomain', config, domainProps);
    new OrganizationDomain(this, 'OrganizationDomain', config, domainProps);

    // ---- Outputs ----
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
      value: courseDomain.courseListingFunction.function.functionName,
      description: 'Course listing Lambda function name',
      exportName: `${config.environmentName}-CourseListingFunctionName`
    });

    new cdk.CfnOutput(this, 'CourseListingFunctionArn', {
      value: courseDomain.courseListingFunction.function.functionArn,
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
      value: courseDomain.courseDetailsFunction.function.functionName,
      description: 'Course details Lambda function name',
      exportName: `${config.environmentName}-CourseDetailsFunctionName`
    });

    new cdk.CfnOutput(this, 'CourseDetailsFunctionArn', {
      value: courseDomain.courseDetailsFunction.function.functionArn,
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
      value: courseDomain.courseEnrollmentFunction.function.functionName,
      description: 'Course enrollment Lambda function name',
      exportName: `${config.environmentName}-CourseEnrollmentFunctionName`
    });

    new cdk.CfnOutput(this, 'CourseEnrollmentFunctionArn', {
      value: courseDomain.courseEnrollmentFunction.function.functionArn,
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
      value: lessonDomain.lessonListingFunction.function.functionName,
      description: 'Lesson listing Lambda function name',
      exportName: `${config.environmentName}-LessonListingFunctionName`
    });

    new cdk.CfnOutput(this, 'LessonListingFunctionArn', {
      value: lessonDomain.lessonListingFunction.function.functionArn,
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
      value: lessonDomain.lessonDetailsFunction.function.functionName,
      description: 'Lesson details Lambda function name',
      exportName: `${config.environmentName}-LessonDetailsFunctionName`
    });

    new cdk.CfnOutput(this, 'LessonDetailsFunctionArn', {
      value: lessonDomain.lessonDetailsFunction.function.functionArn,
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
      value: lessonDomain.lessonProgressFunction.function.functionName,
      description: 'Lesson progress Lambda function name',
      exportName: `${config.environmentName}-LessonProgressFunctionName`
    });

    new cdk.CfnOutput(this, 'LessonProgressFunctionArn', {
      value: lessonDomain.lessonProgressFunction.function.functionArn,
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
