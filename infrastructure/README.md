# ClassroomIO AWS Infrastructure

AWS CDK infrastructure code for ClassroomIO serverless migration. This project defines all AWS resources required for the migration from traditional always-on infrastructure to 100% serverless, pay-per-use architecture.

## Architecture Overview

The infrastructure is organized into four main stacks:

1. **Storage Stack** - S3 bucket for media storage and CloudFront CDN
2. **Queue Stack** - SQS queues, DynamoDB tables, EventBridge scheduler, and Lambda workers
3. **API Stack** - API Gateway HTTP API and Lambda function handlers
4. **Monitoring Stack** - CloudWatch dashboards, alarms, and log groups

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 20.19.3 (matches repo `.nvmrc`)
- pnpm 10.19.0+
- AWS CDK CLI installed (`pnpm add -g aws-cdk`)

## Environment Setup

The infrastructure supports three environments: `dev`, `staging`, and `production`. Environment configuration is defined in `lib/config/environment.ts`.

### Required Environment Variables

Create a `.env` file or export these variables before deployment:

```bash
# AWS Account Configuration
export CDK_DEFAULT_ACCOUNT=123456789012
export CDK_DEFAULT_REGION=us-east-1

# Database (Neon PostgreSQL)
export DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Domain Configuration (OPTIONAL — see "Custom domains" below)
# Leave all of these unset to deploy with the default API Gateway and
# CloudFront URLs. No hosted zone or certificate is required in that case.
# export API_DOMAIN=api.example.com
# export CDN_DOMAIN=cdn.example.com
# export HOSTED_ZONE_ID=Z1234567890ABC
# export CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/abc123        # regional, API Gateway
# export CLOUDFRONT_CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/def456  # us-east-1, CloudFront

# Monitoring
export ALARM_EMAIL=ops@example.com
```

### Custom domains (optional)

Custom domains are fully optional. With none of the domain variables set, a
deployment uses the default API Gateway (`*.execute-api.<region>.amazonaws.com`)
and CloudFront (`*.cloudfront.net`) URLs, and the Certificate stack is not
created.

The relevant variables and the rules the CDK enforces at synth time:

| Variable | Purpose | Required when |
| --- | --- | --- |
| `API_DOMAIN` | Custom domain for the API Gateway | optional |
| `CDN_DOMAIN` | Custom domain for the CloudFront CDN | optional |
| `HOSTED_ZONE_ID` | Route 53 hosted zone for DNS alias records | any custom domain is set |
| `CERTIFICATE_ARN` | **Regional** ACM certificate (same region as the API Gateway) | `API_DOMAIN` is set |
| `CLOUDFRONT_CERTIFICATE_ARN` | **us-east-1** ACM certificate for CloudFront | `CDN_DOMAIN` is set and no hosted zone is supplied to request one |

CloudFront always requires its certificate in **us-east-1**, which is a
different certificate from the regional one the API Gateway uses — hence the
two separate variables. If you set `CDN_DOMAIN` and provide a `HOSTED_ZONE_ID`
but no `CLOUDFRONT_CERTIFICATE_ARN`, the optional Certificate stack requests and
DNS-validates a us-east-1 certificate for you.

Incomplete combinations (for example `CDN_DOMAIN` without a certificate or
hosted zone) fail fast at synth with a message naming the missing variable.
Behavior is identical across `dev`, `staging`, and `production`.

## Available Commands

### Build

Compile TypeScript to JavaScript:

```bash
pnpm build
```

### Synthesize CloudFormation Templates

Generate CloudFormation templates without deploying:

```bash
# Development environment
pnpm synth

# Staging environment
pnpm synth:staging

# Production environment
pnpm synth:production
```

### Deploy

Deploy stacks to AWS:

```bash
# Deploy all stacks to dev
pnpm deploy:dev

# Deploy all stacks to staging
pnpm deploy:staging

# Deploy all stacks to production (requires manual approval)
pnpm deploy:production

# Deploy individual stack
pnpm cdk deploy --context env=dev ClassroomIO-dev-Api
```

### Diff

Show differences between deployed stacks and local changes:

```bash
pnpm diff:dev
pnpm diff:staging
pnpm diff:production
```

### List Stacks

List all stacks in the app:

```bash
pnpm list
```

### Destroy

**⚠️ Warning: Destroys all resources in the environment**

```bash
pnpm destroy:dev
```

## Stack Dependencies

Stacks have the following dependency order:

1. Storage Stack (no dependencies)
2. Queue Stack (no dependencies)
3. API Stack (depends on Storage and Queue)
4. Monitoring Stack (depends on all other stacks)

When deploying or destroying, CDK automatically respects these dependencies.

## Cost Estimation

### Idle Cost (0 requests/day)
- **Neon PostgreSQL**: $0 (scale-to-zero on free tier)
- **DynamoDB**: $0 (on-demand, no stored data)
- **S3 Storage**: ~$1-2/month (depends on HLS content size)
- **CloudWatch Logs**: ~$1/month (minimal logs)
- **Total**: **< $5/month**

### Low Traffic (1,000 users/day)
- **Lambda Invocations**: ~$2/month
- **API Gateway**: ~$1/month
- **Neon PostgreSQL**: ~$5/month
- **DynamoDB**: ~$1/month
- **S3 + CloudFront**: ~$5-10/month
- **Total**: **< $20/month**

### Moderate Traffic (10,000 users/day)
- **Lambda Invocations**: ~$20/month
- **API Gateway**: ~$10/month
- **Neon PostgreSQL**: ~$15/month
- **DynamoDB**: ~$5/month
- **S3 + CloudFront**: ~$20-30/month
- **Total**: **< $80/month**

## Deployment Workflow

### Initial Deployment (Dev Environment)

1. Bootstrap CDK (first time only):

```bash
pnpm cdk bootstrap --context env=dev
```

2. Synthesize templates:

```bash
pnpm synth
```

3. Deploy all stacks:

```bash
pnpm deploy:dev
```

### Incremental Updates

1. Make changes to stack code
2. View differences:

```bash
pnpm diff:dev
```

3. Deploy changes:

```bash
pnpm deploy:dev
```

### Production Deployment

Production deployments require manual approval for safety:

```bash
# Review changes
pnpm diff:production

# Deploy with approval prompt
pnpm deploy:production
```

## Troubleshooting

### CDK Bootstrap Error

If you see "This stack uses assets, so the toolkit stack must be deployed":

```bash
pnpm cdk bootstrap --context env=dev
```

### TypeScript Compilation Errors

Rebuild from scratch:

```bash
rm -rf dist node_modules
pnpm install
pnpm build
```

### CloudFormation Stack Stuck

If a stack is stuck in UPDATE_ROLLBACK_FAILED or similar state, you may need to manually intervene via AWS Console or skip resources that can't be deleted.

## CI/CD Integration

This infrastructure is designed to integrate with GitHub Actions for automated deployment. See `../.github/workflows/` for CI/CD pipeline configuration.

## Security Considerations

- All Lambda functions run with least-privilege IAM roles
- S3 buckets block public access by default
- CloudFront uses signed URLs for video content
- Secrets (database credentials, signing keys) stored in AWS Secrets Manager
- All data in transit encrypted with TLS

## Support

For questions or issues with the infrastructure:
1. Check CloudWatch logs for error details
2. Review CloudFormation stack events in AWS Console
3. Consult the design document: `../prd/aws-serverless-migration/design.md`

## License

MIT
