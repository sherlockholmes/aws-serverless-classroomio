import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/environment';
import { NodejsFunction } from '../../constructs';
import { ApiDomainConstruct, ApiDomainProps } from './shared/domain-base';

/**
 * IdentityDomain — groups this domain's Lambda + route construction.
 *
 * All resources are created on the ApiStack scope (this.stackScope), so every
 * CloudFormation logical ID is byte-identical to the pre-refactor single-stack
 * template (see phase6-design §1.1). Function/route/policy construction is
 * reproduced verbatim from the original api-stack.ts.
 */
export class IdentityDomain extends ApiDomainConstruct {
  constructor(parentScope: Construct, id: string, config: EnvironmentConfig, props: ApiDomainProps) {
    super(parentScope, id, config, props);

    const scope = this.stackScope;
    const { httpApi, authEnv, emailQueue, sesConfigurationSetName } = this.props;

    const authHandlerFunction = new NodejsFunction(scope, 'AuthHandlerFunction', config, {
      functionName: 'auth-handler',
      entry: 'auth-handler/index.ts',
      handler: 'handler',
      description: 'Authentication handler Lambda (Better Auth proxy for all /api/auth/* routes)',
      memorySize: 1024, // Higher memory for Better Auth processing
      timeout: 29, // Match API Gateway timeout for OAuth flows
      bundleFromMonorepoRoot: true, // Needs @cio/db + better-auth bundled
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
        ...authEnv,
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
        GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
        // better-auth's emailVerification/emailAndPassword hooks
        // (packages/db/src/auth/{email-verification,email-password}.ts)
        // call @cio/email's sendEmail() directly and synchronously --
        // they do NOT go through the Email_Queue/email-worker path (that
        // path is for apps/api's fire-and-forget enqueueTransactionalEmail
        // call sites, a different set of templates). This handler needs
        // its own SES wiring for signup verification / forgot-password /
        // password-reset-confirmation emails to actually send.
        EMAIL_PROVIDER: 'ses',
        SES_CONFIGURATION_SET_NAME: sesConfigurationSetName
      }
    });

    // Grant CloudWatch PutMetricData permission for custom metrics
    authHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'] // CloudWatch metrics don't support resource-level permissions
      })
    );

    // SES send permissions -- see the identical, more detailed comment on
    // emailWorkerFunction's policy above for why this is scoped to
    // `identity/*` (SES_Sandbox authorizes against the recipient identity
    // too, not just the sender) rather than just sesEmailIdentity's ARN.
    authHandlerFunction.function.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          `arn:aws:ses:${config.region}:${config.account}:identity/*`,
          `arn:aws:ses:${config.region}:${config.account}:configuration-set/${sesConfigurationSetName}`
        ]
      })
    );

    // Create auth routes - catch all /auth/* routes
    const authHandlerIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'AuthHandlerIntegration',
      authHandlerFunction.function
    );

    httpApi.addRoutes({
      path: '/api/auth/{proxy+}',
      methods: [
        apigatewayv2.HttpMethod.GET,
        apigatewayv2.HttpMethod.POST,
        apigatewayv2.HttpMethod.PUT,
        apigatewayv2.HttpMethod.PATCH,
        apigatewayv2.HttpMethod.DELETE
      ],
      integration: authHandlerIntegration
    });
  }
}
