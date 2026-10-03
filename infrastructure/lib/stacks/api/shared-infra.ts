import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { EnvironmentConfig, getRootZoneName } from '../../config/environment';
import { NodejsFunction } from '../../constructs';
import { migrationRouterInvoke } from './shared/iam';

/**
 * Shared API infrastructure for ApiStack.
 *
 * Owns the pieces every domain depends on: the `neon-test` health Lambda, the
 * HTTP API (+ optional custom domain / Route 53 alias record), default-stage
 * throttling, the `/health` route, and the `migration-router` Lambda (strangler
 * fig). All resources are created on the ApiStack `scope` passed in, so logical
 * IDs match the pre-refactor single-stack template exactly (see
 * phase6-design §1.1).
 */
export interface SharedApiInfraProps {
  migrationRoutesTable: dynamodb.ITable;
}

export class SharedApiInfra extends Construct {
  public readonly httpApi: apigatewayv2.HttpApi;
  public readonly neonTestFunction: NodejsFunction;
  public readonly migrationRouterFunction: NodejsFunction;

  constructor(scope: Construct, id: string, config: EnvironmentConfig, props: SharedApiInfraProps) {
    super(scope, id);

    const { migrationRoutesTable } = props;

    /**
     * Neon Test Lambda Function
     *
     * Task 4.1: Test Neon connection pooling from Lambda
     * Requirements: 2.1, 2.2, 2.3, 2.6, 16.4
     *
     * This Lambda function validates:
     * - Connection to Neon PostgreSQL pooler endpoint
     * - SSL/TLS connection security
     * - Connection reuse across invocations (cold vs warm start)
     * - Query performance benchmarks
     * - Retry logic for scale-to-zero wake-up
     */
    this.neonTestFunction = new NodejsFunction(scope, 'NeonTestFunction', config, {
      functionName: 'neon-test',
      entry: 'neon-test/index.ts',
      handler: 'handler',
      description: 'Test Lambda for Neon PostgreSQL connection validation',
      memorySize: 512,
      timeout: 30, // Allow time for cold start + retries
      environment: {
        // DATABASE_URL is already set in NodejsFunction from config
      }
    });

    // Grant CloudWatch Logs permissions (already included by default)
    // No additional IAM permissions needed for this test function

    /**
     * Task 7.1: API Gateway HTTP API
     *
     * Requirements: 11.1
     *
     * HTTP API (not REST API) for lower cost:
     * - $1.00 per million requests (vs $3.50 for REST API)
     * - No charges for unused capacity
     * - Native support for Lambda proxy integration
     *
     * Custom domain configuration is OPTIONAL and identical across all
     * environments. When API_DOMAIN and its regional CERTIFICATE_ARN are set,
     * the API is mapped to that domain and (if HOSTED_ZONE_ID is set) a Route 53
     * alias record is created. Otherwise the API uses the default execute-api
     * URL and no DNS/certificate resources are created.
     */
    // A custom API domain is only attached when BOTH the domain and its
    // regional certificate are configured (validated in environment.ts).
    const apiDomain = config.domain.apiDomain;
    const useCustomApiDomain = Boolean(apiDomain && config.domain.certificateArn);

    const apiDomainName =
      useCustomApiDomain && apiDomain && config.domain.certificateArn
        ? new apigatewayv2.DomainName(scope, 'ApiDomain', {
            domainName: apiDomain,
            certificate: acm.Certificate.fromCertificateArn(scope, 'Certificate', config.domain.certificateArn)
          })
        : undefined;

    this.httpApi = new apigatewayv2.HttpApi(scope, 'HttpApi', {
      apiName: `${config.environmentName}-classroomio-api`,
      description: `ClassroomIO HTTP API - ${config.environmentName} environment`,

      // CORS configuration - Task 7.2
      corsPreflight: {
        allowOrigins: config.allowedOrigins,
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.PATCH,
          apigatewayv2.CorsHttpMethod.DELETE,
          apigatewayv2.CorsHttpMethod.OPTIONS
        ],
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Api-Key'],
        allowCredentials: true,
        maxAge: cdk.Duration.hours(1)
      },

      // Custom domain mapping (only when configured)
      defaultDomainMapping: apiDomainName ? { domainName: apiDomainName } : undefined
    });

    // Route 53 alias record for the custom API domain — only when a hosted
    // zone is configured.
    if (apiDomainName && apiDomain && config.domain.hostedZoneId) {
      const apiHostedZone = route53.HostedZone.fromHostedZoneAttributes(scope, 'ApiHostedZone', {
        hostedZoneId: config.domain.hostedZoneId,
        zoneName: getRootZoneName(apiDomain)
      });

      new route53.ARecord(scope, 'ApiAliasRecord', {
        zone: apiHostedZone,
        recordName: apiDomain,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.ApiGatewayv2DomainProperties(
            apiDomainName.regionalDomainName,
            apiDomainName.regionalHostedZoneId
          )
        ),
        comment: `API Gateway custom domain for ${config.environmentName}`
      });
    }

    /**
     * Task 7.3: Throttling Configuration
     *
     * Requirements: 5.2, 5.3
     *
     * HTTP API v2 throttling is configured at the stage level.
     * Default stage is automatically created by CDK.
     *
     * Throttling settings:
     * - Burst limit: 5000 requests (absorbs traffic spikes)
     * - Rate limit: 2000 req/s (sustained throughput)
     *
     * Additional protection layers:
     * - Lambda reserved concurrency (per function) - Task 14.2
     * - DynamoDB rate limiting (per user/IP) - Task 14.1
     *
     * Note: HTTP API v2 does NOT support Usage Plans like REST API v1.
     * For per-client throttling, implement in Lambda with DynamoDB.
     */
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as apigatewayv2.CfnStage;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = {
        throttlingBurstLimit: 5000,
        throttlingRateLimit: 2000
      };
    }

    // Create health check route for monitoring and validation
    const healthCheckIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
      'HealthCheckIntegration',
      this.neonTestFunction.function
    );

    this.httpApi.addRoutes({
      path: '/health',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: healthCheckIntegration
    });

    /**
     * Task 9.1: Migration Router Lambda
     *
     * Requirements: 3.1, 3.2, 3.3, 3.6
     *
     * Central routing Lambda that implements the strangler fig pattern:
     * - Receives ALL /{proxy+} requests
     * - Queries migration-routes DynamoDB table
     * - Implements longest prefix matching
     * - Routes to Lambda function OR Hono proxy
     * - Supports canary traffic splitting
     *
     * This Lambda will be the default route handler once Hono proxy is implemented.
     */
    this.migrationRouterFunction = new NodejsFunction(scope, 'MigrationRouterFunction', config, {
      functionName: 'migration-router',
      entry: 'migration-router/index.ts',
      handler: 'handler',
      description: 'Migration router for strangler fig pattern',
      memorySize: 512,
      timeout: 29, // Match API Gateway timeout
      environment: {
        MIGRATION_ROUTES_TABLE: migrationRoutesTable.tableName,
        HONO_PROXY_FUNCTION_NAME: 'hono-proxy' // Will be created in Task 10.1
      }
    });

    // Grant DynamoDB read permissions to migration router
    migrationRoutesTable.grantReadData(this.migrationRouterFunction.function);

    // Grant Lambda invoke permissions (scoped to this environment's functions
    // only — pre-authorized Phase 6 IAM least-privilege tightening, see
    // migrationRouterInvoke).
    this.migrationRouterFunction.function.addToRolePolicy(migrationRouterInvoke(config));

    // TODO: Wire migration router to API Gateway /{proxy+} route after Hono proxy is implemented (Task 10.1)
    // For now, we keep explicit routes only
  }
}
