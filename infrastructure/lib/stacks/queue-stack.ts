import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environment';

/**
 * Queue Stack
 *
 * This stack provisions:
 * - SQS queues for background job processing (media, email, notifications)
 * - Dead letter queues for failed jobs
 * - Lambda workers triggered by SQS events
 * - EventBridge Scheduler for recurring tasks
 * - DynamoDB tables for ephemeral state (rate limits, job metadata, migration routes)
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 7.1, 7.5, 5.1, 14.1, 14.2, 14.4
 * Design: Components § SQS + Lambda, Components § DynamoDB, Components § EventBridge
 */
export class QueueStack extends cdk.Stack {
  public readonly rateLimitsTable: dynamodb.Table;
  public readonly jobMetadataTable: dynamodb.Table;
  public readonly migrationRoutesTable: dynamodb.Table;
  public readonly emailQueue: sqs.Queue;
  public readonly emailDlq: sqs.Queue;

  constructor(scope: Construct, id: string, config: EnvironmentConfig, props?: cdk.StackProps) {
    super(scope, id, props);

    // Apply environment tags to all resources in this stack
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    /**
     * DynamoDB Table: rate-limits
     *
     * Task 3.2: Create DynamoDB tables for ephemeral state
     * Requirements: 5.1, 14.1, 14.4
     *
     * Stores rate limiting counters per user/IP with automatic expiration.
     *
     * Schema:
     * - composite_key (PK): "{identifier}#{window}" (e.g., "user:123#2024-01-15T10:00:00Z")
     * - window_start (SK): ISO timestamp of window start
     * - count: Number of requests in this window
     * - ttl: Unix timestamp for automatic deletion (24 hours)
     */
    this.rateLimitsTable = new dynamodb.Table(this, 'RateLimitsTable', {
      tableName: `classroomio-rate-limits-${config.environmentName}`,
      partitionKey: {
        name: 'composite_key',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'window_start',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      // Enable TTL for automatic cleanup (Requirement 14.4)
      timeToLiveAttribute: 'ttl',

      // Point-in-time recovery for production safety
      pointInTimeRecovery: config.environmentName === 'production',

      removalPolicy: config.environmentName === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    /**
     * DynamoDB Table: job-metadata
     *
     * Task 3.2: Create DynamoDB tables for ephemeral state
     * Requirements: 14.2, 14.3, 14.4
     *
     * Stores metadata for background jobs (transcoding, email, notifications).
     *
     * Schema:
     * - job_id (PK): Unique job identifier (UUID)
     * - job_type: Type of job (transcode, email, notification)
     * - status: Job status (pending, running, completed, failed)
     * - created_at: ISO timestamp
     * - updated_at: ISO timestamp
     * - asset_id: Related asset ID (for transcode jobs)
     * - error_message: Error details if failed
     * - retry_count: Number of retries attempted
     * - ttl: Unix timestamp for automatic deletion (7 days)
     *
     * GSI: status-index for querying jobs by status
     */
    this.jobMetadataTable = new dynamodb.Table(this, 'JobMetadataTable', {
      tableName: `classroomio-job-metadata-${config.environmentName}`,
      partitionKey: {
        name: 'job_id',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      // Enable TTL for automatic cleanup (7 days)
      timeToLiveAttribute: 'ttl',

      // Point-in-time recovery for production safety
      pointInTimeRecovery: config.environmentName === 'production',

      removalPolicy: config.environmentName === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    // Add GSI for querying jobs by status (Requirement 14.2)
    this.jobMetadataTable.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'created_at',
        type: dynamodb.AttributeType.STRING
      }
    });

    // Add GSI for querying jobs by type and status
    this.jobMetadataTable.addGlobalSecondaryIndex({
      indexName: 'job-type-status-index',
      partitionKey: {
        name: 'job_type',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'status',
        type: dynamodb.AttributeType.STRING
      }
    });

    /**
     * DynamoDB Table: migration-routes
     *
     * Task 3.2: Create DynamoDB tables for strangler fig pattern
     * Requirements: 3.1, 3.2, 3.3, 3.6
     *
     * Stores routing configuration for the migration router Lambda.
     * Controls which routes are sent to Lambda vs legacy Hono server.
     *
     * Schema:
     * - path (PK): Route path pattern (e.g., "/course", "/course/:id", "/lesson/:id")
     * - target: "lambda" | "hono-proxy" | "canary"
     * - canaryPercentage: 0-100 (only used when target="canary")
     * - lambdaFunctionName: Name of Lambda function to invoke (when target="lambda" or canary routes to Lambda)
     * - enabled: boolean - whether this route is active
     * - lastUpdated: ISO timestamp of last configuration change
     * - updatedBy: User ID who made the change
     *
     * GSI: enabled-index for efficient queries of active routes
     */
    this.migrationRoutesTable = new dynamodb.Table(this, 'MigrationRoutesTable', {
      tableName: `classroomio-migration-routes-${config.environmentName}`,
      partitionKey: {
        name: 'path',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      // No TTL - these are configuration records that persist

      // Point-in-time recovery for production safety (migration config is critical)
      pointInTimeRecovery: true,

      // Always retain migration routes table (contains critical routing config)
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // Add GSI for querying enabled routes (Task 9.1)
    this.migrationRoutesTable.addGlobalSecondaryIndex({
      indexName: 'enabled-index',
      partitionKey: {
        name: 'enabled',
        type: dynamodb.AttributeType.NUMBER // 0 = disabled, 1 = enabled (DynamoDB doesn't have boolean for index keys)
      },
      sortKey: {
        name: 'path',
        type: dynamodb.AttributeType.STRING
      }
    });

    /**
     * SQS Queue: email (+ its DLQ)
     *
     * Spec: .kiro/specs/ses-email-delivery
     * Task: 4.1 "Add Email_Queue and Email_DLQ to
     * infrastructure/lib/stacks/queue-stack.ts"
     *
     * Replaces the non-functional BullMQ/Redis `emails` queue for the AWS
     * deployment (see design.md Decision "Why not keep BullMQ/Redis" — no
     * Redis instance exists in this deployment, and apps/jobs' worker isn't
     * deployed anywhere in AWS). A standard (not FIFO) queue was chosen
     * deliberately — see design.md Decision 6 — because idempotency-key
     * dedup is instead handled via the existing `jobMetadataTable` (see
     * Task 6.1), which has no 5-minute window limitation the way FIFO's
     * built-in dedup would.
     *
     * `visibilityTimeout` must be >= the `email-worker` Lambda's own
     * timeout (Task 6.4/6.5), otherwise SQS could redeliver a message to a
     * second concurrent invocation while the first is still processing it.
     */
    this.emailDlq = new sqs.Queue(this, 'EmailDlq', {
      queueName: `classroomio-email-dlq-${config.environmentName}`,
      retentionPeriod: cdk.Duration.days(14)
    });

    this.emailQueue = new sqs.Queue(this, 'EmailQueue', {
      queueName: `classroomio-email-${config.environmentName}`,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: this.emailDlq,
        maxReceiveCount: 3
      }
    });

    // TODO: In subsequent tasks, we will:
    // 1. Create SQS queues (media-jobs, notification-jobs) - Task 28.1
    // 2. Create Lambda worker functions - Tasks 29-30
    // 3. Configure SQS event source mappings
    // 4. Create EventBridge Scheduler rules for recurring tasks - Tasks 31-32

    // Stack Outputs
    new cdk.CfnOutput(this, 'RateLimitsTableName', {
      value: this.rateLimitsTable.tableName,
      description: 'DynamoDB table name for rate limiting',
      exportName: `${config.environmentName}-RateLimitsTableName`
    });

    new cdk.CfnOutput(this, 'RateLimitsTableArn', {
      value: this.rateLimitsTable.tableArn,
      description: 'DynamoDB table ARN for rate limiting',
      exportName: `${config.environmentName}-RateLimitsTableArn`
    });

    new cdk.CfnOutput(this, 'JobMetadataTableName', {
      value: this.jobMetadataTable.tableName,
      description: 'DynamoDB table name for job metadata',
      exportName: `${config.environmentName}-JobMetadataTableName`
    });

    new cdk.CfnOutput(this, 'JobMetadataTableArn', {
      value: this.jobMetadataTable.tableArn,
      description: 'DynamoDB table ARN for job metadata',
      exportName: `${config.environmentName}-JobMetadataTableArn`
    });

    new cdk.CfnOutput(this, 'MigrationRoutesTableName', {
      value: this.migrationRoutesTable.tableName,
      description: 'DynamoDB table name for migration routing',
      exportName: `${config.environmentName}-MigrationRoutesTableName`
    });

    new cdk.CfnOutput(this, 'MigrationRoutesTableArn', {
      value: this.migrationRoutesTable.tableArn,
      description: 'DynamoDB table ARN for migration routing',
      exportName: `${config.environmentName}-MigrationRoutesTableArn`
    });

    new cdk.CfnOutput(this, 'TTLConfiguration', {
      value: `rate-limits: ${config.dynamodb.ttl.rateLimits}s, job-metadata: ${config.dynamodb.ttl.jobMetadata}s`,
      description: 'TTL configuration for DynamoDB tables'
    });

    new cdk.CfnOutput(this, 'EmailQueueUrl', {
      value: this.emailQueue.queueUrl,
      description: 'SQS queue URL for the SES email-worker',
      exportName: `${config.environmentName}-EmailQueueUrl`
    });

    new cdk.CfnOutput(this, 'EmailQueueArn', {
      value: this.emailQueue.queueArn,
      description: 'SQS queue ARN for the SES email-worker',
      exportName: `${config.environmentName}-EmailQueueArn`
    });

    new cdk.CfnOutput(this, 'EmailDlqUrl', {
      value: this.emailDlq.queueUrl,
      description: 'Dead letter queue URL for failed email sends',
      exportName: `${config.environmentName}-EmailDlqUrl`
    });

    new cdk.CfnOutput(this, 'EmailDlqArn', {
      value: this.emailDlq.queueArn,
      description: 'Dead letter queue ARN for failed email sends',
      exportName: `${config.environmentName}-EmailDlqArn`
    });
  }
}
