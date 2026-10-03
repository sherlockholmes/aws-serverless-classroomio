# Requirements Document: ClassroomIO AWS Serverless Migration

## Introduction

This document defines the requirements for migrating ClassroomIO from its current infrastructure to a 100% serverless, pay-per-use AWS architecture. The migration aims to eliminate fixed compute costs while maintaining application functionality and performance. The migration will follow a strangler fig pattern, routing traffic incrementally from the existing Hono server to AWS Lambda functions via API Gateway.

### Phase 1 Scope

Phase 1 focuses on core MOOC functionality: courses, lessons, video streaming, assignments (quizzes), and student dashboard. Video serving will use pre-transcoded HLS content from S3 via CloudFront. **Video upload and transcoding is included in Phase 1 using a serverless pipeline: S3 + Lambda + AWS Elemental MediaConvert.** Background jobs will migrate from BullMQ to SQS + Lambda.

## Glossary

- **API_Gateway**: AWS API Gateway REST API serving as the HTTP frontend for Lambda functions
- **Better_Auth**: Embedded authentication library using Drizzle ORM and PostgreSQL for session storage
- **BullMQ**: Current Node.js job queue system running on Redis (to be replaced)
- **CloudFront**: AWS CDN for delivering HLS video content with low latency
- **CloudWatch**: AWS monitoring and logging service
- **DynamoDB**: AWS serverless NoSQL database used for rate limiting counters and queue metadata
- **EventBridge_Scheduler**: AWS serverless job scheduler for recurring tasks
- **HLS**: HTTP Live Streaming protocol for adaptive bitrate video delivery
- **Hono_Proxy**: Current Hono server acting as reverse proxy during migration
- **Lambda**: AWS serverless compute service for running application code
- **Migration_Router**: Lambda function or API Gateway configuration routing requests to migrated vs legacy endpoints
- **Neon_PostgreSQL**: Serverless PostgreSQL database service with scale-to-zero capability
- **P0_Routes**: Priority zero routes covering core MOOC functionality (courses, lessons, assignments, student dashboard)
- **S3**: AWS object storage service for HLS video segments and application assets
- **Signed_URL**: Time-limited, cryptographically signed URL for secure resource access
- **SQS**: AWS Simple Queue Service for asynchronous job processing
- **Strangler_Fig_Pattern**: Incremental migration strategy where new system gradually replaces old system route by route

## Requirements

### Requirement 1: Zero Fixed-Cost Compute Architecture

**User Story:** As a platform operator, I want all compute resources to use serverless pay-per-use pricing, so that idle periods cost near-zero and I only pay for actual usage.

#### Acceptance Criteria

1. THE Migration_Architecture SHALL use AWS Lambda for all application compute
2. THE Migration_Architecture SHALL NOT include any fixed-cost compute services such as EC2, ECS, or Fargate always-on instances
3. THE Migration_Architecture SHALL NOT include ElastiCache or self-hosted Redis instances
4. WHEN the platform is idle with zero traffic, THE Infrastructure_Cost SHALL remain below $5 per month
5. WHEN the platform serves 1,000 users per day, THE Infrastructure_Cost SHALL remain below $20 per month
6. WHEN the platform serves 10,000 users per day, THE Infrastructure_Cost SHALL remain below $80 per month

### Requirement 2: Neon PostgreSQL Database Integration

**User Story:** As a developer, I want to use the provisioned Neon PostgreSQL database, so that I leverage serverless database scaling and pay-per-use pricing.

#### Acceptance Criteria

1. THE Database_Layer SHALL connect to Neon PostgreSQL at the provisioned endpoint
2. THE Database_Connection SHALL use SSL mode with channel binding as required by Neon
3. THE Database_Layer SHALL use connection pooling via Neon's connection pooler endpoint
4. THE Session_Store SHALL use Neon PostgreSQL tables (not Redis or external session stores)
5. THE Database_Connection SHALL handle scale-to-zero behavior gracefully with reconnection logic
6. WHEN a Lambda function cold-starts, THE Database_Connection SHALL establish within 500ms

### Requirement 3: Strangler Fig Migration Strategy

**User Story:** As a platform operator, I want to migrate routes incrementally, so that I can validate each migration step and minimize deployment risk.

#### Acceptance Criteria

1. THE Migration_Router SHALL route P0_Routes to Lambda functions via API_Gateway
2. THE Migration_Router SHALL route non-migrated routes to the Hono_Proxy
3. THE Hono_Proxy SHALL forward requests to the current infrastructure until routes are migrated
4. THE Migration_Router SHALL allow per-route traffic percentage splitting for canary deployments
5. THE Deployment_Process SHALL support rollback of individual routes to Hono_Proxy without full system rollback
6. THE Migration_Router SHALL log routing decisions to CloudWatch for traffic analysis

### Requirement 4: Better Auth Session Management Without Redis

**User Story:** As a developer, I want Better Auth to work without Redis, so that I eliminate fixed-cost session storage while maintaining authentication functionality.

#### Acceptance Criteria

1. THE Better_Auth_Configuration SHALL use Neon_PostgreSQL as the session store
2. THE Better_Auth_Configuration SHALL NOT depend on Redis or ElastiCache
3. THE Session_Store SHALL persist sessions using Better Auth's Drizzle ORM adapter
4. THE Authentication_Flow SHALL issue session tokens stored in Neon_PostgreSQL
5. WHEN a user authenticates, THE Session SHALL persist to Neon_PostgreSQL within 200ms
6. WHEN a user makes an authenticated request, THE Lambda_Function SHALL validate the session token against Neon_PostgreSQL within 100ms

### Requirement 5: Rate Limiting Without Redis

**User Story:** As a platform operator, I want rate limiting to work without Redis, so that I eliminate fixed-cost caching infrastructure while protecting against abuse.

#### Acceptance Criteria

1. THE Rate_Limiter SHALL use DynamoDB to store request counters per user and per IP address
2. THE Rate_Limiter SHALL use API_Gateway usage plans for coarse-grained throttling
3. THE Rate_Limiter SHALL use Lambda function-level throttling for per-function concurrency limits
4. WHEN a request exceeds rate limits, THE API_Gateway SHALL return HTTP 429 status
5. THE Rate_Limiter SHALL enforce limits with eventual consistency acceptable within 5 seconds
6. THE Rate_Limiter SHALL expire counter records using DynamoDB TTL to minimize storage costs

### Requirement 6: Background Job Processing Migration

**User Story:** As a developer, I want background jobs to run on serverless infrastructure, so that job processing has no fixed costs during idle periods.

#### Acceptance Criteria

1. THE Job_Queue SHALL use SQS for asynchronous job enqueueing
2. THE Job_Worker SHALL use Lambda functions triggered by SQS events
3. THE Job_Metadata SHALL store job status and history in DynamoDB (not Redis)
4. THE Migration_Process SHALL migrate existing BullMQ jobs to SQS + Lambda patterns
5. WHEN a job is enqueued, THE SQS_Queue SHALL trigger a Lambda_Worker within 5 seconds
6. WHEN a job fails, THE SQS_Queue SHALL retry with exponential backoff up to 3 attempts before moving to a dead letter queue

### Requirement 7: Scheduled Job Execution

**User Story:** As a platform operator, I want scheduled tasks to run without always-on infrastructure, so that recurring jobs have no fixed costs.

#### Acceptance Criteria

1. THE Scheduler SHALL use EventBridge_Scheduler for all recurring tasks
2. THE Scheduler SHALL invoke Lambda functions directly without intermediate compute
3. THE Scheduler SHALL support cron expressions for job scheduling
4. THE Migration_Process SHALL identify all current scheduled jobs and map them to EventBridge rules
5. WHEN a scheduled time arrives, THE EventBridge_Scheduler SHALL invoke the target Lambda_Function within 1 minute
6. THE Scheduler SHALL log all invocations to CloudWatch for auditing

### Requirement 8: HLS Video Streaming from CloudFront

**User Story:** As a student, I want to stream course videos reliably, so that I can watch lessons without buffering or access issues.

#### Acceptance Criteria

1. THE Video_Delivery SHALL serve HLS video segments from S3 via CloudFront
2. THE Video_Access SHALL use Signed_URLs with 1-hour expiration for security
3. THE Lambda_Function SHALL generate Signed_URLs when a student requests video access
4. THE CloudFront_Distribution SHALL cache HLS manifest files (.m3u8) with 5-minute TTL
5. THE CloudFront_Distribution SHALL cache video segments (.ts files) with 24-hour TTL
6. WHEN a student plays a video, THE HLS_Player SHALL select appropriate bitrate based on network conditions
7. THE Video_Access SHALL verify student enrollment before generating Signed_URLs

### Requirement 9: P0 Route Migration Coverage

**User Story:** As a platform operator, I want all core MOOC routes migrated in Phase 1, so that the MVP supports essential student and instructor workflows.

#### Acceptance Criteria

1. THE Migration SHALL include routes for course listing, course details, and course enrollment
2. THE Migration SHALL include routes for lesson listing, lesson content retrieval, and lesson progress tracking
3. THE Migration SHALL include routes for assignment listing, assignment submission, and assignment grading
4. THE Migration SHALL include routes for student dashboard displaying enrolled courses and progress
5. THE Migration SHALL include routes for instructor dashboard displaying course analytics
6. THE Migration SHALL include routes for user authentication (login, logout, session validation)
7. THE Migration SHALL include routes for video access URL generation

### Requirement 10: CloudWatch Monitoring and Observability

**User Story:** As a platform operator, I want comprehensive monitoring, so that I can detect issues, measure performance, and optimize costs.

#### Acceptance Criteria

1. THE Lambda_Functions SHALL log all errors and warnings to CloudWatch Logs
2. THE Lambda_Functions SHALL emit custom metrics for business events (enrollments, video views, assignment submissions)
3. THE CloudWatch_Dashboard SHALL display request counts, error rates, and latency percentiles (p50, p95, p99)
4. THE CloudWatch_Dashboard SHALL display Lambda concurrency, duration, and cold start rates
5. THE CloudWatch_Dashboard SHALL display cost projections based on current usage patterns
6. THE CloudWatch_Alarms SHALL trigger notifications when error rates exceed 1% or p95 latency exceeds 1 second
7. THE CloudWatch_Logs SHALL retain application logs for 30 days minimum

### Requirement 11: API Gateway HTTP Integration

**User Story:** As a developer, I want API Gateway to serve as the HTTP frontend, so that Lambda functions receive standardized HTTP events and I can apply gateway-level policies.

#### Acceptance Criteria

1. THE API_Gateway SHALL expose RESTful endpoints for all P0_Routes
2. THE API_Gateway SHALL transform incoming HTTP requests to Lambda event format
3. THE API_Gateway SHALL extract authentication tokens from request headers and pass to Lambda
4. THE API_Gateway SHALL enforce request size limits of 10MB maximum
5. THE API_Gateway SHALL enable CORS for all endpoints with configured allowed origins
6. THE API_Gateway SHALL log all requests to CloudWatch for audit trails
7. WHEN a Lambda_Function returns an error, THE API_Gateway SHALL transform it to appropriate HTTP status codes

### Requirement 12: Lambda Cold Start Optimization

**User Story:** As a student, I want fast response times, so that the platform feels responsive even after idle periods.

#### Acceptance Criteria

1. THE Lambda_Functions SHALL use provisioned concurrency for high-traffic routes when cold start p95 exceeds 2 seconds
2. THE Lambda_Functions SHALL minimize deployment package size to reduce cold start duration
3. THE Lambda_Functions SHALL use connection pooling to reuse database connections across invocations
4. THE Lambda_Functions SHALL lazy-load non-critical dependencies after initialization
5. WHEN a Lambda_Function cold-starts, THE Total_Response_Time SHALL remain below 3 seconds for p95
6. THE Lambda_Configuration SHALL use ARM64 architecture for 20% cost savings where compatible

### Requirement 13: S3 Static Asset Hosting

**User Story:** As a platform operator, I want static assets served efficiently, so that frontend performance is not degraded by the migration.

#### Acceptance Criteria

1. THE S3_Bucket SHALL store all HLS video segments and manifests
2. THE S3_Bucket SHALL store course images, thumbnails, and attachments
3. THE CloudFront_Distribution SHALL cache static assets with appropriate TTLs
4. THE S3_Bucket SHALL block public access except via CloudFront signed requests
5. THE S3_Bucket SHALL use lifecycle policies to transition infrequently accessed content to Glacier after 90 days
6. THE S3_Bucket SHALL enable versioning for critical assets to support rollback

### Requirement 14: DynamoDB for Ephemeral State

**User Story:** As a developer, I want fast key-value storage for ephemeral state, so that I can replace Redis without performance degradation.

#### Acceptance Criteria

1. THE DynamoDB_Tables SHALL store rate limiting counters with partition key on user ID or IP address
2. THE DynamoDB_Tables SHALL store queue metadata including job status and retry counts
3. THE DynamoDB_Tables SHALL use on-demand billing for unpredictable workloads
4. THE DynamoDB_Tables SHALL use TTL to automatically expire records older than 24 hours for rate limiting
5. WHEN a Lambda_Function writes to DynamoDB, THE Write_Latency SHALL remain below 50ms for p95
6. WHEN a Lambda_Function reads from DynamoDB, THE Read_Latency SHALL remain below 10ms for p95

### Requirement 15: Error Handling and Resilience

**User Story:** As a platform operator, I want robust error handling, so that transient failures do not impact user experience.

#### Acceptance Criteria

1. THE Lambda_Functions SHALL implement exponential backoff for retryable errors (network, throttling)
2. THE Lambda_Functions SHALL catch and log all exceptions with context for debugging
3. THE SQS_Queues SHALL use dead letter queues for messages failing after 3 retry attempts
4. THE API_Gateway SHALL return structured error responses with error codes and messages
5. WHEN a downstream service (S3, DynamoDB, Neon) is unavailable, THE Lambda_Function SHALL return HTTP 503 and log the outage
6. WHEN a database query times out, THE Lambda_Function SHALL return HTTP 504 after 25 seconds (before API Gateway 29s timeout)

### Requirement 16: Security and Access Control

**User Story:** As a security engineer, I want secure resource access, so that unauthorized users cannot access course content or student data.

#### Acceptance Criteria

1. THE Lambda_Functions SHALL run with least-privilege IAM roles granting only required permissions
2. THE S3_Bucket SHALL block public access and require signed URLs for all content retrieval
3. THE API_Gateway SHALL validate authentication tokens before invoking Lambda functions
4. THE Neon_Database_Connection SHALL use SSL/TLS with certificate verification
5. THE CloudFront_Distribution SHALL use HTTPS only and reject HTTP requests
6. THE Lambda_Functions SHALL sanitize user inputs to prevent SQL injection and XSS attacks
7. THE Lambda_Environment_Variables SHALL encrypt sensitive values (database credentials, signing keys) using AWS KMS

### Requirement 17: Deployment and Infrastructure as Code

**User Story:** As a DevOps engineer, I want infrastructure defined as code, so that deployments are repeatable, auditable, and version-controlled.

#### Acceptance Criteria

1. THE Infrastructure SHALL be defined using AWS CDK with TypeScript
2. THE CDK_Stack SHALL provision API_Gateway, Lambda functions, S3 buckets, CloudFront distributions, DynamoDB tables, SQS queues, and EventBridge rules
3. THE CDK_Stack SHALL use CloudFormation for deployment with change sets for review
4. THE Deployment_Pipeline SHALL run integration tests before promoting to production
5. THE CDK_Stack SHALL support multiple environments (dev, staging, production) with environment-specific configurations
6. THE CDK_Code SHALL be stored in version control with the application code

### Requirement 18: Performance Requirements

**User Story:** As a student, I want fast page loads and video streaming, so that I can access course content without frustration.

#### Acceptance Criteria

1. WHEN a student requests a course page, THE Response_Time SHALL remain below 1 second for p95
2. WHEN a student requests a lesson page, THE Response_Time SHALL remain below 1 second for p95
3. WHEN a student starts video playback, THE Time_To_First_Frame SHALL remain below 3 seconds for p95
4. WHEN a student submits an assignment, THE Response_Time SHALL remain below 2 seconds for p95
5. THE Lambda_Functions SHALL respond within 25 seconds to avoid API Gateway timeout
6. THE System SHALL handle 100 concurrent requests without throttling errors

### Requirement 19: Migration Testing and Validation

**User Story:** As a QA engineer, I want comprehensive testing of migrated routes, so that I can verify functional equivalence before cutover.

#### Acceptance Criteria

1. THE Test_Suite SHALL include integration tests for all P0_Routes
2. THE Test_Suite SHALL verify authentication flows including login, session validation, and logout
3. THE Test_Suite SHALL verify video streaming including URL generation and CloudFront delivery
4. THE Test_Suite SHALL verify background jobs including enqueueing, processing, and status tracking
5. THE Test_Suite SHALL verify rate limiting enforcement for both compliant and violating clients
6. THE Test_Suite SHALL include load tests simulating 1,000 and 10,000 users per day
7. THE Test_Results SHALL compare response times, error rates, and functionality between old and new infrastructure

### Requirement 20: Documentation and Runbooks

**User Story:** As a platform operator, I want deployment documentation and operational runbooks, so that I can deploy updates and respond to incidents confidently.

#### Acceptance Criteria

1. THE Documentation SHALL include architecture diagrams showing API Gateway, Lambda, S3, CloudFront, DynamoDB, SQS, and Neon PostgreSQL
2. THE Documentation SHALL include deployment instructions for initial provisioning and subsequent updates
3. THE Documentation SHALL include runbooks for common operational tasks (scaling, log analysis, cost optimization)
4. THE Documentation SHALL include troubleshooting guides for common issues (cold starts, timeouts, database connection errors)
5. THE Documentation SHALL include cost analysis with monthly projections for idle, low, and moderate traffic scenarios
6. THE Documentation SHALL include rollback procedures for reverting routes to Hono_Proxy

### Requirement 21: NAT Gateway Cost Optimization

**User Story:** As a platform operator, I want to minimize or eliminate NAT Gateway costs, so that network costs do not become a fixed baseline expense.

#### Acceptance Criteria

1. WHERE Lambda functions require internet access, THE Architecture SHALL use VPC endpoints for AWS services (S3, DynamoDB, SQS)
2. WHERE Lambda functions require public internet access for non-AWS services, THE Architecture SHALL evaluate NAT Gateway necessity vs cost
3. THE Architecture SHALL document all use cases requiring NAT Gateway and justify the cost
4. WHERE possible, THE Lambda_Functions SHALL run outside VPC to avoid NAT Gateway dependency
5. THE Cost_Analysis SHALL break down NAT Gateway costs separately and identify optimization opportunities

### Requirement 22: Video Upload and Transcode Pipeline

**User Story:** As an instructor, I want to upload videos and have them automatically transcoded to HLS format, so that students can stream them reliably without manual encoding.

#### Acceptance Criteria

1. THE Upload_Flow SHALL generate presigned S3 URLs for direct browser uploads to avoid Lambda payload limits
2. WHEN a video file is uploaded to S3 uploads/, THE S3_Event SHALL trigger a Lambda function within 5 seconds
3. THE Transcode_Lambda SHALL create an AWS Elemental MediaConvert job with HLS output configuration
4. THE MediaConvert_Job SHALL output HLS master playlist and segments to S3 hls/{assetId}/
5. WHEN the MediaConvert job completes, THE Completion_Handler SHALL update the asset status in Neon to "completed"
6. THE MediaConvert_Job SHALL support multiple resolutions (720p, 1080p) for adaptive bitrate streaming
7. THE Upload_API SHALL return a unique assetId and uploadUrl to the client for tracking

### Requirement 23: Success Metrics and Acceptance

**User Story:** As a stakeholder, I want clear success criteria, so that I can objectively evaluate whether the migration achieved its goals.

#### Acceptance Criteria

1. THE Migration SHALL be considered successful when all P0_Routes are deployed to Lambda and serving production traffic
2. THE Migration SHALL be considered successful when HLS video streaming works via CloudFront with Signed_URLs
3. THE Migration SHALL be considered successful when idle cost remains below $5 per month
4. THE Migration SHALL be considered successful when p95 latency remains below 1 second for P0_Routes
5. THE Migration SHALL be considered successful when success rate exceeds 99% for P0_Routes
6. THE Migration SHALL be considered successful when CloudWatch dashboards and alarms are operational
7. THE Migration SHALL be considered successful when deployment documentation is complete and verified

## Non-Functional Requirements

### NFR-1: Cost Efficiency
- Idle infrastructure cost < $5/month
- 1K users/day cost < $20/month
- 10K users/day cost < $80/month
- 80-95% cost reduction vs current infrastructure

### NFR-2: Performance
- p95 response time < 1s for web requests
- p95 cold start time < 3s
- p95 video time-to-first-frame < 3s
- Database connection establishment < 500ms on cold start

### NFR-3: Reliability
- Success rate > 99% for all P0_Routes
- Database connection retry logic handles scale-to-zero
- SQS job retry with exponential backoff (3 attempts)
- Dead letter queues capture failed jobs

### NFR-4: Scalability
- Handle 100 concurrent requests without throttling
- Lambda concurrency limits configured per function
- DynamoDB on-demand scaling for unpredictable load
- CloudFront global edge caching for video content

### NFR-5: Security
- All data in transit encrypted with TLS
- S3 buckets block public access
- IAM roles follow least-privilege principle
- Sensitive environment variables encrypted with KMS
- Signed URLs with 1-hour expiration for video access

### NFR-6: Observability
- All Lambda functions log to CloudWatch
- Custom metrics for business events
- CloudWatch dashboard with cost, performance, and error metrics
- Alarms for error rate > 1% or p95 latency > 1s
- 30-day log retention

### NFR-7: Maintainability
- Infrastructure as code using AWS CDK
- TypeScript for CDK and Lambda functions
- Deployment via CI/CD pipeline with integration tests
- Multi-environment support (dev, staging, production)

## Constraints

### Technical Constraints
- **Database**: Must use provisioned Neon PostgreSQL endpoint
- **Authentication**: Must use Better Auth with Drizzle ORM (no Cognito in Phase 1)
- **Compute**: Must use AWS Lambda only (no EC2, ECS, Fargate always-on)
- **Migration Pattern**: Must use strangler fig pattern with Hono proxy

### Cost Constraints
- **No Fixed Compute**: Reject any service with hourly billing unless strictly necessary and justified
- **No Redis/ElastiCache**: Replace with DynamoDB and database-backed sessions
- **No RDS Proxy**: Use Neon's connection pooler instead
- **NAT Gateway**: Minimize or eliminate via VPC endpoints

### Timeline Constraints
- **Phase 1 Duration**: 6-8 weeks for MVP
- **Incremental Delivery**: Route-by-route migration with validation

### Scope Constraints
- **Phase 1 In Scope**: Courses, lessons, video streaming, video upload/transcode (MediaConvert), assignments, student dashboard
- **Phase 1 Out of Scope**: AI features, community, cohorts, widgets

## Assumptions

1. Pre-transcoded HLS video content already exists in S3
2. Current Hono server can act as reverse proxy during migration
3. Better Auth supports PostgreSQL session storage via Drizzle adapter
4. Neon PostgreSQL provides sufficient performance for session validation queries
5. DynamoDB eventual consistency is acceptable for rate limiting (5-second window)
6. Lambda cold starts with database connections will meet p95 < 3s target
7. AWS free tier and low-traffic pricing will achieve < $5/month idle cost target

## Dependencies

1. Provisioned Neon PostgreSQL database with connection credentials
2. AWS account with permissions to provision API Gateway, Lambda, S3, CloudFront, DynamoDB, SQS, EventBridge, CloudWatch, IAM, KMS
3. Existing HLS video content in accessible storage
4. Current Hono server codebase for proxy implementation
5. Better Auth library compatible with Drizzle ORM and PostgreSQL

## Risks

1. **Lambda Cold Starts**: Cold start latency may exceed 1s for p95, requiring provisioned concurrency (adds cost)
2. **Database Connection Pooling**: Lambda concurrency may exhaust Neon connection limits, requiring connection pooling optimization
3. **Rate Limiting Accuracy**: DynamoDB eventual consistency may allow brief limit violations during high traffic
4. **NAT Gateway Necessity**: Some integrations may require public internet access, forcing NAT Gateway cost
5. **Video Signed URL Generation**: Generating signed URLs on every video request may add latency vs. cached URLs
6. **Migration Complexity**: Strangler fig pattern requires careful routing logic and testing to avoid traffic disruption

## Out of Scope (Phase 2+)

- AI agent features
- Community and cohort management
- Widget system
- Cognito migration for authentication
- GraphQL API layer
- Multi-region deployment
- CDN origin failover
- Advanced cost optimization (Reserved Concurrency, Savings Plans)
