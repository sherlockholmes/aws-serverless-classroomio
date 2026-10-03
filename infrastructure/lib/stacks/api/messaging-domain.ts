import * as cdk from 'aws-cdk-lib';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentConfig, getRootZoneName } from '../../config/environment';
import { NodejsFunction } from '../../constructs';
import { sesSend } from './shared/iam';

/**
 * Messaging domain for ApiStack.
 *
 * Owns the SES configuration set (+ optional Route 53-backed domain identity)
 * and the SQS-triggered `email-worker` Lambda. All resources are created on the
 * ApiStack `scope` so logical IDs match the pre-refactor template exactly.
 */
export interface MessagingDomainProps {
  emailQueue: sqs.IQueue;
  jobMetadataTable: dynamodb.ITable;
}

export class MessagingDomain extends Construct {
  public readonly sesConfigurationSet: ses.ConfigurationSet;
  public readonly sesEmailIdentity?: ses.EmailIdentity;
  public readonly emailWorkerFunction: NodejsFunction;

  constructor(scope: Construct, id: string, config: EnvironmentConfig, props: MessagingDomainProps) {
    super(scope, id);

    const { emailQueue, jobMetadataTable } = props;

    /**
     * SES Configuration Set (always created) + optional Route 53-backed
     * domain identity.
     *
     * The configuration set (bounce/complaint -> CloudWatch) is always
     * created: email sending via SES works regardless of custom-domain config,
     * using the EMAIL_FROM identity verified out-of-band.
     *
     * The Route 53-backed domain identity (Easy DKIM + MAIL FROM) is only
     * created when a custom domain AND a hosted zone are configured. A
     * no-domain deploy skips it entirely, so synth never requires a hosted
     * zone. The identity value and MAIL FROM subdomain are derived from the
     * configured domain's apex zone — nothing is hardcoded.
     */
    this.sesConfigurationSet = new ses.ConfigurationSet(scope, 'SesConfigurationSet', {
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

    // Email domain derives from the configured API domain, falling back to the
    // CDN domain. Only when such a domain AND a hosted zone exist do we create
    // the Route 53-backed SES domain identity.
    const emailDomainSource = config.domain.apiDomain ?? config.domain.cdnDomain;
    const emailZoneName = emailDomainSource ? getRootZoneName(emailDomainSource) : undefined;

    if (emailZoneName && config.domain.hostedZoneId) {
      const sesHostedZone = route53.HostedZone.fromHostedZoneAttributes(scope, 'SesHostedZone', {
        hostedZoneId: config.domain.hostedZoneId,
        zoneName: emailZoneName
      });

      // Scope the SES domain identity to the apex zone and point `hostedZone`
      // at the real Route 53 zone so `EmailIdentity` auto-creates the DKIM
      // CNAME + MAIL FROM MX/TXT records in that zone. The MAIL FROM is a
      // `mail.` subdomain of the identity's apex zone.
      const domainIdentity: ses.Identity = {
        value: emailZoneName,
        hostedZone: sesHostedZone
      };

      this.sesEmailIdentity = new ses.EmailIdentity(scope, 'SesDomainIdentity', {
        identity: domainIdentity,
        configurationSet: this.sesConfigurationSet,
        mailFromDomain: `mail.${emailZoneName}`
      });

      new cdk.CfnOutput(scope, 'SesDomainIdentityName', {
        value: this.sesEmailIdentity.emailIdentityName,
        description: 'SES verified domain identity (Easy DKIM via Route 53)',
        exportName: `${config.environmentName}-SesDomainIdentityName`
      });
    }

    new cdk.CfnOutput(scope, 'SesConfigurationSetName', {
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
      scope,
      'ExistingEmailWorkerLogGroup',
      `/aws/lambda/email-worker-${config.environmentName}`
    );

    this.emailWorkerFunction = new NodejsFunction(scope, 'EmailWorkerFunction', config, {
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
        JOB_METADATA_TABLE_NAME: jobMetadataTable.tableName,
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
    this.emailWorkerFunction.function.addToRolePolicy(sesSend(config, this.sesConfigurationSet.configurationSetName));

    // Idempotency backstop read/write (Task 6.1)
    jobMetadataTable.grantReadWriteData(this.emailWorkerFunction.function);

    // SQS event source mapping — partial batch failure reporting so one bad
    // message doesn't force the whole batch to retry (design.md's
    // partial-batch-failure note; handler already returns batchItemFailures).
    this.emailWorkerFunction.function.addEventSource(
      new lambdaEventSources.SqsEventSource(emailQueue, {
        batchSize: 10,
        reportBatchItemFailures: true
      })
    );

    new cdk.CfnOutput(scope, 'EmailWorkerFunctionName', {
      value: this.emailWorkerFunction.function.functionName,
      description: 'email-worker Lambda function name',
      exportName: `${config.environmentName}-EmailWorkerFunctionName`
    });
  }
}
