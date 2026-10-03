# LocalStack Local Development Guide

This guide explains how to use LocalStack for local testing of AWS services before deploying to the real AWS environment.

## Prerequisites

- Docker Desktop installed and running
- `awslocal` CLI installed (wrapper for AWS CLI pointing to LocalStack)

```bash
# Install awslocal
pip install awscli-local
```

## Starting LocalStack

From the `infrastructure/` directory:

```bash
# Start LocalStack and PostgreSQL
docker compose -f docker-compose.localstack.yml up -d

# Check status
docker compose -f docker-compose.localstack.yml ps

# View logs
docker compose -f docker-compose.localstack.yml logs -f localstack
```

The initialization script (`localstack-init/01-create-resources.sh`) runs automatically and creates:
- DynamoDB tables (rate-limits, job-metadata, migration-routes)
- S3 bucket (classroomio-media-dev)
- SQS queues (media-jobs, email-jobs, notification-jobs)
- CloudWatch log groups

## Services Available

| Service | Endpoint | Purpose |
|---------|----------|---------|
| LocalStack Gateway | http://localhost:4566 | All AWS services |
| PostgreSQL | localhost:5432 | Local Neon replacement |
| Redis | localhost:6379 | Rate limiting & caching |

## Local PostgreSQL Connection

Use this connection string for local testing:

```
postgresql://neondb_owner:local_password@localhost:5432/neondb?sslmode=disable
```

The database is pre-populated with test data:
- Test user: `test@classroomio.com` (ID: `test-user-1`)
- Test session token: `test-session-token-123`
- Test organization: `Test Organization` (ID: `test-org-1`)

## Using awslocal CLI

The `awslocal` command automatically points to LocalStack (localhost:4566):

```bash
# List DynamoDB tables
awslocal dynamodb list-tables

# List S3 buckets
awslocal s3 ls

# List SQS queues
awslocal sqs list-queues

# Query DynamoDB
awslocal dynamodb scan --table-name classroomio-migration-routes-dev

# Upload to S3
awslocal s3 cp test-file.txt s3://classroomio-media-dev/uploads/
```

## Deploying CDK to LocalStack

LocalStack supports CDK deployments via `cdklocal`:

```bash
# Install cdklocal
npm install -g aws-cdk-local

# Bootstrap LocalStack (one-time)
cdklocal bootstrap

# Deploy stacks to LocalStack
cdklocal deploy --all --context env=dev
```

**Note:** Currently our CDK stacks are configured for real AWS. To deploy to LocalStack, you would need to adjust endpoints in the stack configuration.

## Testing Lambda Functions Locally

### Deploy Lambda to LocalStack

```bash
# Create a test Lambda (example)
awslocal lambda create-function \
    --function-name test-function \
    --runtime nodejs20.x \
    --role arn:aws:iam::000000000000:role/lambda-role \
    --handler index.handler \
    --zip-file fileb://function.zip
```

### Invoke Lambda

```bash
awslocal lambda invoke \
    --function-name test-function \
    --payload '{"test": "data"}' \
    output.json

cat output.json
```

## Stopping LocalStack

```bash
# Stop containers
docker compose -f docker-compose.localstack.yml down

# Stop and remove volumes (clean slate)
docker compose -f docker-compose.localstack.yml down -v
```

## Troubleshooting

### LocalStack not starting

```bash
# Check Docker is running
docker ps

# Check LocalStack health
curl http://localhost:4566/_localstack/health

# Restart LocalStack
docker compose -f docker-compose.localstack.yml restart localstack
```

### Can't connect to PostgreSQL

```bash
# Check PostgreSQL is running
docker compose -f docker-compose.localstack.yml ps postgres

# Connect with psql
docker compose -f docker-compose.localstack.yml exec postgres psql -U neondb_owner -d neondb

# View tables
\dt
```

### Reset LocalStack to clean state

```bash
# Stop and remove all data
docker compose -f docker-compose.localstack.yml down -v

# Start fresh
docker compose -f docker-compose.localstack.yml up -d

# Wait for initialization to complete (check logs)
docker compose -f docker-compose.localstack.yml logs -f localstack
```

## Differences from Real AWS

- **IAM:** Simplified - most permissions are auto-granted
- **Endpoints:** All services use localhost:4566
- **ARNs:** Use account ID `000000000000`
- **Credentials:** Use dummy values (test/test)
- **Performance:** Faster than real AWS (no network latency)
- **Cost:** Free (no AWS charges)

## Integration Tests

When running integration tests, set these environment variables:

```bash
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-2
export DATABASE_URL=postgresql://neondb_owner:local_password@localhost:5432/neondb
```

## Resources

- LocalStack Documentation: https://docs.localstack.cloud/
- LocalStack AWS Service Coverage: https://docs.localstack.cloud/user-guide/aws/feature-coverage/
- awslocal CLI: https://github.com/localstack/awscli-local
