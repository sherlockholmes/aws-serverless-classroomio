import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environment';

/**
 * Monitoring Stack Properties
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Task: 4.2 "Add email-worker to the monitoring stack's tracked Lambda list"
 */
export interface MonitoringStackProps extends cdk.StackProps {
  /** The email DLQ from QueueStack, used to alarm on undelivered messages. */
  emailDlq?: sqs.IQueue;
}

/**
 * Monitoring Stack
 *
 * This stack provisions:
 * - CloudWatch log groups for all Lambda functions
 * - CloudWatch dashboards for operational metrics
 * - CloudWatch alarms for error rates and latency
 * - SNS topics for alarm notifications
 *
 * Requirements: 10.1, 10.3, 10.4, 10.5, 10.6, 10.7
 * Design: Monitoring § CloudWatch
 */
export class MonitoringStack extends cdk.Stack {
  public readonly logGroups: Map<string, logs.LogGroup>;
  public readonly kmsKey: kms.Key;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, config: EnvironmentConfig, props?: MonitoringStackProps) {
    super(scope, id, props);

    // Apply environment tags to all resources in this stack
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    // Create KMS key for CloudWatch log encryption
    // Requirement 10.7: CloudWatch Logs retention with encryption
    this.kmsKey = new kms.Key(this, 'LogEncryptionKey', {
      description: `CloudWatch log encryption key for ${config.environmentName}`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN // Keep encryption key on stack deletion
    });

    // Add key alias for easier management
    this.kmsKey.addAlias(`alias/classroomio-logs-${config.environmentName}`);

    // Grant CloudWatch Logs permission to use the key
    this.kmsKey.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [new cdk.aws_iam.ServicePrincipal(`logs.${config.region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:CreateGrant',
          'kms:DescribeKey'
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${config.region}:${config.account}:log-group:/aws/lambda/*`
          }
        }
      })
    );

    // Define Lambda functions that need log groups
    // Design: Components § Lambda Functions § Function Breakdown
    // Note: migration-router log group is created by ApiStack
    const lambdaFunctions = [
      'course-handler',
      'lesson-handler',
      'assignment-handler',
      'media-handler',
      'dashboard-handler',
      'hono-proxy',
      'media-worker',
      'email-worker',
      'notification-worker',
      'cleanup-scheduled',
      'analytics-scheduled',
      'deadline-checker'
    ];

    // Create CloudWatch log groups for each Lambda function
    // Requirement 10.1: Lambda functions log errors and warnings to CloudWatch
    // Requirement 10.7: CloudWatch Logs retain application logs for 30 days minimum
    this.logGroups = new Map();

    lambdaFunctions.forEach((functionName) => {
      const logGroup = new logs.LogGroup(this, `${functionName}LogGroup`, {
        logGroupName: `/aws/lambda/${functionName}-${config.environmentName}`,
        retention: logs.RetentionDays.ONE_MONTH, // 30 days as per requirements
        encryptionKey: this.kmsKey, // KMS encryption enabled
        removalPolicy: cdk.RemovalPolicy.DESTROY // Logs can be deleted on stack removal
      });

      this.logGroups.set(functionName, logGroup);

      // Output log group ARN for reference
      new cdk.CfnOutput(this, `${functionName}LogGroupArn`, {
        value: logGroup.logGroupArn,
        description: `Log group ARN for ${functionName}`,
        exportName: `${config.environmentName}-${functionName}-log-group-arn`
      });
    });

    // Create CloudWatch Dashboard with placeholder widgets
    // Requirement 10.3: CloudWatch Dashboard displays request counts, error rates, latency
    this.dashboard = new cloudwatch.Dashboard(this, 'OperationalDashboard', {
      dashboardName: `ClassroomIO-${config.environmentName}`,
      defaultInterval: cdk.Duration.hours(6)
    });

    // Add placeholder widgets for future implementation
    // These will be populated with real metrics in subsequent tasks

    // Row 1: Request Counts
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# ClassroomIO ${config.environmentName.toUpperCase()} Dashboard\n\nThis dashboard provides operational metrics for the serverless migration.\n\n**Note:** Widgets will be populated with real Lambda metrics in subsequent tasks.`,
        width: 24,
        height: 3
      })
    );

    // Row 2: Lambda Performance Metrics (Placeholder)
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations (Placeholder)',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Invocations',
            statistic: 'Sum',
            label: 'Total Invocations',
            period: cdk.Duration.minutes(5)
          })
        ]
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors (Placeholder)',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Errors',
            statistic: 'Sum',
            label: 'Total Errors',
            period: cdk.Duration.minutes(5)
          })
        ]
      })
    );

    // Row 3: Latency Metrics (Placeholder)
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration Percentiles (Placeholder)',
        width: 24,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            statistic: 'p50',
            label: 'p50 Duration',
            period: cdk.Duration.minutes(5)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            statistic: 'p95',
            label: 'p95 Duration',
            period: cdk.Duration.minutes(5)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            statistic: 'p99',
            label: 'p99 Duration',
            period: cdk.Duration.minutes(5)
          })
        ]
      })
    );

    // Row 4: DynamoDB and Cost (Placeholders)
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Operations (Placeholder)',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedReadCapacityUnits',
            statistic: 'Sum',
            label: 'Read Capacity',
            period: cdk.Duration.minutes(5)
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedWriteCapacityUnits',
            statistic: 'Sum',
            label: 'Write Capacity',
            period: cdk.Duration.minutes(5)
          })
        ]
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Estimated Daily Cost (Placeholder)',
        width: 12,
        height: 6,
        metrics: [
          new cloudwatch.Metric({
            namespace: 'ClassroomIO/Cost',
            metricName: 'EstimatedDailyCost',
            statistic: 'Average',
            label: 'Estimated Daily Cost USD',
            period: cdk.Duration.days(1)
          })
        ]
      })
    );

    /**
     * Alarm: Email DLQ has visible messages
     *
     * Spec: .kiro/specs/ses-email-delivery
     * Task: 4.2 "Add email-worker to the monitoring stack's tracked Lambda
     * list" (this is the "add a CloudWatch alarm on Email_DLQ's
     * ApproximateNumberOfMessagesVisible metric" half of that task)
     *
     * Requirement 6.3: WHEN messages land in the DLQ, THE Monitoring
     * Configuration SHALL surface this so failures are not silently
     * ignored. No SNS topic/subscription exists yet anywhere in this stack
     * (this is the first alarm added to MonitoringStack) -- the alarm
     * itself is visible in the CloudWatch console/API immediately; wiring
     * it to a notification channel (email/Slack/etc.) is a follow-up, not
     * required by Requirement 6.3's literal text.
     */
    if (props?.emailDlq) {
      const emailDlqDepthAlarm = new cloudwatch.Alarm(this, 'EmailDlqDepthAlarm', {
        alarmName: `classroomio-${config.environmentName}-email-dlq-depth`,
        alarmDescription: 'Email DLQ has one or more undelivered messages -- SES sends are failing after all retries.',
        metric: props.emailDlq.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
          statistic: 'Maximum'
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
      });

      new cdk.CfnOutput(this, 'EmailDlqDepthAlarmArn', {
        value: emailDlqDepthAlarm.alarmArn,
        description: 'CloudWatch alarm ARN for email DLQ depth > 0'
      });
    }

    // TODO: In subsequent tasks (Task 16.1, 16.2), we will:
    // 1. Add function-specific metrics when Lambda functions are deployed
    // 2. Create CloudWatch alarms for:
    //    - Error rate > 1%
    //    - p95 latency > 1 second
    //    - Lambda throttling events
    // 3. Create SNS topic for alarm notifications
    // 4. Subscribe email to SNS topic
    // 5. Add custom business metrics (enrollments, video views, submissions)

    // Outputs
    new cdk.CfnOutput(this, 'KmsKeyId', {
      value: this.kmsKey.keyId,
      description: 'KMS key ID for CloudWatch log encryption',
      exportName: `${config.environmentName}-logs-kms-key-id`
    });

    new cdk.CfnOutput(this, 'KmsKeyArn', {
      value: this.kmsKey.keyArn,
      description: 'KMS key ARN for CloudWatch log encryption',
      exportName: `${config.environmentName}-logs-kms-key-arn`
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${config.region}.console.aws.amazon.com/cloudwatch/home?region=${config.region}#dashboards:name=${this.dashboard.dashboardName}`,
      description: 'CloudWatch Dashboard URL'
    });

    new cdk.CfnOutput(this, 'LogGroupCount', {
      value: `${this.logGroups.size}`,
      description: 'Number of CloudWatch log groups created'
    });
  }
}
