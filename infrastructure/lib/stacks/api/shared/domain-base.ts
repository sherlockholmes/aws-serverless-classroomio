import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../../config/environment';

/**
 * Shared context passed to every ApiStack domain construct.
 *
 * The HTTP API and the resolved `authEnv`/SES config-set name are built ONCE in
 * ApiStack and passed here by reference, so each domain construct composes the
 * same values without rebuilding them.
 */
export interface ApiDomainProps {
  /** The HTTP API shared across all domains (created in shared-infra). */
  httpApi: apigatewayv2.HttpApi;
  /** Shared Better Auth runtime env, built once (see buildAuthEnv). */
  authEnv: Record<string, string>;
  /** SQS queue the email-enqueuing handlers send to (from ApiStackProps). */
  emailQueue: sqs.IQueue;
  /** DynamoDB table used for the email idempotency backstop (from ApiStackProps). */
  jobMetadataTable: dynamodb.ITable;
  /** Resolved SES configuration-set name (classroomio-<env>). */
  sesConfigurationSetName: string;
}

/**
 * Base class for ApiStack per-domain constructs.
 *
 * IMPORTANT — logical-ID preservation: domain constructs create their
 * `NodejsFunction`s, routes, integrations and policies on the ApiStack scope
 * passed to them (NOT on `this`), so every CloudFormation logical ID is
 * byte-identical to the pre-refactor single-stack template (the "mechanic 2"
 * approach documented in phase6-design §1.1). The domain construct itself adds
 * no CloudFormation resources — it is purely an organizational grouping of the
 * construction logic. The empty before/after template diff is the proof.
 */
export abstract class ApiDomainConstruct extends Construct {
  /**
   * The ApiStack scope. All CloudFormation resources are created on THIS scope
   * (not on the domain construct) so logical IDs match the pre-refactor
   * single-stack template exactly.
   */
  protected readonly stackScope: Construct;
  protected readonly config: EnvironmentConfig;
  protected readonly props: ApiDomainProps;

  constructor(scope: Construct, id: string, config: EnvironmentConfig, props: ApiDomainProps) {
    super(scope, id);
    this.stackScope = scope;
    this.config = config;
    this.props = props;
  }
}
