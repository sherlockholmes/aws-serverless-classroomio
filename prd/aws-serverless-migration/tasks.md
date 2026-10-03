# Implementation Plan: ClassroomIO AWS Serverless Migration

## Overview

This document outlines the implementation tasks for migrating ClassroomIO from traditional always-on infrastructure to a 100% serverless AWS architecture. The migration follows an 8-week Phase 1 plan using the strangler fig pattern to incrementally migrate routes from the current Hono server to Lambda functions.

**Phase 1 Goal**: Migrate core MOOC functionality (courses, lessons, video streaming, assignments, dashboard) to serverless while eliminating fixed compute costs.

**Key Technologies**: AWS Lambda, API Gateway, Neon PostgreSQL, DynamoDB, S3, CloudFront, SQS, EventBridge

## Tasks

### Week 1-2: Foundation & Infrastructure Setup

- [x] 1. CDK Project Setup and Environment Configuration
  - Initialize AWS CDK project with TypeScript in `infrastructure/` directory
  - Create environment configs for dev, staging, and production with region/account settings
  - Set up CDK stacks structure: api-stack, storage-stack, queue-stack, monitoring-stack
  - Configure CDK context for multi-environment deployment
  - Add CDK dependencies to package.json and configure tsconfig.json
  - _Requirements: 17.1, 17.2, 17.5_
  - _Design: Deployment Strategy § CDK Project Structure_
  - _Estimated Time: 6 hours_
  - _Validation: Run `pnpm cdk synth` successfully for dev environment_

- [ ] 2. CI/CD Pipeline Configuration
  - [ ] 2.1 Create GitHub Actions workflow for automated testing and deployment
    - Set up test job with unit test execution
    - Configure artifact upload for Lambda dist/ directory
    - Create deploy-dev, deploy-staging, deploy-production jobs with environment gates
    - Add AWS credentials configuration via secrets
    - Configure manual approval for production deployments
    - _Requirements: 17.4_
    - _Design: Deployment Strategy § CI/CD Pipeline_
    - _Estimated Time: 4 hours_
    - _Validation: Push to develop branch triggers dev deployment_

  - [ ] 2.2 Configure AWS IAM roles for GitHub Actions deployment
    - Create IAM role with CloudFormation, Lambda, S3, API Gateway permissions
    - Configure OIDC provider for GitHub Actions
    - Set up secrets in GitHub repository settings
    - _Requirements: 16.1_
    - _Design: Security Design § IAM Roles_
    - _Estimated Time: 2 hours_
    - _Validation: GitHub Actions can assume role and deploy to dev account_

- [ ] 3. Core AWS Infrastructure Provisioning
  - [ ] 3.1 Create S3 bucket for media storage
    - Provision S3 bucket with versioning enabled
    - Configure bucket policy to block public access
    - Set up lifecycle policies for old content transition to Glacier
    - Create directory structure (/hls/, /assets/, /uploads/)
    - _Requirements: 13.1, 13.4, 13.5, 13.6_
    - _Design: Components § S3 + CloudFront_
    - _Estimated Time: 3 hours_
    - _Validation: Upload test file and verify lifecycle policy active_

  - [ ] 3.2 Create DynamoDB tables for ephemeral state
    - Create rate-limits table with composite_key and window_start keys
    - Create job-metadata table with job_id partition key and status GSI
    - Create migration-routes table with path partition key
    - Enable TTL on rate-limits (24h) and job-metadata (7d)
    - Configure on-demand billing mode
    - _Requirements: 5.1, 14.1, 14.2, 14.3, 14.4_
    - _Design: Data Models § DynamoDB Schema_
    - _Estimated Time: 4 hours_
    - _Validation: Query each table and verify TTL configuration_

  - [ ] 3.3 Set up CloudWatch log groups and dashboards
    - Create log groups for each planned Lambda function with 30-day retention
    - Enable KMS encryption for log groups
    - Create initial dashboard with placeholder widgets
    - _Requirements: 10.1, 10.7_
    - _Design: Monitoring § CloudWatch_
    - _Estimated Time: 3 hours_
    - _Validation: Log groups visible in CloudWatch console_

- [ ] 4. Neon PostgreSQL Integration
  - [ ] 4.1 Test Neon connection pooling from Lambda
    - Create test Lambda function with Neon connection
    - Benchmark cold start connection time (target <500ms)
    - Test connection reuse across invocations
    - Validate SSL/TLS connection with certificate verification
    - Document connection string format for pooler endpoint
    - _Requirements: 2.1, 2.2, 2.3, 2.6, 16.4_
    - _Design: Components § Neon PostgreSQL Integration_
    - _Estimated Time: 5 hours_
    - _Validation: Cold start connects in <500ms, warm connections in <10ms_

  - [ ] 4.2 Implement connection retry logic for scale-to-zero
    - Add exponential backoff retry wrapper for database queries
    - Detect connection timeout errors during Neon wake-up
    - Configure connection timeout to 10 seconds
    - Test retry behavior with paused Neon instance
    - _Requirements: 2.5, 15.1_
    - _Design: Components § Neon PostgreSQL Integration § Connection Pooling Strategy_
    - _Estimated Time: 4 hours_
    - _Validation: Lambda successfully connects after Neon wake-up with retry_

  - [ ] 4.3 Validate Better Auth session storage in Neon
    - Run Drizzle migrations for Better Auth session table
    - Create test session and verify persistence in Neon
    - Test session validation query performance (<100ms target)
    - Verify session expiration cleanup works
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
    - _Design: Components § Neon PostgreSQL Integration § Better Auth Session Storage_
    - _Estimated Time: 5 hours_
    - _Validation: Session created, validated, and expired successfully_

- [ ] 5. Development Environment and Tooling
  - [ ] 5.1 Set up LocalStack for local AWS service testing
    - Create docker-compose.yml with LocalStack and PostgreSQL services
    - Configure LocalStack with lambda, apigateway, dynamodb, s3, sqs services
    - Create helper scripts for deploying to LocalStack
    - Document local development workflow
    - _Requirements: 19.1_
    - _Design: Testing Strategy § Integration Tests_
    - _Estimated Time: 4 hours_
    - _Validation: Lambda function deploys to LocalStack and responds_

  - [ ] 5.2 Configure ESBuild bundler for Lambda functions
    - Create reusable Lambda construct with ESBuild bundling
    - Configure tree-shaking, minification, source maps
    - Set external modules (@aws-sdk/*) to reduce bundle size
    - Target <5MB zipped, <20MB unzipped bundle size
    - Configure ARM64 architecture for cost savings
    - _Requirements: 12.2, 12.6_
    - _Design: Components § Lambda Configuration_
    - _Estimated Time: 4 hours_
    - _Validation: Sample Lambda function bundles to <5MB zipped_

- [ ] 6. Checkpoint - Foundation Complete
  - Verify all infrastructure deploys to dev environment via CDK
  - Confirm Lambda can connect to Neon PostgreSQL
  - Confirm Better Auth sessions persist and validate correctly
  - Run smoke tests on provisioned AWS resources
  - Ensure all tests pass, ask the user if questions arise.

### Week 2-3: Authentication & Core API Routes

- [ ] 7. API Gateway Configuration
  - [ ] 7.1 Create API Gateway HTTP API with custom domain
    - Provision HTTP API (not REST API) for lower cost
    - Configure custom domain api-dev.classroomio.com
    - Set up ACM certificate for *.classroomio.com
    - Configure DNS records in Route 53
    - _Requirements: 11.1_
    - _Design: Components § API Gateway HTTP API_
    - _Estimated Time: 4 hours_
    - _Validation: curl https://api-dev.classroomio.com/health returns response_

  - [ ] 7.2 Configure CORS and request validation
    - Set allowed origins to https://app.classroomio.com and wildcards
    - Enable CORS preflight for all endpoints
    - Configure request size limit to 10MB
    - Set request timeout to 29 seconds
    - _Requirements: 11.5, 11.4_
    - _Design: Components § API Gateway Configuration_
    - _Estimated Time: 3 hours_
    - _Validation: OPTIONS request returns CORS headers_

  - [ ] 7.3 Set up usage plans and throttling
    - Create usage plan with burst limit 5000, rate limit 2000 req/s
    - Configure API Gateway-level throttling
    - Set up CloudWatch metrics for throttling events
    - _Requirements: 5.2, 5.3_
    - _Design: Components § API Gateway Configuration_
    - _Estimated Time: 2 hours_
    - _Validation: Send burst of requests and verify throttling kicks in_

- [ ] 8. Authentication Lambda Functions
  - [ ] 8.1 Implement login Lambda function
    - Create Lambda handler for POST /auth/login
    - Integrate Better Auth for credential validation
    - Create session record in Neon PostgreSQL
    - Return session token in response
    - Add CloudWatch logging for login events
    - _Requirements: 4.1, 4.5, 9.6_
    - _Design: Request Flow § Web Request Flow (Authenticated)_
    - _Estimated Time: 6 hours_
    - _Validation: POST /auth/login with valid credentials returns session token_

  - [ ] 8.2 Implement session validation Lambda function
    - Create Lambda handler for GET /auth/session
    - Extract session token from Authorization header or Cookie
    - Query Neon session table with expiration check
    - Return user context if session valid, 401 if invalid
    - _Requirements: 4.4, 4.6_
    - _Design: Components § Neon PostgreSQL Integration § Session Validation Query_
    - _Estimated Time: 4 hours_
    - _Validation: GET /auth/session with valid token returns user data_

  - [ ] 8.3 Implement logout Lambda function
    - Create Lambda handler for POST /auth/logout
    - Delete session record from Neon PostgreSQL
    - Return success response
    - _Requirements: 4.1, 9.6_
    - _Design: Architecture § Authentication Routes_
    - _Estimated Time: 3 hours_
    - _Validation: POST /auth/logout deletes session from database_

- [ ] 9. Migration Router Lambda
  - [ ] 9.1 Implement migration routing logic
    - Create Lambda router function handling ALL /{proxy+} routes
    - Query migration-routes DynamoDB table for route configuration
    - Implement longest prefix matching algorithm
    - Route to Lambda function or Hono proxy based on config
    - Log routing decisions to CloudWatch
    - _Requirements: 3.1, 3.2, 3.3, 3.6_
    - _Design: Strangler Fig § Routing Mechanism_
    - _Estimated Time: 8 hours_
    - _Validation: Router correctly forwards to Hono proxy for unmigrated routes_

  - [ ] 9.2 Implement canary traffic splitting
    - Add probabilistic routing based on canary percentage
    - Use Math.random() for traffic split decisions
    - Log canary routing decisions with metadata
    - Support canary rollback by updating DynamoDB config
    - _Requirements: 3.4_
    - _Design: Strangler Fig § Routing Logic_
    - _Estimated Time: 4 hours_
    - _Validation: 10% canary routes 10% of requests to Lambda, 90% to Hono_

- [ ] 10. Hono Proxy Lambda
  - [ ] 10.1 Create Hono proxy Lambda function
    - Implement pass-through Lambda that forwards requests to current Hono server
    - Preserve HTTP method, headers, query params, and body
    - Set timeout to 29 seconds to match API Gateway
    - Return response from Hono server to API Gateway
    - Log proxy requests with timing metrics
    - _Requirements: 3.2_
    - _Design: Strangler Fig § Hono Proxy Lambda_
    - _Estimated Time: 5 hours_
    - _Validation: Proxy Lambda successfully forwards request and returns response_

- [ ] 11. Account Profile Routes
  - [ ] 11.1 Implement account profile Lambda function
    - Create Lambda handler for GET /account/profile
    - Validate session token and extract user ID
    - Query user profile from Neon PostgreSQL
    - Return profile data with 200 status
    - _Requirements: 9.6_
    - _Design: Creating a New Route § Route Pattern_
    - _Estimated Time: 5 hours_
    - _Validation: GET /account/profile returns user profile for authenticated user_

- [ ] 12. Checkpoint - Authentication Complete
  - Verify login flow creates session in Neon
  - Verify session validation works for authenticated requests
  - Verify migration router routes 100% traffic to Hono proxy initially
  - Test logout clears session from database
  - Ensure all tests pass, ask the user if questions arise.

### Week 3-4: Course & Lesson Routes

- [ ] 13. Course Lambda Functions
  - [ ] 13.1 Implement course listing Lambda
    - Create Lambda handler for GET /course
    - Add pagination support (page, limit query params)
    - Query courses from Neon with organization filtering
    - Return paginated course list with metadata
    - Add CloudWatch custom metric for course listing requests
    - _Requirements: 9.1, 18.1_
    - _Design: Performance Design § Database Query Performance_
    - _Estimated Time: 6 hours_
    - _Validation: GET /course returns paginated course list in <500ms_

  - [ ] 13.2 Implement course details Lambda
    - Create Lambda handler for GET /course/:id
    - Query course details with organization and enrollment data
    - Verify user has access to course (enrolled or public)
    - Return course details with lessons metadata
    - _Requirements: 9.1, 18.1_
    - _Design: Request Flow § Web Request Flow_
    - _Estimated Time: 5 hours_
    - _Validation: GET /course/:id returns course details with lessons_

  - [ ] 13.3 Implement course enrollment Lambda
    - Create Lambda handler for POST /course/:id/enroll
    - Validate user authentication and authorization
    - Create enrollment record in Neon PostgreSQL
    - Handle duplicate enrollment gracefully (409 status)
    - Emit CloudWatch custom metric for enrollments
    - _Requirements: 9.1, 10.2_
    - _Design: Components § Lambda Functions § Course Handler_
    - _Estimated Time: 6 hours_
    - _Validation: POST /course/:id/enroll creates enrollment record_

- [ ] 14. Rate Limiting Implementation
  - [ ] 14.1 Implement DynamoDB rate limiter
    - Create rate limiting middleware for Lambda functions
    - Use atomic UpdateItem with condition expression
    - Set counter TTL to 24 hours for automatic cleanup
    - Support per-user and per-IP rate limits
    - Return 429 status when limit exceeded
    - _Requirements: 5.1, 5.5, 5.6_
    - _Design: Components § DynamoDB § rate-limits table_
    - _Estimated Time: 6 hours_
    - _Validation: Exceed rate limit and receive 429 response_

  - [ ] 14.2 Configure Lambda reserved concurrency
    - Set reserved concurrency limits for each Lambda function
    - Configure course handler to max 100 concurrent executions
    - Configure media worker to max 10 concurrent executions
    - Document concurrency limits in CDK configuration
    - _Requirements: 5.3_
    - _Design: Components § Lambda Configuration_
    - _Estimated Time: 2 hours_
    - _Validation: Trigger concurrent requests and verify concurrency limit enforced_

- [ ] 15. Lesson Lambda Functions
  - [ ] 15.1 Implement lesson listing Lambda
    - Create Lambda handler for GET /course/:id/lessons
    - Query lessons for course with proper ordering
    - Filter lessons based on user enrollment status
    - Return lesson list with progress indicators
    - _Requirements: 9.2, 18.2_
    - _Design: Components § Lambda Functions § Lesson Handler_
    - _Estimated Time: 5 hours_
    - _Validation: GET /course/:id/lessons returns ordered lesson list_

  - [ ] 15.2 Implement lesson details Lambda
    - Create Lambda handler for GET /lesson/:id
    - Verify user enrollment in parent course
    - Query lesson content and metadata from Neon
    - Include video asset metadata if present
    - _Requirements: 9.2, 18.2_
    - _Design: Request Flow § Web Request Flow_
    - _Estimated Time: 5 hours_
    - _Validation: GET /lesson/:id returns lesson content with video metadata_

  - [ ] 15.3 Implement lesson progress tracking Lambda
    - Create Lambda handler for POST /lesson/:id/progress
    - Validate user enrollment before allowing progress update
    - Update progress record in Neon with completion percentage
    - Return updated progress data
    - Emit CloudWatch custom metric for lesson completions
    - _Requirements: 9.2, 10.2_
    - _Design: Components § Lambda Functions § Lesson Handler_
    - _Estimated Time: 5 hours_
    - _Validation: POST /lesson/:id/progress updates progress record_

- [ ] 16. CloudWatch Dashboard and Alarms
  - [ ] 16.1 Create operational dashboard
    - Add widgets for request count by route
    - Add widgets for Lambda duration percentiles (p50, p95, p99)
    - Add widgets for error count and error rate
    - Add widgets for DynamoDB read/write capacity usage
    - Add widgets for cost projection based on current usage
    - _Requirements: 10.3, 10.5_
    - _Design: Monitoring § CloudWatch Metrics_
    - _Estimated Time: 6 hours_
    - _Validation: Dashboard displays real-time metrics for Lambda functions_

  - [ ] 16.2 Configure CloudWatch alarms
    - Create alarm for error rate > 1% (5-minute window)
    - Create alarm for p95 latency > 1 second
    - Create alarm for Lambda throttling events
    - Configure SNS topic for alarm notifications
    - Subscribe ops email to SNS topic
    - _Requirements: 10.6_
    - _Design: Performance Design § CloudWatch Insights Queries_
    - _Estimated Time: 4 hours_
    - _Validation: Trigger alarm condition and receive SNS notification_

- [ ] 17. Checkpoint - Course Routes Migration
  - Deploy course and lesson Lambda functions to dev environment
  - Update migration-routes DynamoDB: /course/* → canary 10%
  - Monitor error rate and latency for 24 hours
  - Gradually increase canary: 10% → 25% → 50% → 100%
  - Update migration-routes: /course/* → target: lambda
  - Ensure all tests pass, ask the user if questions arise.

### Week 4-5: Video Streaming

- [ ] 18. CloudFront Distribution Setup
  - [ ] 18.1 Create CloudFront distribution with S3 origin
    - Create distribution with S3 media bucket as origin
    - Configure Origin Access Control (OAC) for private S3 access
    - Set custom domain cdn-dev.classroomio.com
    - Configure SSL certificate from ACM
    - Enable standard logging to S3
    - _Requirements: 8.1, 13.4_
    - _Design: Components § S3 + CloudFront § CloudFront Distribution_
    - _Estimated Time: 5 hours_
    - _Validation: Access CloudFront URL and receive S3 object_

  - [ ] 18.2 Configure cache behaviors for video content
    - Create behavior for /hls/* with private caching
    - Set master.m3u8 cache TTL to 10 seconds
    - Set variant playlist (.m3u8) cache TTL to 5 minutes
    - Set video segments (.ts) cache TTL to 1 year with immutable flag
    - Create behavior for /assets/* with public caching (1 day)
    - _Requirements: 8.4, 8.5_
    - _Design: Components § S3 + CloudFront § Cache Behavior Details_
    - _Estimated Time: 4 hours_
    - _Validation: Verify cache headers on master.m3u8 and .ts files_

  - [ ] 18.3 Set up CloudFront signed URLs
    - Generate RSA key pair for signed URL generation
    - Store private key in AWS Secrets Manager
    - Create CloudFront key group with public key
    - Configure trusted key groups on distribution
    - Document key rotation procedure (90-day rotation)
    - _Requirements: 8.2, 16.2_
    - _Design: Security Design § CloudFront Security § Signed URLs_
    - _Estimated Time: 4 hours_
    - _Validation: Generate signed URL and verify CloudFront accepts it_

- [ ] 19. S3 Bucket Configuration
  - [ ] 19.1 Configure S3 bucket policy for CloudFront OAC
    - Update bucket policy to allow CloudFront OAC access
    - Block all public access at bucket level
    - Enable versioning for critical assets (master.m3u8)
    - Enable SSE-S3 encryption for all objects
    - _Requirements: 13.4, 13.6, 16.2_
    - _Design: Security Design § S3 Bucket Security_
    - _Estimated Time: 3 hours_
    - _Validation: CloudFront can fetch objects, direct S3 access returns 403_

  - [ ] 19.2 Create S3 lifecycle policies
    - Create lifecycle policy to transition /uploads/* to deletion after 7 days
    - Create lifecycle policy to transition old /hls/* to Glacier after 90 days
    - Document lifecycle policy rationale and cost impact
    - _Requirements: 13.5_
    - _Design: Data Models § S3 Object Structure_
    - _Estimated Time: 3 hours_
    - _Validation: Verify lifecycle policies appear in S3 console_

- [ ] 20. HLS Video URL Generation Lambda
  - [ ] 20.1 Implement video URL generation Lambda
    - Create Lambda handler for GET /course/:slug/item/:slug/video-url
    - Verify user enrollment in course
    - Query lesson asset metadata from Neon
    - Generate CloudFront signed URL with 1-hour expiration
    - Return signed URL with expiry timestamp
    - _Requirements: 8.2, 8.3, 8.7, 18.3_
    - _Design: Components § S3 + CloudFront § Signed URL Generation_
    - _Estimated Time: 6 hours_
    - _Validation: API returns signed URL, hls.js player loads video_

- [ ] 21. S3 Content Migration
  - [ ] 21.1 Copy existing HLS content to S3
    - Script to copy HLS content from current storage to S3
    - Maintain directory structure: /hls/{assetId}/master.m3u8
    - Update asset records in Neon with S3 keys
    - Verify all video segments and manifests copied
    - _Requirements: 8.1_
    - _Design: Data Models § S3 Object Structure_
    - _Estimated Time: 8 hours_
    - _Validation: Sample video plays from S3 via CloudFront_

- [ ] 22. Dashboard Video Player Integration
  - [ ] 22.1 Update video player to fetch signed URLs
    - Modify video player component to call /video-url endpoint
    - Pass signed URL to hls.js player instance
    - Handle 403 errors and URL expiration gracefully
    - Implement URL refresh before expiration (55-minute mark)
    - Add error handling for unenrolled users
    - _Requirements: 8.7, 18.3_
    - _Design: Request Flow § Video Streaming Flow_
    - _Estimated Time: 6 hours_
    - _Validation: Video plays in dashboard without buffering_

- [ ] 23. Checkpoint - Video Streaming Complete
  - Verify video playback works end-to-end via CloudFront
  - Verify signed URLs expire after 1 hour
  - Verify unauthorized users receive 403 errors
  - Monitor CloudFront cache hit ratio (target >80%)
  - Update migration-routes: /hls-cookie → canary 10% → 100%
  - Ensure all tests pass, ask the user if questions arise.

### Week 5-6: Assignments & Dashboard

- [ ] 24. Assignment Lambda Functions
  - [ ] 24.1 Implement assignment listing Lambda
    - Create Lambda handler for GET /course/:id/assignments
    - Query assignments for course from Neon
    - Include submission status for authenticated user
    - Return assignment list with due dates and status
    - _Requirements: 9.3_
    - _Design: Components § Lambda Functions § Assignment Handler_
    - _Estimated Time: 5 hours_
    - _Validation: GET /course/:id/assignments returns assignment list_

  - [ ] 24.2 Implement assignment details Lambda
    - Create Lambda handler for GET /assignment/:id
    - Verify user enrollment in parent course
    - Query assignment content and questions from Neon
    - Include user's previous submission if exists
    - _Requirements: 9.3, 18.4_
    - _Design: Creating a New Route § Route Pattern_
    - _Estimated Time: 5 hours_
    - _Validation: GET /assignment/:id returns assignment details_

  - [ ] 24.3 Implement assignment submission Lambda
    - Create Lambda handler for POST /assignment/:id/submit
    - Validate submission data against assignment schema
    - Store submission record in Neon PostgreSQL
    - Calculate score for auto-graded assignments
    - Emit CloudWatch custom metric for submissions
    - _Requirements: 9.3, 10.2, 18.4_
    - _Design: Components § Lambda Functions § Assignment Handler_
    - _Estimated Time: 8 hours_
    - _Validation: POST /assignment/:id/submit creates submission record_

- [ ] 25. Dashboard Lambda Functions
  - [ ] 25.1 Implement student dashboard Lambda
    - Create Lambda handler for GET /dashboard/student
    - Query enrolled courses with progress data
    - Query upcoming assignment due dates
    - Query recently completed lessons
    - Optimize query with joins to minimize database round-trips
    - _Requirements: 9.4, 18.2_
    - _Design: Request Flow § Web Request Flow_
    - _Estimated Time: 8 hours_
    - _Validation: GET /dashboard/student returns dashboard data in <1s_

  - [ ] 25.2 Implement instructor dashboard Lambda
    - Create Lambda handler for GET /dashboard/instructor
    - Query course analytics (enrollments, completions, submissions)
    - Aggregate assignment submission statistics
    - Return instructor dashboard data
    - Optimize queries with database indexes
    - _Requirements: 9.5, 18.2_
    - _Design: Performance Design § Database Query Performance_
    - _Estimated Time: 8 hours_
    - _Validation: GET /dashboard/instructor returns analytics in <500ms_

- [ ] 26. Database Query Optimization
  - [ ] 26.1 Add indexes for common queries
    - Create index on session(token) for validation queries
    - Create index on course(organization_id, created_at) for listing
    - Create index on enrollment(user_id, course_id) for checks
    - Create index on asset(id, organization_id) for video queries
    - Verify index usage with EXPLAIN ANALYZE
    - _Requirements: 18.1, 18.2_
    - _Design: Performance Design § Query Optimization_
    - _Estimated Time: 4 hours_
    - _Validation: EXPLAIN shows index scans instead of sequential scans_

  - [ ] 26.2 Optimize N+1 query patterns
    - Identify N+1 queries in course listing (lessons per course)
    - Replace with single JOIN query or batch query
    - Identify N+1 queries in dashboard (progress per course)
    - Replace with aggregated queries
    - Benchmark query performance improvements
    - _Requirements: 18.1, 18.2_
    - _Design: Performance Design § Query Optimization § Bad Example_
    - _Estimated Time: 6 hours_
    - _Validation: Dashboard queries reduced from N+1 to single query_

- [ ] 27. Checkpoint - Assignment & Dashboard Complete
  - Verify assignment submission creates database record
  - Verify student dashboard loads in <1s (p95)
  - Verify instructor dashboard analytics load in <500ms
  - Update migration-routes: /assignment/*, /dashboard/* → canary 10%
  - Monitor for 48 hours, then increase canary to 100%
  - Ensure all tests pass, ask the user if questions arise.

### Week 6-8: Background Jobs & Cleanup

- [ ] 28. SQS Queue Setup
  - [ ] 28.1 Create SQS queues for background jobs
    - Create media-jobs queue with 900s visibility timeout
    - Create email-jobs queue with 60s visibility timeout
    - Create notification-jobs queue with 60s visibility timeout
    - Configure max retries to 3 for all queues
    - Create dead letter queues for each main queue
    - _Requirements: 6.1, 6.5_
    - _Design: Components § SQS + Lambda § Queue Design_
    - _Estimated Time: 4 hours_
    - _Validation: Send test message to queue and verify receipt_

- [ ] 29. Video Upload and Transcode Pipeline (MediaConvert)
  - [ ] 29.1 Implement video upload presigned URL Lambda
    - Create Lambda handler for POST /media/upload/init
    - Generate unique assetId (UUID)
    - Create presigned S3 PUT URL for uploads/{assetId}.mp4 (15-minute expiry)
    - Create asset record in Neon with status "pending"
    - Return { assetId, uploadUrl, expiresAt }
    - _Requirements: 22.1, 22.7_
    - _Design: Request Flow § Video Upload and Transcode Flow_
    - _Estimated Time: 5 hours_
    - _Validation: API returns presigned URL, browser uploads directly to S3_

  - [ ] 29.2 Implement S3 event trigger Lambda for MediaConvert job creation
    - Create Lambda triggered by S3 PUT events in uploads/ prefix
    - Extract assetId from S3 object key
    - Fetch asset metadata from Neon
    - Create MediaConvert job with HLS output settings (720p, 1080p)
    - Configure output destination: s3://classroomio-media/hls/{assetId}/
    - Update asset status in Neon to "transcoding"
    - Store MediaConvert job ID in DynamoDB job-metadata
    - _Requirements: 22.2, 22.3, 22.6_
    - _Design: Request Flow § Video Upload and Transcode Flow_
    - _Estimated Time: 8 hours_
    - _Validation: S3 upload triggers Lambda, MediaConvert job created_

  - [ ] 29.3 Configure MediaConvert job templates for HLS output
    - Create MediaConvert job template in CDK
    - Configure HLS output group with adaptive bitrate
    - Add 720p preset (2.8 Mbps bitrate)
    - Add 1080p preset (5.0 Mbps bitrate)
    - Configure segment duration (6 seconds)
    - Enable manifest generation (master.m3u8)
    - _Requirements: 22.4, 22.6_
    - _Design: Service Selection § MediaConvert Decision Details_
    - _Estimated Time: 6 hours_
    - _Validation: MediaConvert job template creates valid HLS output_

  - [ ] 29.4 Implement MediaConvert job completion webhook/EventBridge handler
    - Create Lambda triggered by MediaConvert COMPLETE EventBridge events
    - Fetch job metadata from DynamoDB using job ID
    - Update asset status in Neon to "completed"
    - Update asset metadata (duration, resolution, bitrate)
    - Delete source file from uploads/ to save storage costs
    - Emit CloudWatch custom metric (transcodeComplete, duration)
    - _Requirements: 22.5_
    - _Design: Request Flow § Video Upload and Transcode Flow_
    - _Estimated Time: 6 hours_
    - _Validation: MediaConvert completion triggers Lambda, asset status updated_

  - [ ] 29.5 Test end-to-end video upload → transcode → playback flow
    - Upload test video (5-minute MP4) via presigned URL
    - Verify MediaConvert job triggered and completes
    - Verify HLS output in S3 hls/{assetId}/ directory
    - Generate signed CloudFront URL for master.m3u8
    - Test playback with hls.js player
    - Verify adaptive bitrate switching works
    - _Requirements: 22.1-22.7_
    - _Design: Request Flow § Video Upload and Transcode Flow_
    - _Estimated Time: 4 hours_
    - _Validation: Video uploads, transcodes, and plays successfully_

- [ ] 30. Job Metadata and Event Source Mapping
  - [ ] 30.1 Add job metadata tracking for MediaConvert jobs
    - Write MediaConvert job status to DynamoDB job-metadata table
    - Store job metadata: jobId, assetId, status (pending/running/completed/failed)
    - Update status: pending → running → completed/failed
    - Store retry count and error messages for failed jobs
    - Set TTL to 7 days for automatic cleanup
    - _Requirements: 6.3_
    - _Design: Data Models § DynamoDB § job-metadata table_
    - _Estimated Time: 4 hours_
    - _Validation: Job metadata visible in DynamoDB during MediaConvert processing_

- [ ] 31. Email Worker Lambda
  - [ ] 31.1 Implement email sending Lambda worker
    - Create Lambda handler triggered by email-jobs SQS queue
    - Integrate with current email sending service (e.g., SES)
    - Render email templates with provided data
    - Send email and handle delivery errors
    - Update job metadata in DynamoDB
    - _Requirements: 6.2, 6.5_
    - _Design: Components § SQS + Lambda § Worker Implementation_
    - _Estimated Time: 8 hours_
    - _Validation: Email job sends email successfully_

- [ ] 32. Notification Worker Lambda
  - [ ] 32.1 Implement push notification Lambda worker
    - Create Lambda handler triggered by notification-jobs SQS queue
    - Integrate with push notification service
    - Handle notification delivery failures
    - Update job metadata in DynamoDB
    - _Requirements: 6.2_
    - _Design: Components § SQS + Lambda_
    - _Estimated Time: 6 hours_
    - _Validation: Notification job sends push notification_

- [ ] 33. EventBridge Scheduled Tasks
  - [ ] 33.1 Implement cleanup scheduled Lambda
    - Create Lambda handler for cleanup tasks
    - Query expired sessions from Neon and delete
    - Query old rate limit counters (rely on DynamoDB TTL)
    - Emit CloudWatch custom metric for records deleted
    - _Requirements: 7.1, 7.4_
    - _Design: Components § EventBridge Scheduler § Scheduled Tasks_
    - _Estimated Time: 5 hours_
    - _Validation: Cleanup Lambda deletes expired sessions_

  - [ ] 33.2 Create EventBridge schedule rules
    - Create rule for cleanup-scheduled: cron(0 2 * * ? *)
    - Create rule for aggregate-analytics: cron(0 3 * * ? *)
    - Create rule for check-deadlines: cron(0 * * * ? *)
    - Configure Lambda targets for each rule
    - _Requirements: 7.1, 7.2, 7.5_
    - _Design: Components § EventBridge Scheduler_
    - _Estimated Time: 3 hours_
    - _Validation: Scheduled Lambda invokes at correct time_

- [ ] 34. Job Enqueue Refactoring
  - [ ] 34.1 Replace BullMQ enqueue with SQS SendMessage
    - Identify all BullMQ queue.add() calls in codebase
    - Replace with SQS SendMessage calls
    - Update job payload format to match new worker expectations
    - Add idempotency keys (job_id) to prevent duplicates
    - _Requirements: 6.4_
    - _Design: Components § SQS + Lambda § Enqueue Pattern_
    - _Estimated Time: 10 hours_
    - _Validation: Job enqueued via SQS processes successfully_

  - [ ] 34.2 Implement feature flag cutover for SQS migration
    - Deploy SQS + Lambda workers to production
    - Add feature flag `USE_SQS_JOBS` (default: true) in environment config
    - If flag=false, fallback to BullMQ (keep Redis as emergency rollback for 48 hours)
    - Monitor SQS job success rate for 48 hours (target >99%)
    - After 48 hours of stable SQS operation, terminate Redis instance
    - _Requirements: 6.4_
    - _Design: Phase 1 Implementation Plan § Week 6-8_
    - _Estimated Time: 6 hours_
    - _Validation: Feature flag switches between BullMQ and SQS successfully, Redis terminated after 48h_

- [ ] 35. Dead Letter Queue Monitoring
  - [ ] 35.1 Set up DLQ alarms and dashboards
    - Create CloudWatch alarm for messages in each DLQ
    - Configure SNS notification when DLQ receives message
    - Add DLQ metrics to operational dashboard
    - _Requirements: 15.3_
    - _Design: Error Handling § Dead Letter Queues_
    - _Estimated Time: 3 hours_
    - _Validation: Send failing job to DLQ and receive alarm_

  - [ ] 35.2 Create DLQ processor Lambda
    - Create Lambda for manual DLQ message processing
    - Log failed job details for investigation
    - Store failed job data in DynamoDB failed-jobs table
    - Provide mechanism to retry or discard messages
    - _Requirements: 15.3_
    - _Design: Error Handling § DLQ Processing_
    - _Estimated Time: 5 hours_
    - _Validation: DLQ processor logs and stores failed job data_

- [ ] 36. BullMQ Migration Cutover
  - [ ] 36.1 Stop BullMQ job enqueueing
    - Remove dual-write code, keep only SQS SendMessage
    - Verify all job types migrated to SQS
    - Allow BullMQ queues to drain (process remaining jobs)
    - Monitor for any missed job types
    - _Requirements: 6.4_
    - _Design: Phase 1 Implementation Plan § Week 6-8_
    - _Estimated Time: 4 hours_
    - _Validation: No new jobs enqueued to BullMQ, SQS handles all jobs_

  - [ ] 36.2 Decommission Redis instance
    - Verify no sessions stored in Redis (all in Neon)
    - Verify no rate limiting counters in Redis (all in DynamoDB)
    - Verify no active BullMQ queues
    - Terminate Redis instance
    - Document cost savings
    - _Requirements: 1.3, 4.2, 5.1_
    - _Design: Cost Modeling § Service-by-Service Breakdown_
    - _Estimated Time: 2 hours_
    - _Validation: Redis instance terminated, application continues working_

- [ ] 36. Checkpoint - Background Jobs Complete
  - Verify media transcode jobs complete successfully
  - Verify email jobs send emails without errors
  - Verify scheduled tasks run on time
  - Verify DLQ captures failed jobs
  - Verify Redis decommissioned
  - Ensure all tests pass, ask the user if questions arise.

### Week 8: Final Validation & Cutover

- [ ] 37. Load Testing
  - [ ] 37.1 Configure Artillery load test scenarios
    - Create load test for course browsing flow
    - Create load test for video streaming flow
    - Create load test for assignment submission flow
    - Configure sustained load at 50 req/sec for 5 minutes
    - Configure peak load at 100 req/sec for 2 minutes
    - _Requirements: 18.6, 19.6_
    - _Design: Testing Strategy § Load Tests_
    - _Estimated Time: 6 hours_
    - _Validation: Artillery scenarios defined and validated_

  - [ ] 37.2 Execute load tests against staging environment
    - Run course browsing load test
    - Run video streaming load test
    - Run assignment submission load test
    - Collect metrics: p95 latency, error rate, Lambda throttling
    - Verify p95 latency <1s and error rate <1%
    - _Requirements: 18.6, 19.6_
    - _Design: Testing Strategy § Load Tests § Success Criteria_
    - _Estimated Time: 8 hours_
    - _Validation: Load tests pass with p95 <1s and errors <1%_

  - [ ] 37.3 Identify and resolve bottlenecks
    - Analyze CloudWatch metrics for slow queries
    - Optimize Lambda memory allocation if needed
    - Add database indexes for slow queries
    - Consider provisioned concurrency if cold starts >2s
    - Re-run load tests after optimizations
    - _Requirements: 12.1, 18.1_
    - _Design: Performance Design § Lambda Memory Configuration_
    - _Estimated Time: 8 hours_
    - _Validation: Optimizations improve p95 latency by 20%+_

- [ ] 38. Integration Testing
  - [ ] 38.1 Create integration test suite
    - Write integration tests for authentication flow
    - Write integration tests for course enrollment flow
    - Write integration tests for video streaming flow
    - Write integration tests for assignment submission flow
    - Configure tests to run against staging environment
    - _Requirements: 19.1, 19.2, 19.3, 19.4_
    - _Design: Testing Strategy § Integration Tests_
    - _Estimated Time: 10 hours_
    - _Validation: Integration tests pass against staging_

  - [ ] 38.2 Create E2E test suite with Playwright
    - Write E2E test for login and dashboard navigation
    - Write E2E test for course enrollment
    - Write E2E test for video playback
    - Write E2E test for assignment submission
    - Configure tests to run in CI/CD pipeline
    - _Requirements: 19.2, 19.3, 19.4_
    - _Design: Testing Strategy § End-to-End Tests_
    - _Estimated Time: 12 hours_
    - _Validation: E2E tests pass against staging_

- [ ] 39. Documentation
  - [ ] 39.1 Create architecture diagrams
    - Update high-level architecture diagram with final components
    - Create request flow diagrams for web, video, and background jobs
    - Create data flow diagram showing Lambda → Neon → DynamoDB
    - Export diagrams to documentation directory
    - _Requirements: 20.1_
    - _Design: Architecture § High-Level Architecture Diagram_
    - _Estimated Time: 4 hours_
    - _Validation: Diagrams exported and included in documentation_

  - [ ] 39.2 Write deployment guide
    - Document prerequisites (AWS account, Neon database, credentials)
    - Document environment setup (dev, staging, production)
    - Document deployment commands for CDK stacks
    - Document rollback procedures
    - Document post-deployment validation steps
    - _Requirements: 20.2, 20.6_
    - _Design: Deployment Strategy § Deployment Environments_
    - _Estimated Time: 6 hours_
    - _Validation: Deployment guide tested with fresh environment_

  - [ ] 39.3 Create operational runbooks
    - Write runbook for Lambda cold start troubleshooting
    - Write runbook for database connection issues
    - Write runbook for video streaming 403 errors
    - Write runbook for SQS job failures
    - Write runbook for cost spike investigation
    - _Requirements: 20.3, 20.4_
    - _Design: Appendix § Troubleshooting Guide_
    - _Estimated Time: 8 hours_
    - _Validation: Runbooks reviewed by ops team_

- [ ] 40. Cost Analysis
  - [ ] 40.1 Document cost breakdown
    - Calculate idle cost (0 requests/month)
    - Calculate low traffic cost (1K users/day)
    - Calculate moderate traffic cost (10K users/day)
    - Compare with current infrastructure costs
    - Create cost projection spreadsheet
    - _Requirements: 1.4, 1.5, 1.6, 20.5_
    - _Design: Cost Modeling § Total Cost by Scenario_
    - _Estimated Time: 6 hours_
    - _Validation: Cost spreadsheet reviewed and approved_

  - [ ] 40.2 Configure cost monitoring
    - Create AWS Budget with $20, $50, $100 thresholds
    - Configure budget alarms to notify on 80% threshold
    - Add cost widgets to CloudWatch dashboard
    - Document cost optimization opportunities
    - _Requirements: 1.4, 1.5, 1.6_
    - _Design: Cost Modeling § Cost Monitoring_
    - _Estimated Time: 3 hours_
    - _Validation: Budget alarms configured and tested_

- [ ] 41. Production Cutover
  - [ ] 41.1 Final pre-cutover checklist
    - Verify all P0 routes migrated to Lambda
    - Verify load tests pass with required metrics
    - Verify integration and E2E tests pass
    - Verify CloudWatch dashboards operational
    - Verify alarms configured and SNS subscriptions active
    - Verify documentation complete
    - _Requirements: 23.1-23.7_
    - _Design: Phase 1 Implementation Plan § Success Criteria_
    - _Estimated Time: 4 hours_
    - _Validation: Checklist reviewed and all items complete_

  - [ ] 41.2 Update migration router for production cutover
    - Update migration-routes DynamoDB: /* → target: lambda
    - Configure API Gateway custom domain to point to Lambda API
    - Monitor CloudWatch metrics for 1 hour
    - Verify error rate remains <1% and latency <1s
    - _Requirements: 3.1, 9.1_
    - _Design: Deployment Strategy § Production Cutover_
    - _Estimated Time: 3 hours_
    - _Validation: 100% traffic routes to Lambda successfully_

  - [ ] 41.3 Decommission old infrastructure
    - Wait 24-48 hours for monitoring
    - Terminate Render API server
    - Verify no traffic to old Hono server
    - Calculate actual cost savings
    - Document final production cutover
    - _Requirements: 1.1, 1.2, 23.1_
    - _Design: Phase 1 Implementation Plan § Week 8_
    - _Estimated Time: 2 hours_
    - _Validation: Old infrastructure decommissioned, cost savings realized_

- [ ] 42. Final Checkpoint - Phase 1 Complete
  - All P0 routes serving production traffic via Lambda
  - Load tests pass (p95 <1s, error rate <1%)
  - Cost <$20/month for low traffic scenario
  - CloudWatch dashboards and alarms operational
  - Documentation complete and approved
  - Old infrastructure decommissioned
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks reference specific requirements by number (e.g., _Requirements: 1.1, 1.2_)
- Tasks reference specific design sections for implementation guidance
- Estimated times are provided for planning purposes
- Each task includes validation criteria to verify completion
- Checkpoint tasks ensure incremental validation before proceeding
- Canary deployments allow gradual rollout with easy rollback

## Task Dependency Graph

```json
{
  "waves": [
    {
      "id": 0,
      "tasks": ["1.1", "1.2", "2.1", "2.2", "3.1", "3.2", "3.3"]
    },
    {
      "id": 1,
      "tasks": ["4.1", "5.1", "5.2"]
    },
    {
      "id": 2,
      "tasks": ["4.2", "4.3", "7.1"]
    },
    {
      "id": 3,
      "tasks": ["7.2", "7.3", "8.1", "9.1", "10.1"]
    },
    {
      "id": 4,
      "tasks": ["8.2", "8.3", "9.2", "11.1"]
    },
    {
      "id": 5,
      "tasks": ["13.1", "13.2", "14.1"]
    },
    {
      "id": 6,
      "tasks": ["13.3", "14.2", "15.1"]
    },
    {
      "id": 7,
      "tasks": ["15.2", "15.3", "16.1"]
    },
    {
      "id": 8,
      "tasks": ["16.2", "18.1", "19.1"]
    },
    {
      "id": 9,
      "tasks": ["18.2", "18.3", "19.2", "20.1"]
    },
    {
      "id": 10,
      "tasks": ["21.1", "22.1"]
    },
    {
      "id": 11,
      "tasks": ["24.1", "24.2", "25.1"]
    },
    {
      "id": 12,
      "tasks": ["24.3", "25.2", "26.1"]
    },
    {
      "id": 13,
      "tasks": ["26.2", "28.1"]
    },
    {
      "id": 14,
      "tasks": ["29.1", "30.1", "31.1"]
    },
    {
      "id": 15,
      "tasks": ["29.2", "29.3", "32.1"]
    },
    {
      "id": 16,
      "tasks": ["32.2", "33.1"]
    },
    {
      "id": 17,
      "tasks": ["33.2", "34.1"]
    },
    {
      "id": 18,
      "tasks": ["34.2", "35.1"]
    },
    {
      "id": 19,
      "tasks": ["35.2", "37.1"]
    },
    {
      "id": 20,
      "tasks": ["37.2", "38.1"]
    },
    {
      "id": 21,
      "tasks": ["37.3", "38.2", "39.1"]
    },
    {
      "id": 22,
      "tasks": ["39.2", "39.3", "40.1"]
    },
    {
      "id": 23,
      "tasks": ["40.2", "41.1"]
    },
    {
      "id": 24,
      "tasks": ["41.2"]
    },
    {
      "id": 25,
      "tasks": ["41.3"]
    }
  ]
}
```
