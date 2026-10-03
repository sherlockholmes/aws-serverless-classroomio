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
 * Certificate Stack (us-east-1)
 * Deploy first as CloudFront distributions require certificates in us-east-1
 * This stack MUST be in us-east-1 even if other stacks are in different regions
 *
 * Task 18.1: Create ACM certificate for CloudFront
 */
const certificateStack = new CertificateStack(app, `${stackPrefix}-Certificate`, config, {
  // Note: env is set inside CertificateStack to force us-east-1
  description: `ClassroomIO Certificate Stack (us-east-1) - ACM certificate for CloudFront`,
  crossRegionReferences: true
});

/**
 * Storage Stack
 * Deploy after certificate stack as CloudFront distribution needs the certificate
 */
const storageStack = new StorageStack(app, `${stackPrefix}-Storage`, config, {
  env,
  description: `ClassroomIO Storage Stack (${config.environmentName}) - S3 bucket, CloudFront distribution`,
  crossRegionReferences: true,
  certificateArn: certificateStack.certificate.certificateArn
});

// Storage stack depends on certificate stack
storageStack.addStackDependency(certificateStack);

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
