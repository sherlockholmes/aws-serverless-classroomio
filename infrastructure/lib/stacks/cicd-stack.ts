import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environment';

/**
 * CI/CD Stack
 *
 * This stack provisions:
 * - OIDC provider for GitHub Actions
 * - IAM role for GitHub Actions deployment
 * - Required policies for CDK deployments
 *
 * Task 2.2: Configure AWS IAM roles for GitHub Actions deployment
 * Requirements: 16.1, 17.4
 * Design: Security Design § IAM Roles, Deployment Strategy § CI/CD Pipeline
 *
 * GitHub Actions will assume this role to deploy CDK stacks without needing
 * long-lived AWS credentials (access keys).
 */
export class CicdStack extends cdk.Stack {
  public readonly githubActionsRole: iam.Role;
  public readonly oidcProvider: iam.OpenIdConnectProvider;

  constructor(scope: Construct, id: string, config: EnvironmentConfig, props?: cdk.StackProps) {
    super(scope, id, props);

    // Apply environment tags to all resources in this stack
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    /**
     * GitHub OIDC Provider
     *
     * This allows GitHub Actions to authenticate with AWS using OpenID Connect.
     * No need to store AWS credentials in GitHub secrets.
     *
     * GitHub OIDC endpoint: https://token.actions.githubusercontent.com
     * Audience: sts.amazonaws.com (default for AWS)
     */
    this.oidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidcProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
      // GitHub's thumbprint (verify at https://github.blog/changelog/2022-01-13-github-actions-update-on-oidc-based-deployments-to-aws/)
      thumbprints: ['6938fd4d98bab03faadb97b34396831e3780aea1']
    });

    /**
     * IAM Role for GitHub Actions
     *
     * This role can be assumed by GitHub Actions workflows running in the
     * classroomio/classroomio repository.
     *
     * The trust policy uses conditions to restrict which GitHub repositories
     * and branches can assume this role.
     */
    this.githubActionsRole = new iam.Role(this, 'GitHubActionsDeployRole', {
      roleName: `ClassroomIO-GitHubActions-Deploy-${config.environmentName}`,
      description: `Role for GitHub Actions to deploy ClassroomIO infrastructure to ${config.environmentName}`,
      assumedBy: new iam.WebIdentityPrincipal(this.oidcProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com'
        },
        StringLike: {
          // Allow only from classroomio/classroomio repository
          // Format: repo:<org>/<repo>:ref:refs/heads/<branch>
          'token.actions.githubusercontent.com:sub': [
            'repo:classroomio/classroomio:ref:refs/heads/develop', // dev deployments
            'repo:classroomio/classroomio:ref:refs/heads/main' // staging/production
          ]
        }
      }),
      maxSessionDuration: cdk.Duration.hours(1) // Max 1 hour session for security
    });

    /**
     * CDK Deployment Permissions
     *
     * The role needs permissions to:
     * 1. Create/update/delete CloudFormation stacks
     * 2. Create/manage Lambda functions
     * 3. Create/manage API Gateway resources
     * 4. Create/manage DynamoDB tables
     * 5. Create/manage S3 buckets
     * 6. Create/manage CloudWatch log groups
     * 7. Create/manage IAM roles (for Lambda execution)
     * 8. Read/write SSM parameters (for CDK bootstrap)
     */

    // CloudFormation permissions
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudFormationAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudformation:CreateStack',
          'cloudformation:UpdateStack',
          'cloudformation:DeleteStack',
          'cloudformation:DescribeStacks',
          'cloudformation:DescribeStackEvents',
          'cloudformation:DescribeStackResources',
          'cloudformation:GetTemplate',
          'cloudformation:ValidateTemplate',
          'cloudformation:CreateChangeSet',
          'cloudformation:DescribeChangeSet',
          'cloudformation:ExecuteChangeSet',
          'cloudformation:DeleteChangeSet',
          'cloudformation:ListStacks'
        ],
        resources: [
          `arn:aws:cloudformation:${config.region}:${config.account}:stack/ClassroomIO-${config.environmentName}-*/*`,
          `arn:aws:cloudformation:${config.region}:${config.account}:stack/CDKToolkit/*` // CDK bootstrap stack
        ]
      })
    );

    // S3 permissions (for CDK assets and media bucket)
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3Access',
        effect: iam.Effect.ALLOW,
        actions: [
          's3:CreateBucket',
          's3:DeleteBucket',
          's3:PutBucketPolicy',
          's3:GetBucketPolicy',
          's3:DeleteBucketPolicy',
          's3:PutBucketVersioning',
          's3:GetBucketVersioning',
          's3:PutBucketPublicAccessBlock',
          's3:GetBucketPublicAccessBlock',
          's3:PutBucketCors',
          's3:GetBucketCors',
          's3:PutLifecycleConfiguration',
          's3:GetLifecycleConfiguration',
          's3:PutBucketEncryption',
          's3:GetBucketEncryption',
          's3:ListBucket',
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject'
        ],
        resources: [
          `arn:aws:s3:::classroomio-*-${config.environmentName}`,
          `arn:aws:s3:::classroomio-*-${config.environmentName}/*`,
          'arn:aws:s3:::cdktoolkit-stagingbucket-*' // CDK bootstrap bucket
        ]
      })
    );

    // Lambda permissions
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'LambdaAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'lambda:CreateFunction',
          'lambda:DeleteFunction',
          'lambda:UpdateFunctionCode',
          'lambda:UpdateFunctionConfiguration',
          'lambda:GetFunction',
          'lambda:GetFunctionConfiguration',
          'lambda:ListFunctions',
          'lambda:PublishVersion',
          'lambda:CreateAlias',
          'lambda:UpdateAlias',
          'lambda:DeleteAlias',
          'lambda:PutFunctionConcurrency',
          'lambda:DeleteFunctionConcurrency',
          'lambda:TagResource',
          'lambda:UntagResource',
          'lambda:ListTags'
        ],
        resources: [`arn:aws:lambda:${config.region}:${config.account}:function:*-${config.environmentName}`]
      })
    );

    // API Gateway permissions
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ApiGatewayAccess',
        effect: iam.Effect.ALLOW,
        actions: ['apigateway:POST', 'apigateway:PUT', 'apigateway:PATCH', 'apigateway:DELETE', 'apigateway:GET'],
        resources: [
          `arn:aws:apigateway:${config.region}::/restapis`,
          `arn:aws:apigateway:${config.region}::/restapis/*`,
          `arn:aws:apigateway:${config.region}::/apis`,
          `arn:aws:apigateway:${config.region}::/apis/*`
        ]
      })
    );

    // DynamoDB permissions
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoDBAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:CreateTable',
          'dynamodb:DeleteTable',
          'dynamodb:UpdateTable',
          'dynamodb:DescribeTable',
          'dynamodb:ListTables',
          'dynamodb:TagResource',
          'dynamodb:UntagResource',
          'dynamodb:UpdateTimeToLive',
          'dynamodb:DescribeTimeToLive',
          'dynamodb:UpdateContinuousBackups',
          'dynamodb:DescribeContinuousBackups'
        ],
        resources: [`arn:aws:dynamodb:${config.region}:${config.account}:table/classroomio-*-${config.environmentName}`]
      })
    );

    // CloudWatch Logs permissions
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchLogsAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:DeleteLogGroup',
          'logs:DescribeLogGroups',
          'logs:PutRetentionPolicy',
          'logs:DeleteRetentionPolicy',
          'logs:TagLogGroup',
          'logs:UntagLogGroup'
        ],
        resources: [
          `arn:aws:logs:${config.region}:${config.account}:log-group:/aws/lambda/*-${config.environmentName}*`
        ]
      })
    );

    // IAM permissions (limited to creating Lambda execution roles)
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'IAMAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:GetRole',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:GetRolePolicy',
          'iam:AttachRolePolicy',
          'iam:DetachRolePolicy',
          'iam:PassRole',
          'iam:TagRole',
          'iam:UntagRole'
        ],
        resources: [`arn:aws:iam::${config.account}:role/ClassroomIO-${config.environmentName}-*`]
      })
    );

    // SSM Parameter Store permissions (for CDK context and config)
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SSMAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'ssm:GetParameter',
          'ssm:GetParameters',
          'ssm:PutParameter',
          'ssm:DeleteParameter',
          'ssm:DescribeParameters'
        ],
        resources: [`arn:aws:ssm:${config.region}:${config.account}:parameter/cdk-bootstrap/*`]
      })
    );

    // KMS permissions (for CloudWatch log encryption)
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'KMSAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'kms:CreateKey',
          'kms:CreateAlias',
          'kms:DeleteAlias',
          'kms:DescribeKey',
          'kms:EnableKeyRotation',
          'kms:GetKeyPolicy',
          'kms:PutKeyPolicy',
          'kms:TagResource',
          'kms:UntagResource'
        ],
        resources: ['*'] // KMS key ARNs are not known before creation
      })
    );

    // SQS permissions (for background job queues)
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SQSAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'sqs:CreateQueue',
          'sqs:DeleteQueue',
          'sqs:GetQueueAttributes',
          'sqs:SetQueueAttributes',
          'sqs:TagQueue',
          'sqs:UntagQueue'
        ],
        resources: [`arn:aws:sqs:${config.region}:${config.account}:classroomio-*-${config.environmentName}`]
      })
    );

    // EventBridge permissions (for scheduled tasks)
    this.githubActionsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EventBridgeAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'events:PutRule',
          'events:DeleteRule',
          'events:DescribeRule',
          'events:PutTargets',
          'events:RemoveTargets',
          'events:TagResource',
          'events:UntagResource'
        ],
        resources: [`arn:aws:events:${config.region}:${config.account}:rule/ClassroomIO-${config.environmentName}-*`]
      })
    );

    // Stack Outputs
    new cdk.CfnOutput(this, 'GitHubActionsRoleArn', {
      value: this.githubActionsRole.roleArn,
      description: 'ARN of the GitHub Actions deployment role',
      exportName: `${config.environmentName}-GitHubActionsRoleArn`
    });

    new cdk.CfnOutput(this, 'OIDCProviderArn', {
      value: this.oidcProvider.openIdConnectProviderArn,
      description: 'ARN of the GitHub OIDC provider',
      exportName: `${config.environmentName}-GitHubOIDCProviderArn`
    });

    new cdk.CfnOutput(this, 'SetupInstructions', {
      value: [
        'Add this ARN to GitHub repository secrets as AWS_DEPLOY_ROLE_ARN:',
        this.githubActionsRole.roleArn,
        '',
        'The role can be assumed by workflows in the classroomio/classroomio repo',
        'from the develop and main branches.'
      ].join('\n'),
      description: 'Instructions for configuring GitHub Actions'
    });
  }
}
