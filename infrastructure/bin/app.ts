#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { getEnvironmentConfig } from '../lib/config/environment';
import { CicdStack } from '../lib/stacks/cicd-stack';
import { CertificateStack } from '../lib/stacks/certificate-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { StorageStack } from '../lib/stacks/storage-stack';
import { QueueStack } from '../lib/stacks/queue-stack';
import { MonitoringStack } from '../lib/stacks/monitoring-stack';

/**
 * ClassroomIO AWS Serverless Migration CDK App
 *
 * This app orchestrates the deployment of all infrastructure stacks required
 * for the AWS serverless migration. It supports multi-environment deployment
 * (dev, staging, production) via the `env` context variable.
 *
 * Usage:
 *   pnpm cdk synth --context env=dev
 *   pnpm cdk deploy --context env=dev --all
 *   pnpm cdk deploy --context env=production ApiStack
 *
 * Requirements: 17.1, 17.2, 17.5
 * Design: Deployment Strategy § CDK Project Structure
 */

const app = new cdk.App();

// Get environment from context (defaults to 'dev')
const envName = app.node.tryGetContext('env') || 'dev';

// Load environment configuration
const config = getEnvironmentConfig(envName);
console.log(`✓ Loaded configuration for environment: ${envName}`);

// CDK environment properties
const env = {
  account: config.account,
  region: config.region
};

// Stack naming convention: ClassroomIO-{Environment}-{StackName}
const stackPrefix = `ClassroomIO-${config.environmentName}`;

/**
 * CI/CD Stack
 * Deploy first - independent stack that enables GitHub Actions deployment
 * Only needs to be deployed once per environment
 */
const cicdStack = new CicdStack(app, `${stackPrefix}-CICD`, config, {
  env,
  description: `ClassroomIO CI/CD Stack (${config.environmentName}) - OIDC provider, GitHub Actions role`
});

/**
 * Certificate Stack (us-east-1) — OPTIONAL
 *
 * CloudFront requires its certificate in us-east-1. We only create this stack
 * when a custom CDN domain is configured AND no pre-issued us-east-1
 * certificate (CLOUDFRONT_CERTIFICATE_ARN) was supplied. In every other case
 * (no custom CDN domain, or a cert ARN already provided) this stack is not
 * created and CloudFront falls back to its default *.cloudfront.net URL.
 */
const needsCertificateStack = Boolean(config.domain.cdnDomain) && !config.domain.cloudFrontCertificateArn;

const certificateStack = needsCertificateStack
  ? new CertificateStack(app, `${stackPrefix}-Certificate`, config, {
      // Note: env is set inside CertificateStack to force us-east-1
      description: `ClassroomIO Certificate Stack (us-east-1) - ACM certificate for CloudFront`,
      crossRegionReferences: true
    })
  : undefined;

// Resolve the us-east-1 CloudFront certificate ARN, preferring an explicitly
// supplied one, otherwise the ARN produced by the (optional) CertificateStack.
const cloudFrontCertificateArn = config.domain.cloudFrontCertificateArn ?? certificateStack?.certificate.certificateArn;

/**
 * Storage Stack
 * When a CDN certificate is available it attaches the custom domain to the
 * CloudFront distribution; otherwise the distribution uses its default URL.
 */
const storageStack = new StorageStack(app, `${stackPrefix}-Storage`, config, {
  env,
  description: `ClassroomIO Storage Stack (${config.environmentName}) - S3 bucket, CloudFront distribution`,
  crossRegionReferences: true,
  certificateArn: cloudFrontCertificateArn
});

// Storage stack depends on the certificate stack only when it actually exists
if (certificateStack) {
  storageStack.addStackDependency(certificateStack);
}

/**
 * Queue Stack
 * Deploy second as API stack depends on DynamoDB table outputs
 */
const queueStack = new QueueStack(app, `${stackPrefix}-Queue`, config, {
  env,
  description: `ClassroomIO Queue Stack (${config.environmentName}) - SQS queues, DynamoDB tables, EventBridge`
});

/**
 * API Stack
 * Deploy after storage and queue stacks as it references their resources
 */
const apiStack = new ApiStack(app, `${stackPrefix}-Api`, config, {
  env,
  description: `ClassroomIO API Stack (${config.environmentName}) - API Gateway, Lambda functions`,
  migrationRoutesTable: queueStack.migrationRoutesTable,
  emailQueue: queueStack.emailQueue,
  jobMetadataTable: queueStack.jobMetadataTable
});

// API stack depends on storage and queue stacks
apiStack.addStackDependency(storageStack);
apiStack.addStackDependency(queueStack);

/**
 * Monitoring Stack
 * Deploy last as it monitors resources from all other stacks
 */
const monitoringStack = new MonitoringStack(app, `${stackPrefix}-Monitoring`, config, {
  env,
  description: `ClassroomIO Monitoring Stack (${config.environmentName}) - CloudWatch dashboards, alarms`,
  emailDlq: queueStack.emailDlq
});

// Monitoring stack depends on all other stacks
monitoringStack.addStackDependency(apiStack);
monitoringStack.addStackDependency(storageStack);
monitoringStack.addStackDependency(queueStack);

// Synthesize the app
app.synth();
