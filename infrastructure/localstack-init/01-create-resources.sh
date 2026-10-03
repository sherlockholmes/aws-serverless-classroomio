#!/bin/bash
# LocalStack initialization script
# Creates AWS resources for local testing
# Task 5.1: Set up LocalStack for local AWS service testing

set -e

echo "Initializing LocalStack resources..."

# Wait for LocalStack to be ready
echo "Waiting for LocalStack to be ready..."
awslocal lambda list-functions || echo "LocalStack warming up..."

# Set default region
export AWS_DEFAULT_REGION=us-east-2

# Create DynamoDB tables
echo "Creating DynamoDB tables..."

# Rate limits table
awslocal dynamodb create-table \
    --table-name classroomio-rate-limits-dev \
    --attribute-definitions \
        AttributeName=composite_key,AttributeType=S \
        AttributeName=window_start,AttributeType=S \
    --key-schema \
        AttributeName=composite_key,KeyType=HASH \
        AttributeName=window_start,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=Environment,Value=local Key=ManagedBy,Value=LocalStack \
    || echo "Rate limits table already exists"

# Job metadata table
awslocal dynamodb create-table \
    --table-name classroomio-job-metadata-dev \
    --attribute-definitions \
        AttributeName=job_id,AttributeType=S \
        AttributeName=status,AttributeType=S \
        AttributeName=created_at,AttributeType=S \
        AttributeName=job_type,AttributeType=S \
    --key-schema \
        AttributeName=job_id,KeyType=HASH \
    --global-secondary-indexes \
        "IndexName=status-index,KeySchema=[{AttributeName=status,KeyType=HASH},{AttributeName=created_at,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
        "IndexName=job-type-status-index,KeySchema=[{AttributeName=job_type,KeyType=HASH},{AttributeName=status,KeyType=RANGE}],Projection={ProjectionType=ALL}" \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=Environment,Value=local Key=ManagedBy,Value=LocalStack \
    || echo "Job metadata table already exists"

# Migration routes table
awslocal dynamodb create-table \
    --table-name classroomio-migration-routes-dev \
    --attribute-definitions \
        AttributeName=path,AttributeType=S \
    --key-schema \
        AttributeName=path,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --tags Key=Environment,Value=local Key=ManagedBy,Value=LocalStack \
    || echo "Migration routes table already exists"

# Create S3 bucket
echo "Creating S3 bucket..."
awslocal s3 mb s3://classroomio-media-dev \
    || echo "S3 bucket already exists"

# Enable versioning
awslocal s3api put-bucket-versioning \
    --bucket classroomio-media-dev \
    --versioning-configuration Status=Enabled

# Create bucket folders
awslocal s3api put-object --bucket classroomio-media-dev --key hls/
awslocal s3api put-object --bucket classroomio-media-dev --key assets/
awslocal s3api put-object --bucket classroomio-media-dev --key uploads/

# Create SQS queues
echo "Creating SQS queues..."
awslocal sqs create-queue --queue-name classroomio-media-jobs-dev \
    || echo "Media jobs queue already exists"

awslocal sqs create-queue --queue-name classroomio-email-jobs-dev \
    || echo "Email jobs queue already exists"

awslocal sqs create-queue --queue-name classroomio-notification-jobs-dev \
    || echo "Notification jobs queue already exists"

# Create dead letter queues
awslocal sqs create-queue --queue-name classroomio-media-jobs-dlq-dev \
    || echo "Media jobs DLQ already exists"

# Create CloudWatch Log Groups
echo "Creating CloudWatch log groups..."
awslocal logs create-log-group --log-group-name /aws/lambda/neon-test-dev \
    || echo "Log group already exists"

echo "LocalStack initialization complete!"
echo ""
echo "Available resources:"
echo "- DynamoDB tables: rate-limits, job-metadata, migration-routes"
echo "- S3 bucket: classroomio-media-dev"
echo "- SQS queues: media-jobs, email-jobs, notification-jobs"
echo "- CloudWatch log groups: /aws/lambda/neon-test-dev"
echo ""
echo "Access LocalStack at: http://localhost:4566"
echo "Access PostgreSQL at: localhost:5432 (user: neondb_owner, password: local_password)"
