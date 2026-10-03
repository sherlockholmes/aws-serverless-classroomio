# Design Document: ClassroomIO AWS Serverless Migration

## Overview

This document details the technical design for migrating ClassroomIO from a traditional always-on architecture to a 100% serverless, pay-per-use AWS infrastructure. The migration aims to eliminate fixed compute costs while maintaining application functionality and performance through a carefully orchestrated strangler fig pattern.

### Design Goals

1. **Zero Fixed-Cost Compute**: Achieve <$5/month idle infrastructure cost through serverless services
2. **Gradual Migration**: Implement strangler fig pattern for risk-free, incremental route migration
3. **Functional Equivalence**: Maintain all P0 MOOC features (courses, lessons, video streaming/upload/transcode, assignments, dashboard)
4. **Performance**: Keep p95 response times under 1 second despite cold starts
5. **Observability**: Comprehensive CloudWatch monitoring for cost, performance, and errors

### Current State

**Infrastructure**:
- Hono API server running on Render (always-on Node.js)
- BullMQ workers processing background jobs (video transcoding, emails, notifications)
- Redis for BullMQ queues, rate limiting, and session caching
- PostgreSQL database on Render
- MinIO/S3 for object storage
- Self-managed HLS video streaming

**Fixed Costs**:
- Render API server: ~$25-50/month
- Redis instance: ~$10-20/month  
- PostgreSQL: ~$7-25/month
- **Total baseline**: ~$42-95/month regardless of traffic

### Target State

**Infrastructure**:
- API Gateway HTTP API as HTTP frontend
- Lambda functions for all application compute (ARM64 where possible)
- Neon PostgreSQL with serverless scaling (scale-to-zero capable)
- DynamoDB for rate limiting counters and ephemeral state
- SQS + Lambda for background job processing
- EventBridge Scheduler for recurring tasks
- S3 + CloudFront for HLS video streaming with signed URLs
- CloudWatch for comprehensive monitoring

**Cost Model**:
- **Idle** (0 requests): <$5/month (Neon storage + S3 storage + minimal CloudWatch)
- **Low traffic** (1K users/day): <$20/month
- **Moderate traffic** (10K users/day): <$80/month
- **Savings**: 80-95% reduction from current fixed costs


## Architecture

### High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Client Layer                                │
│  (Browser, Mobile App, External API Consumers)                          │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             │ HTTPS
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CloudFront (CDN)                                 │
│  ┌──────────────────────┬────────────────────┬─────────────────────┐   │
│  │ /hls/* (Video)       │ /assets/* (Static) │ /api/* (API)        │   │
│  │ → S3 (OAC)           │ → S3 (OAC)         │ → API Gateway       │   │
│  │ Signed URLs          │ Public cache       │ Pass-through        │   │
│  └──────────────────────┴────────────────────┴─────────────────────┘   │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      API Gateway HTTP API                                │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Custom Domain: api.classroomio.com                              │   │
│  │ - JWT validation (Better Auth tokens)                           │   │
│  │ - Usage plans (coarse throttling)                               │   │
│  │ - Request/response transformation                               │   │
│  │ - CORS configuration                                             │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└──────────────┬──────────────────────────┬─────────────────────────────┘
               │                          │
               ├──────────────┬───────────┴───────────┬─────────────────┐
               │              │                       │                 │
         Migrated Routes  Non-Migrated          Background          Scheduled
               │              │                       │                 │
               ▼              ▼                       ▼                 ▼
┌──────────────────┐  ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐
│ Lambda Functions │  │ Hono Proxy   │  │ SQS + Lambda     │  │ EventBridge  │
│ (P0 Routes)      │  │ Lambda       │  │ (Workers)        │  │ + Lambda     │
│                  │  │              │  │                  │  │              │
│ - Courses        │  │ Routes to    │  │ - Email send     │  │ - Cleanup    │
│ - Lessons        │  │ current      │  │ - Notifications  │  │ - Reports    │
│ - Assignments    │  │ infra until  │  │ - Transcription  │  │ - Sync tasks │
│ - Dashboard      │  │ migrated     │  │                  │  │              │
│ - Auth           │  │              │  │                  │  │              │
│ - Video Upload   │  │              │  │                  │  │              │
└────────┬─────────┘  └──────┬───────┘  └────────┬─────────┘  └──────┬───────┘
         │                   │                   │                    │
         │                   │                   │                    │
         └───────────────────┴───────────────────┴────────────────────┘
                             │
                             ▼
         ┌───────────────────────────────────────────────────────────┐
         │                  Data & State Layer                        │
         │                                                             │
         │  ┌────────────────┐  ┌──────────────┐  ┌───────────────┐ │
         │  │ Neon PostgreSQL│  │  DynamoDB    │  │      S3       │ │
         │  │                │  │              │  │               │ │
         │  │ - Users/Orgs   │  │ - Rate limit │  │ - HLS videos  │ │
         │  │ - Courses      │  │   counters   │  │ - Manifests   │ │
         │  │ - Progress     │  │ - Job metadata│  │ - Thumbnails  │ │
         │  │ - Sessions     │  │ - TTL enabled│  │ - Attachments │ │
         │  │ (Better Auth)  │  │              │  │ - Uploads     │ │
         │  └────────────────┘  └──────────────┘  └───────────────┘ │
         │                                               │            │
         │                                               │ Event      │
         │                                               ▼            │
         │  ┌────────────────────────────────────────────────────┐  │
         │  │     AWS Elemental MediaConvert                      │  │
         │  │                                                      │  │
         │  │  - HLS transcoding (720p, 1080p)                   │  │
         │  │  - Serverless, pay-per-minute pricing              │  │
         │  │  - Triggered by Lambda on S3 upload                │  │
         │  │  - Outputs to S3 hls/{assetId}/                    │  │
         │  └────────────────────────────────────────────────────┘  │
         └───────────────────────────────────────────────────────────┘
                             │
                             ▼
         ┌───────────────────────────────────────────────────────────┐
         │                   CloudWatch                               │
         │  - Logs (30-day retention)                                 │
         │  - Metrics (custom: enrollments, video views, submissions) │
         │  - Dashboards (costs, performance, errors)                 │
         │  - Alarms (error rate, latency, budget)                    │
         └───────────────────────────────────────────────────────────┘
```


### Request Flow Diagrams

#### 1. Web Request Flow (Authenticated)

```
User Browser
     │
     │ GET /api/course/123
     │ Cookie: auth_token=xyz
     ▼
CloudFront (Pass-through for /api/*)
     │
     ▼
API Gateway
     │
     │ 1. Extract auth_token from Cookie
     │ 2. Check usage plan throttle
     │ 3. Transform to Lambda event
     ▼
Lambda (Course Handler)
     │
     │ 1. Parse event
     │ 2. Validate session token → Neon query
     │ 3. Check org membership
     │ 4. Query course data → Neon
     │ 5. Format response
     ▼
API Gateway
     │
     │ Transform Lambda response → HTTP
     ▼
CloudFront
     │
     ▼
User Browser
```

#### 2. Video Streaming Flow

```
Student clicks "Play Lesson Video"
     │
     ▼
Dashboard calls POST /api/course/:slug/item/:slug/hls-cookie
     │
     ▼
Lambda (HLS Cookie Generator)
     │
     │ 1. Verify student enrollment → Neon
     │ 2. Get asset metadata → Neon
     │ 3. Generate HMAC-signed token (assetId + expiry)
     │ 4. Return { cookieName, token, expiresAt }
     ▼
Dashboard sets cookie, loads hls.js player
     │
     ▼
hls.js fetches GET /hls/{assetId}/master.m3u8
     │
     │ Cookie: cio_hls_{assetId}=signed_token
     ▼
CloudFront
     │
     │ Cache-Control: private, max-age=10 (manifest is mutable)
     ▼
Lambda@Edge (Optional: Cookie validation)
     │
     │ OR direct S3 with OAC if cookies are not validated at edge
     ▼
S3 Bucket (HLS content)
     │
     ▼
CloudFront → User Browser
     │
     ▼
hls.js parses master.m3u8, fetches variant playlists and .ts segments
     │
     │ Each request includes cio_hls_{assetId} cookie
     ▼
CloudFront
     │
     │ Cache-Control: private, max-age=31536000, immutable (segments never change)
     ▼
S3 → CloudFront → User Browser

Time: Initial cookie generation ~200ms
      Master.m3u8 fetch (cached): ~50ms
      Segment fetch (cached): ~20ms per segment
```

#### 3. Background Job Flow

```
User uploads video file
     │
     ▼
Lambda (Media Upload Handler)
     │
     │ 1. Generate presigned S3 URL
     │ 2. Create asset record → Neon
     │ 3. Enqueue transcoding job → SQS
     │ 4. Return { assetId, uploadUrl }
     ▼
Browser uploads directly to S3 using presigned URL
     │
     ▼
S3 triggers S3 Event Notification (optional) or polling
     │
     ▼
SQS Queue (Media Jobs)
     │
     │ Message: { assetId, type: 'transcode' }
     │ Retention: 4 days
     │ Max retries: 3
     ▼
Lambda (Media Worker) - Event Source Mapping
     │
     │ Batch size: 1 (sequential processing)
     │ Max concurrency: 10
     │ Reserved concurrency: 50
     ▼
Lambda processes job:
     │
     │ 1. Fetch asset → Neon
     │ 2. Download source from S3
     │ 3. Run ffmpeg (transcode to HLS)
     │ 4. Upload segments to S3
     │ 5. Update asset status → Neon
     │ 6. Write job metadata → DynamoDB
     ▼
Success: Delete message from SQS
Failure: Retry (exponential backoff) → Dead Letter Queue after 3 attempts

Cost per job: ~$0.001-0.01 depending on video duration
```

#### 4. Scheduled Job Flow

```
EventBridge Scheduler Rule
     │
     │ cron(0 2 * * ? *)  // Daily at 2 AM UTC
     ▼
Lambda (Cleanup Task)
     │
     │ 1. Query expired sessions → Neon
     │ 2. Delete expired records
     │ 3. Query old rate limit counters → DynamoDB
     │ 4. TTL auto-deletes (no explicit delete needed)
     │ 5. Log results → CloudWatch
     │ 6. Emit custom metric (recordsDeleted)
     ▼
CloudWatch Logs + Metrics

Cold start: ~500ms (runs once/day, cold start acceptable)
Execution: ~5-30 seconds depending on data volume
Cost: ~$0.0001 per run
```

#### 5. Video Upload and Transcode Flow

```
Instructor uploads video file
     │
     ▼
Lambda (Media Upload Handler)
     │
     │ 1. Generate presigned S3 URL
     │ 2. Create asset record → Neon (status: "pending")
     │ 3. Return { assetId, uploadUrl }
     ▼
Browser uploads directly to S3 using presigned URL
     │
     │ PUT https://s3.amazonaws.com/classroomio-media/uploads/{assetId}.mp4
     ▼
S3 Bucket (uploads/)
     │
     │ S3 Event Notification
     ▼
Lambda (MediaConvert Job Creator)
     │
     │ 1. Fetch asset metadata → Neon
     │ 2. Create MediaConvert job
     │    - Input: s3://classroomio-media/uploads/{assetId}.mp4
     │    - Output: s3://classroomio-media/hls/{assetId}/
     │    - Settings: HLS, 720p + 1080p, adaptive bitrate
     │ 3. Update asset status → Neon (status: "transcoding")
     │ 4. Store MediaConvert job ID → DynamoDB
     ▼
AWS Elemental MediaConvert
     │
     │ Transcode video to HLS format
     │ Generate master.m3u8, variant playlists, .ts segments
     │ Duration: ~1 minute per minute of video
     ▼
S3 Bucket (hls/{assetId}/)
     │
     │ MediaConvert job completion event
     ▼
EventBridge (MediaConvert status change)
     │
     ▼
Lambda (MediaConvert Completion Handler)
     │
     │ 1. Fetch job metadata → DynamoDB
     │ 2. Update asset status → Neon (status: "completed")
     │ 3. Update asset metadata (duration, resolution)
     │ 4. Delete source file from uploads/
     │ 5. Emit CloudWatch metric (transcodeComplete)
     ▼
Neon PostgreSQL (asset.status = "completed")

Time: Upload ~variable (depends on file size)
      Job creation ~500ms
      Transcoding ~1-5 min (for 10-min video)
      Completion handler ~200ms

Cost per 10-min video:
  MediaConvert (HD): ~$0.30
  Lambda invocations: ~$0.0001
  S3 storage: ~$0.02/month
  Total: ~$0.30 per video
```


### Strangler Fig Migration Routing

The strangler fig pattern allows incremental migration by routing requests to either the new Lambda-based system or the existing Hono server based on route maturity.

#### Routing Mechanism: API Gateway Stage Variables + Lambda Router

```
API Gateway Custom Domain (api.classroomio.com)
     │
     ▼
API Gateway HTTP API
     │
     │ All routes → Lambda Router (Migration Router)
     ▼
Lambda (Migration Router)
     │
     │ Reads migration config from DynamoDB:
     │ {
     │   "/course/*": { target: "lambda", canary: 0 },
     │   "/lesson/*": { target: "lambda", canary: 0 },
     │   "/assignment/*": { target: "hono", canary: 50 },  // 50% on Lambda
     │   "/*": { target: "hono", canary: 0 }              // Default fallback
     │ }
     │
     ├─────────────────┬──────────────────┐
     │                 │                  │
  target="lambda"  target="hono"    canary=N (random split)
     │                 │                  │
     ▼                 ▼                  ▼
Lambda Handler    Hono Proxy         Weighted Decision
(Migrated route)  (Current infra)   (Random() < N/100)
     │                 │                  │
     │                 │ HTTP request to  │
     │                 │ current Render   │
     │                 │ endpoint         │
     │                 ▼                  │
     │            Hono Server             │
     │            (Legacy infra)          │
     │                 │                  │
     └─────────────────┴──────────────────┘
                       │
                       ▼
                  Response to client
```

#### Migration Config Table (DynamoDB)

**Table**: `migration-routes`  
**Partition Key**: `path` (string)  
**Attributes**:
- `target`: `"lambda" | "hono"`
- `canary`: `0-100` (percentage of traffic to Lambda when target="hono")
- `lambda_function`: ARN of Lambda function (when target="lambda")
- `updated_at`: ISO timestamp
- `updated_by`: User ID who made the change

**Example records**:
```json
[
  {
    "path": "/course/*",
    "target": "lambda",
    "canary": 0,
    "lambda_function": "arn:aws:lambda:us-east-1:123456789012:function:course-handler",
    "updated_at": "2024-12-01T00:00:00Z"
  },
  {
    "path": "/assignment/*",
    "target": "hono",
    "canary": 25,
    "updated_at": "2024-12-01T10:00:00Z"
  },
  {
    "path": "/*",
    "target": "hono",
    "canary": 0,
    "updated_at": "2024-11-01T00:00:00Z"
  }
]
```

#### Routing Logic

```typescript
async function route(request: Request): Promise<Response> {
  const path = request.url.pathname;
  
  // Query DynamoDB for matching routes (longest prefix match)
  const routes = await queryMigrationRoutes(path);
  const config = routes[0] || { target: 'hono', canary: 0 };
  
  // Log routing decision
  logger.info('routing-decision', { 
    path, 
    target: config.target, 
    canary: config.canary 
  });
  
  // Canary routing (probabilistic split)
  if (config.target === 'hono' && config.canary > 0) {
    const random = Math.random() * 100;
    if (random < config.canary) {
      // Send to Lambda (canary traffic)
      return invokeLambdaFunction(config.lambda_function, request);
    }
  }
  
  // Direct routing
  if (config.target === 'lambda') {
    return invokeLambdaFunction(config.lambda_function, request);
  } else {
    return proxyToHonoServer(request);
  }
}
```

#### Hono Proxy Lambda

The Hono Proxy Lambda is a simple pass-through that forwards requests to the current Render-hosted Hono server:

```typescript
// Lambda: hono-proxy
export async function handler(event: APIGatewayProxyEventV2) {
  const honoBaseUrl = process.env.HONO_SERVER_URL; // Current Render URL
  
  const url = new URL(event.rawPath, honoBaseUrl);
  url.search = event.rawQueryString || '';
  
  const response = await fetch(url, {
    method: event.requestContext.http.method,
    headers: event.headers,
    body: event.body || undefined,
  });
  
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  };
}
```

**Cost**: ~$0.0000002 per request (Lambda invocation + HTTP proxy overhead)  
**Latency**: Adds ~50-100ms overhead (Lambda cold start + HTTP round-trip)

#### Migration Sequence (P0 Routes)

**Phase 1.1: Authentication & Core Routes (Week 1-2)**
1. `/auth/login` → Lambda (session creation)
2. `/auth/logout` → Lambda (session deletion)
3. `/auth/session` → Lambda (session validation)
4. `/account/profile` → Lambda (user profile)

**Phase 1.2: Course Discovery (Week 2-3)**
1. `/course` (list) → Lambda
2. `/course/:id` (details) → Lambda
3. `/course/:id/enroll` → Lambda
4. Canary: 10% → 50% → 100% over 3 days

**Phase 1.3: Lesson Delivery (Week 3-4)**
1. `/course/:id/lessons` → Lambda
2. `/lesson/:id` → Lambda
3. `/lesson/:id/progress` → Lambda
4. Canary: 10% → 50% → 100% over 3 days

**Phase 1.4: Video Streaming (Week 4-5)**
1. `/hls-cookie` (token generation) → Lambda
2. `/hls/*` (video segments) → S3 + CloudFront (migrate to signed URLs)
3. CloudFront distribution cutover (DNS change)

**Phase 1.5: Assignments & Dashboard (Week 5-6)**
1. `/assignment/:id` → Lambda
2. `/assignment/:id/submit` → Lambda
3. `/dashboard/student` → Lambda
4. `/dashboard/instructor` → Lambda

**Phase 1.6: Background Jobs (Week 6-8)**
1. BullMQ media jobs → SQS + Lambda
2. BullMQ email jobs → SQS + Lambda
3. BullMQ notification jobs → SQS + Lambda
4. Scheduled cleanup → EventBridge + Lambda

**Rollback Strategy**:
- Per-route rollback: Update DynamoDB `target` to `"hono"`
- Full rollback: Update `/*` default route to `"hono"`
- No downtime: DynamoDB updates take effect on next request (~1s propagation)


## Components and Interfaces

### 1. API Gateway HTTP API

**Purpose**: HTTP frontend for all API requests, providing routing, throttling, CORS, and request/response transformation.

**Configuration**:
```yaml
Type: HTTP API (not REST API - simpler, lower cost)
Custom Domain: api.classroomio.com
Protocol: HTTPS only
CORS:
  - Allowed origins: https://app.classroomio.com, https://*.classroomio.com
  - Allowed methods: GET, POST, PUT, DELETE, PATCH, OPTIONS
  - Allowed headers: Content-Type, Authorization, Cookie, cio-org-id
  - Credentials: true (for cookies)
  - Max age: 86400
Throttling:
  - Burst limit: 5000 requests
  - Rate limit: 2000 requests per second
Request size limit: 10MB
Timeout: 29 seconds (1s less than Lambda max)
```

**Routes**:
- `ANY /{proxy+}` → Lambda (Migration Router)
- All routes go through a single Lambda router for migration flexibility

**Integration**:
```typescript
// API Gateway → Lambda event structure
interface APIGatewayProxyEventV2 {
  version: '2.0';
  routeKey: string;  // "ANY /{proxy+}"
  rawPath: string;   // "/course/123"
  rawQueryString: string;
  cookies?: string[];
  headers: Record<string, string>;
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    http: {
      method: string;
      path: string;
      protocol: string;
      sourceIp: string;
      userAgent: string;
    };
    requestId: string;
    time: string;
    timeEpoch: number;
  };
  body?: string;
  isBase64Encoded: boolean;
}
```

**Cost**:
- First 1M requests/month: $1.00
- Additional requests: $1.00 per million
- Data transfer: $0.09 per GB (out)

### 2. Lambda Functions

#### Architecture Decision: Monolith vs Microservices

**Chosen Approach**: **Hybrid - Domain-Based Functions**

**Rationale**:
- **Not single monolith**: Would exceed 50MB unzipped limit with all dependencies
- **Not per-route microservices**: 100+ functions hard to manage, deploy, monitor
- **Domain-based functions**: 8-12 functions grouped by domain (courses, lessons, assignments, media, auth)

**Function Breakdown**:

| Function Name | Domain | Routes | Memory | Timeout | Concurrency |
|---------------|--------|--------|--------|---------|-------------|
| `migration-router` | Routing | `/*` | 256 MB | 10s | 1000 |
| `auth-handler` | Authentication | `/auth/*`, `/account/*` | 512 MB | 10s | 500 |
| `course-handler` | Courses | `/course/*`, `/org-site/course/*` | 512 MB | 15s | 500 |
| `lesson-handler` | Lessons | `/lesson/*`, `/course/*/item/*` | 512 MB | 15s | 500 |
| `assignment-handler` | Assignments | `/assignment/*`, `/submission/*` | 512 MB | 20s | 300 |
| `media-handler` | Media | `/media/*`, `/hls-cookie` | 512 MB | 10s | 500 |
| `dashboard-handler` | Dashboards | `/dashboard/*`, `/analytics/*` | 512 MB | 15s | 300 |
| `hono-proxy` | Legacy | All non-migrated | 256 MB | 29s | 1000 |
| `media-worker` | Background | SQS trigger | 2048 MB | 900s | 10 |
| `email-worker` | Background | SQS trigger | 512 MB | 60s | 50 |
| `notification-worker` | Background | SQS trigger | 512 MB | 60s | 50 |
| `cleanup-scheduled` | Maintenance | EventBridge | 512 MB | 300s | 1 |

#### Lambda Configuration

**Runtime**: Node.js 20.x (matches repo's `.nvmrc`)  
**Architecture**: ARM64 (Graviton2) - 20% cost savings, supported by Node.js  
**Package format**: .zip (CDK default, faster cold starts than container images)  
**Handler pattern**: Single entry point per function, routes internally

**Example**: `course-handler`
```typescript
// Lambda: course-handler
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';

const app = new Hono()
  .get('/course', listCourses)
  .get('/course/:id', getCourseDetails)
  .post('/course/:id/enroll', enrollInCourse);

export const handler = handle(app);
```

**Environment Variables** (KMS encrypted):
```bash
DATABASE_URL=postgresql://user:pass@ep-xyz.us-east-1.aws.neon.tech/classroomio?sslmode=require
PRIVATE_SERVER_KEY=<base64-encoded-key>
OBJECT_STORAGE_ENDPOINT=https://s3.us-east-1.amazonaws.com
OBJECT_STORAGE_BUCKET=classroomio-media
AWS_REGION=us-east-1
NODE_ENV=production
LOG_LEVEL=info
```

**IAM Role** (Least Privilege):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-east-1:*:log-group:/aws/lambda/course-handler:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ],
      "Resource": [
        "arn:aws:dynamodb:us-east-1:*:table/rate-limits",
        "arn:aws:dynamodb:us-east-1:*:table/migration-routes"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::classroomio-media/*"
    }
  ]
}
```

**Connection Pooling Strategy**:
```typescript
// Reuse Neon connection across invocations
// Lambda containers are reused for ~15 minutes of inactivity

import { drizzle } from 'drizzle-orm/neon-serverless';
import { Pool } from '@neondatabase/serverless';

// OUTSIDE handler - survives across invocations
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  max: 1, // Lambda = 1 concurrent execution per container
});
const db = drizzle(pool);

export async function handler(event: APIGatewayProxyEventV2) {
  // Reuse pool from previous invocation if available
  // First invocation: establishes connection (~300ms)
  // Subsequent invocations: reuses connection (~10ms query overhead)
  
  const courses = await db.select().from(coursesTable).limit(10);
  return { statusCode: 200, body: JSON.stringify(courses) };
}
```

**Cold Start Optimization**:
1. **Minimize deployment size**: 
   - Tree-shake dependencies (ESBuild with `NODE_ENV=production`)
   - Remove dev dependencies
   - Target: <5MB zipped, <20MB unzipped
2. **Lazy load heavy dependencies**:
   - Load ffmpeg only in media-worker (not in API handlers)
   - Defer AWS SDK imports until first use
3. **Provisioned Concurrency** (optional, adds cost):
   - Enable for high-traffic routes if cold start p95 > 2s
   - Cost: $0.015 per GB-hour (e.g., 512MB = ~$5.50/month for 1 instance)
   - Decision: Defer until traffic validates necessity

**Performance Targets**:
- Cold start: <1.5s (p95)
- Warm start: <100ms (p95)
- Database query: <50ms (p95)
- Total response time: <1s (p95)


### 3. Neon PostgreSQL Integration

**Service Choice: Neon over Aurora Serverless v2**

**Why Neon**:
- **True scale-to-zero**: Pauses after 5 minutes of inactivity, $0 compute cost
- **Lower baseline**: Free tier includes 0.5 GB storage, 3 GB data transfer
- **Built-in connection pooling**: No need for RDS Proxy (~$50/month)
- **Fast wake-up**: <500ms from paused state
- **PostgreSQL compatibility**: Drop-in replacement, Drizzle ORM works unchanged

**Why NOT Aurora Serverless v2**:
- **No true scale-to-zero**: Minimum 0.5 ACU always running (~$40/month)
- **Higher baseline cost**: Even at minimum capacity
- **RDS Proxy needed**: For Lambda connection pooling ($50+/month)
- **Total**: ~$90/month minimum vs Neon's $0-5/month idle

**Configuration**:
```yaml
Provider: Neon
Region: us-east-1 (same as Lambda for low latency)
Plan: Launch (Free tier sufficient for MVP, upgrade to Scale as needed)
Compute: Auto-suspend after 5 minutes idle
Storage: 0.5 GB initial (grows as needed)
Pooler: Enabled (connection pooling)
SSL Mode: Require (all connections encrypted)
```

**Connection Strings**:
- **Pooler endpoint** (for Lambda): `postgres://user:pass@ep-xyz-pooler.us-east-1.aws.neon.tech/classroomio?sslmode=require`
- **Direct endpoint** (for migrations): `postgres://user:pass@ep-xyz.us-east-1.aws.neon.tech/classroomio?sslmode=require`

**Lambda Integration**:
```typescript
import { Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';

// Connection pooler handles scale-to-zero wake-up transparently
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1, // Lambda concurrency = 1 per container
  idleTimeoutMillis: 0, // Never close (reuse across invocations)
  connectionTimeoutMillis: 10000, // 10s timeout for wake-up
});

const db = drizzle(pool);

// Query with automatic retry on connection errors
async function queryWithRetry<T>(
  queryFn: () => Promise<T>,
  maxRetries = 2
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await queryFn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      if (isConnectionError(error)) {
        // Neon is waking from paused state, retry
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      throw error;
    }
  }
  throw new Error('Unreachable');
}

function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return (
    message.includes('Connection terminated') ||
    message.includes('ECONNREFUSED') ||
    message.includes('timeout')
  );
}
```

**Better Auth Session Storage**:

Better Auth uses Drizzle ORM for session persistence. Current schema:
```sql
-- Already exists in Neon
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  expires_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_session_token ON session(token);
CREATE INDEX idx_session_user_id ON session(user_id);
CREATE INDEX idx_session_expires_at ON session(expires_at);
```

**Session Validation Query** (runs on every authenticated request):
```typescript
// Lambda: auth validation
async function validateSession(token: string) {
  const session = await db
    .select()
    .from(sessionTable)
    .where(
      and(
        eq(sessionTable.token, token),
        gt(sessionTable.expiresAt, new Date())
      )
    )
    .limit(1);
  
  if (!session[0]) return null;
  return session[0];
}
```

**Performance**: Query time ~10-20ms (warm), ~300-500ms (cold start with wake-up)

**Cost Model**:
- **Free tier**: 0.5 GB storage, 3 GB data transfer/month
- **Scale plan** (if needed): $19/month includes 10 GB storage, 100 GB transfer
- **Compute**: $0.16 per compute hour (only when active)
- **Idle scenario**: $0 (paused after 5 min, storage in free tier)
- **Low traffic** (1K users/day): ~$5-10/month (occasional queries wake compute)
- **Moderate traffic** (10K users/day): ~$15-25/month

### 4. DynamoDB for Ephemeral State

**Service Choice: DynamoDB over ElastiCache Redis**

**Why DynamoDB**:
- **Pay-per-use**: $0 for idle, $0.25 per million writes, $0.05 per million reads
- **No infrastructure**: No instances to manage, patch, or scale
- **TTL**: Automatic expiration of old records (rate limits, job metadata)
- **Eventual consistency acceptable**: 5-second window OK for rate limiting

**Why NOT ElastiCache**:
- **Fixed cost**: Minimum $10-15/month for t4g.micro even with 0 traffic
- **Management overhead**: Upgrades, security patches, scaling
- **Overkill**: Sub-millisecond latency not needed for rate limiting

**Tables**:

#### Table 1: `rate-limits`
```yaml
Partition Key: composite_key (STRING)  # Format: "user:{userId}" or "ip:{ipAddress}"
Sort Key: window_start (NUMBER)        # Unix timestamp (start of rate limit window)
Attributes:
  - count: NUMBER                      # Request count in this window
  - ttl: NUMBER                        # Unix timestamp for auto-deletion (24h later)
Billing Mode: On-Demand
TTL Attribute: ttl
```

**Usage Pattern**:
```typescript
// Check and increment rate limit
async function checkRateLimit(userId: string, limit: number, windowSeconds: number) {
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds;
  const key = `user:${userId}`;
  
  // Atomic increment
  const result = await dynamodb.updateItem({
    TableName: 'rate-limits',
    Key: { composite_key: key, window_start: windowStart },
    UpdateExpression: 'ADD #count :inc SET #ttl = :ttl',
    ExpressionAttributeNames: {
      '#count': 'count',
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: {
      ':inc': 1,
      ':ttl': now + 86400, // 24h TTL
      ':limit': limit,
    },
    ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
    ReturnValues: 'ALL_NEW',
  });
  
  return {
    allowed: true,
    count: result.Attributes.count,
    resetAt: windowStart + windowSeconds,
  };
}

// Throws error if limit exceeded (ConditionExpression fails)
```

**Rate Limit Strategy**:
- **API Gateway usage plans**: Coarse throttling (burst: 5000, rate: 2000 req/s)
- **DynamoDB counters**: Fine-grained per-user/IP limits (e.g., 100 req/hour)
- **Lambda reserved concurrency**: Prevent runaway invocations

#### Table 2: `job-metadata`
```yaml
Partition Key: job_id (STRING)
Attributes:
  - status: STRING                     # pending, running, completed, failed
  - type: STRING                       # media, email, notification
  - created_at: NUMBER                 # Unix timestamp
  - updated_at: NUMBER                 # Unix timestamp
  - retry_count: NUMBER
  - error: MAP                         # { code, message, stack }
  - ttl: NUMBER                        # Unix timestamp (7 days)
Billing Mode: On-Demand
TTL Attribute: ttl
Global Secondary Index: status-index (status, created_at)
```

**Usage**: Track job execution status, support dashboard queries for "recent jobs" or "failed jobs"

#### Table 3: `migration-routes`
(Described in Strangler Fig section above)

**Cost Model**:
- **Write capacity**: $0.25 per million write units
- **Read capacity**: $0.05 per million read units (eventual consistency)
- **Storage**: $0.25 per GB-month
- **Idle**: $0 (no requests = no cost)
- **Low traffic** (1K users/day, 10K rate limit checks): ~$0.25/month
- **Moderate traffic** (10K users/day, 100K checks): ~$2.50/month


### 5. SQS + Lambda for Background Jobs

**Service Choice: SQS over BullMQ/Redis**

**Why SQS**:
- **Serverless**: No Redis instance to manage ($10-20/month saved)
- **Native Lambda integration**: Event source mapping, automatic polling
- **Managed retries**: Built-in DLQ, exponential backoff
- **Cost**: $0.40 per million requests (free tier: 1M requests/month)

**Why NOT BullMQ**:
- **Requires Redis**: Adds fixed cost and management overhead
- **Lambda incompatibility**: BullMQ workers poll Redis, not event-driven
- **Migration effort**: Refactor job enqueue/worker patterns

**Queue Design**:

| Queue Name | Purpose | Visibility Timeout | Max Retries | DLQ |
|------------|---------|-------------------|-------------|-----|
| `media-jobs` | Video transcoding | 900s | 3 | `media-jobs-dlq` |
| `email-jobs` | Email sending | 60s | 3 | `email-jobs-dlq` |
| `notification-jobs` | Push notifications | 60s | 3 | `notification-jobs-dlq` |

**Message Structure**:
```typescript
interface JobMessage {
  jobId: string;              // UUID for idempotency
  type: string;               // Job type (e.g., "transcode", "send-email")
  payload: Record<string, unknown>;
  createdAt: string;          // ISO timestamp
  attemptCount: number;       // Retry counter
}

// Example: Media transcode job
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "type": "transcode-video",
  "payload": {
    "assetId": "asset-123",
    "sourceKey": "uploads/video.mp4",
    "targetResolutions": ["720p", "1080p"]
  },
  "createdAt": "2024-12-01T10:00:00Z",
  "attemptCount": 1
}
```

**Lambda Event Source Mapping**:
```typescript
// CDK configuration
const mediaQueue = new sqs.Queue(this, 'MediaJobsQueue', {
  queueName: 'media-jobs',
  visibilityTimeout: Duration.seconds(900), // 15 min for long transcodes
  retentionPeriod: Duration.days(4),
  deadLetterQueue: {
    queue: mediaJobsDlq,
    maxReceiveCount: 3,
  },
});

const mediaWorker = new lambda.Function(this, 'MediaWorker', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  timeout: Duration.seconds(900),
  memorySize: 2048, // 2GB for ffmpeg
  reservedConcurrentExecutions: 10, // Max 10 concurrent transcodes
});

mediaWorker.addEventSourceMapping('MediaJobsMapping', {
  eventSourceArn: mediaQueue.queueArn,
  batchSize: 1, // Process one job at a time
  maxConcurrency: 10, // Max concurrent Lambda invocations
  reportBatchItemFailures: true, // Retry failed items only
});
```

**Worker Implementation**:
```typescript
// Lambda: media-worker
import { SQSEvent, SQSRecord } from 'aws-lambda';

export async function handler(event: SQSEvent) {
  const results = await Promise.allSettled(
    event.Records.map(record => processRecord(record))
  );
  
  // Report failures for retry (SQS will re-deliver)
  const failures = results
    .map((result, idx) => ({ result, record: event.Records[idx] }))
    .filter(({ result }) => result.status === 'rejected')
    .map(({ record }) => ({ itemIdentifier: record.messageId }));
  
  return {
    batchItemFailures: failures,
  };
}

async function processRecord(record: SQSRecord) {
  const message: JobMessage = JSON.parse(record.body);
  
  // Update job status in DynamoDB
  await updateJobStatus(message.jobId, { status: 'running' });
  
  try {
    // Process job based on type
    switch (message.type) {
      case 'transcode-video':
        await transcodeVideo(message.payload);
        break;
      case 'generate-thumbnail':
        await generateThumbnail(message.payload);
        break;
      default:
        throw new Error(`Unknown job type: ${message.type}`);
    }
    
    // Mark job complete
    await updateJobStatus(message.jobId, { 
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    // Log error, will retry based on SQS config
    console.error('Job failed', { jobId: message.jobId, error });
    
    await updateJobStatus(message.jobId, { 
      status: 'failed',
      error: {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      },
      failedAt: new Date().toISOString(),
    });
    
    throw error; // Reject message for retry
  }
}
```

**Enqueue Pattern** (from API Lambda):
```typescript
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({ region: 'us-east-1' });

async function enqueueTranscodeJob(assetId: string, sourceKey: string) {
  const jobId = crypto.randomUUID();
  
  const message: JobMessage = {
    jobId,
    type: 'transcode-video',
    payload: { assetId, sourceKey, targetResolutions: ['720p', '1080p'] },
    createdAt: new Date().toISOString(),
    attemptCount: 0,
  };
  
  await sqs.send(new SendMessageCommand({
    QueueUrl: process.env.MEDIA_QUEUE_URL,
    MessageBody: JSON.stringify(message),
    MessageDeduplicationId: jobId, // FIFO queue deduplication
  }));
  
  // Store job metadata
  await dynamodb.putItem({
    TableName: 'job-metadata',
    Item: {
      job_id: jobId,
      status: 'pending',
      type: 'transcode-video',
      created_at: Date.now(),
      ttl: Date.now() + 7 * 86400, // 7-day retention
    },
  });
  
  return jobId;
}
```

**Migration from BullMQ**:
1. **Job enqueue**: Replace `queue.add()` with SQS `SendMessage`
2. **Job workers**: Rewrite as Lambda functions with SQS event source
3. **Job status**: Move from Redis to DynamoDB
4. **Cron jobs**: Move to EventBridge (see next section)

**Cost Model**:
- **SQS requests**: $0.40 per million (free tier: 1M/month)
- **Lambda invocations**: $0.20 per million
- **Lambda duration**: $0.0000166667 per GB-second
- **Example** (100 transcode jobs/day, 30s avg):
  - SQS: 100 * 30 = 3,000 messages/month = $0.0012
  - Lambda: 100 * 30 * 2 GB = 6,000 GB-seconds = $0.10
  - **Total**: ~$0.10/month vs $10-20/month for Redis

### 6. EventBridge Scheduler for Recurring Tasks

**Service Choice: EventBridge over Cron Servers**

**Why EventBridge**:
- **Serverless**: No cron daemon or EC2 instance needed
- **Direct Lambda invocation**: No polling overhead
- **Reliable**: AWS-managed, sub-minute precision
- **Cost**: $1.00 per million invocations (first 14M/month free)

**Why NOT Cron Servers**:
- **Fixed cost**: Even minimal EC2 = $5-10/month
- **Management**: OS updates, monitoring, scaling
- **Single point of failure**: Cron daemon crash = missed jobs

**Scheduled Tasks**:

| Task Name | Schedule | Lambda | Purpose |
|-----------|----------|--------|---------|
| `cleanup-expired-sessions` | `cron(0 2 * * ? *)` (2 AM daily) | `cleanup-scheduled` | Delete expired sessions from Neon |
| `aggregate-analytics` | `cron(0 3 * * ? *)` (3 AM daily) | `analytics-scheduled` | Roll up daily analytics |
| `send-digest-emails` | `cron(0 8 * * 1 *)` (8 AM Mon) | `email-worker` | Weekly digest emails |
| `check-course-deadlines` | `cron(0 * * * ? *)` (hourly) | `deadline-checker` | Check approaching deadlines |

**EventBridge Rule Configuration**:
```typescript
// CDK: EventBridge rule
const cleanupRule = new events.Rule(this, 'CleanupSchedule', {
  schedule: events.Schedule.cron({ hour: '2', minute: '0' }),
  targets: [
    new targets.LambdaFunction(cleanupLambda, {
      event: events.RuleTargetInput.fromObject({
        source: 'eventbridge',
        taskName: 'cleanup-expired-sessions',
      }),
    }),
  ],
});
```

**Lambda Handler**:
```typescript
// Lambda: cleanup-scheduled
export async function handler(event: EventBridgeEvent) {
  console.log('Starting cleanup', { taskName: event.taskName });
  
  // Delete expired sessions
  const deleted = await db
    .delete(sessionTable)
    .where(lt(sessionTable.expiresAt, new Date()))
    .returning({ id: sessionTable.id });
  
  console.log('Cleanup complete', { 
    deletedSessions: deleted.length,
  });
  
  // Emit custom metric
  await cloudwatch.putMetricData({
    Namespace: 'ClassroomIO',
    MetricData: [{
      MetricName: 'ExpiredSessionsDeleted',
      Value: deleted.length,
      Unit: 'Count',
      Timestamp: new Date(),
    }],
  });
  
  return { success: true, deleted: deleted.length };
}
```

**Migration from BullMQ Cron Jobs**:
```typescript
// BEFORE (BullMQ)
queue.add('cleanup', {}, {
  repeat: { cron: '0 2 * * *' },
});

// AFTER (EventBridge)
// Defined in CDK stack, no runtime code needed
// EventBridge → Lambda invocation happens automatically
```

**Cost**:
- **EventBridge**: Free for first 14M invocations/month
- **Lambda**: $0.20 per million invocations + duration
- **Example** (4 daily + 1 weekly + 24 hourly = ~800 invocations/month):
  - EventBridge: $0 (free tier)
  - Lambda: 800 * $0.0000002 + ~1 min compute = $0.002
  - **Total**: ~$0.002/month vs $5-10/month for EC2 cron server


### 7. S3 + CloudFront for Video Streaming

**Service Choice: CloudFront over Direct S3**

**Why CloudFront**:
- **Global edge caching**: Low latency worldwide
- **Signed URLs**: Secure access control
- **Cache hit ratio**: 90%+ for video segments (immutable .ts files)
- **Cost**: Data transfer from CloudFront cheaper than S3 (~30% savings)

**Why NOT Direct S3**:
- **Higher latency**: No edge caching
- **Higher cost**: S3 GET requests $0.0004 per 1K vs CloudFront $0 (included)
- **No signed URLs**: S3 presigned URLs less flexible (query string, expiration)

**Architecture**:

```
┌─────────────────────────────────────────────────────────────┐
│                       S3 Bucket                              │
│                   classroomio-media                          │
│                                                               │
│  /hls/{assetId}/                                             │
│    ├── master.m3u8           (playlist, mutable)            │
│    ├── 720p.m3u8             (variant playlist)             │
│    ├── 720p-000.ts           (video segment, immutable)     │
│    ├── 720p-001.ts                                          │
│    ├── ...                                                  │
│    ├── 1080p.m3u8                                           │
│    ├── 1080p-000.ts                                         │
│    └── ...                                                  │
│                                                               │
│  /assets/{orgId}/                                            │
│    ├── course-images/                                       │
│    ├── thumbnails/                                          │
│    └── attachments/                                         │
│                                                               │
│  Bucket Policy: Block all public access                     │
│  Only CloudFront OAC can read                                │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ Origin Access Control (OAC)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   CloudFront Distribution                     │
│                                                               │
│  Domain: cdn.classroomio.com                                 │
│  Certificate: ACM (*.classroomio.com)                        │
│  Origins:                                                     │
│    - S3 (OAC): classroomio-media.s3.us-east-1.amazonaws.com │
│                                                               │
│  Behaviors:                                                   │
│    /hls/*          → S3, signed URLs, cache segments         │
│    /assets/*       → S3, public cache                        │
│    /api/*          → API Gateway (pass-through, no cache)    │
│                                                               │
│  Cache Policies:                                              │
│    master.m3u8:    private, max-age=10                       │
│    *.m3u8:         private, max-age=300                      │
│    *.ts:           private, max-age=31536000, immutable      │
│    /assets/*:      public, max-age=86400                     │
│                                                               │
│  Geographic Restrictions: None                                │
│  HTTPS Only: Redirect HTTP → HTTPS                           │
└─────────────────────────────────────────────────────────────┘
```

**Signed URL Generation**:

ClassroomIO currently uses per-asset HMAC cookies (`cio_hls_{assetId}`). For AWS, we'll transition to **CloudFront Signed URLs**:

**Why Signed URLs over Cookies**:
- **Per-request security**: Each manifest/segment URL is independently signed
- **No cookie sync issues**: Works cross-domain without SameSite complexity
- **Simpler Lambda logic**: Generate URL once, no cookie management

**Implementation**:
```typescript
// Lambda: hls-cookie (renamed to hls-url-generator)
import { getSignedUrl } from '@aws-sdk/cloudfront-signer';

export async function handler(event: APIGatewayProxyEventV2) {
  const { courseSlug, itemSlug } = event.pathParameters;
  
  // 1. Verify student enrollment
  const enrollment = await verifyEnrollment(user.id, courseSlug);
  if (!enrollment) {
    return { statusCode: 403, body: 'Not enrolled' };
  }
  
  // 2. Get lesson asset
  const lesson = await getLesson(courseSlug, itemSlug);
  if (!lesson?.assetId) {
    return { statusCode: 404, body: 'Video not found' };
  }
  
  // 3. Generate signed URL for master.m3u8
  const assetId = lesson.assetId;
  const url = `https://cdn.classroomio.com/hls/${assetId}/master.m3u8`;
  
  const signedUrl = getSignedUrl({
    url,
    keyPairId: process.env.CLOUDFRONT_KEY_PAIR_ID!,
    privateKey: process.env.CLOUDFRONT_PRIVATE_KEY!,
    dateLessThan: new Date(Date.now() + 3600 * 1000), // 1 hour
  });
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      data: {
        masterPlaylistUrl: signedUrl,
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      },
    }),
  };
}
```

**Dashboard Integration**:
```typescript
// Dashboard: Video player component
async function loadVideo(courseSlug: string, itemSlug: string) {
  // Get signed URL from API
  const response = await fetch(
    `/api/course/${courseSlug}/item/${itemSlug}/video-url`
  );
  const { masterPlaylistUrl } = await response.json();
  
  // Load hls.js
  const hls = new Hls();
  hls.loadSource(masterPlaylistUrl);
  hls.attachMedia(videoElement);
}
```

**Variant Playlist & Segment URLs**:

When hls.js fetches `master.m3u8`, it contains **relative URLs** for variant playlists and segments:
```m3u8
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p.m3u8
```

hls.js resolves these relative URLs against the base URL of `master.m3u8`:
- Base: `https://cdn.classroomio.com/hls/{assetId}/master.m3u8?Expires=...&Signature=...`
- Resolved: `https://cdn.classroomio.com/hls/{assetId}/720p.m3u8?Expires=...&Signature=...`

**CloudFront Policy**: Must allow signed URLs to propagate to all sub-resources. Use **Trusted Key Groups** (recommended) or **Trusted Signers** (legacy).

**CDK Configuration**:
```typescript
// CloudFront Key Group (for signed URLs)
const publicKey = new cloudfront.PublicKey(this, 'HlsSigningKey', {
  encodedKey: fs.readFileSync('cloudfront-public-key.pem', 'utf8'),
});

const keyGroup = new cloudfront.KeyGroup(this, 'HlsKeyGroup', {
  items: [publicKey],
});

// CloudFront Distribution
const distribution = new cloudfront.Distribution(this, 'CdnDistribution', {
  defaultBehavior: {
    origin: new origins.S3Origin(mediaBucket, {
      originAccessIdentity: oac, // OAC for private S3 access
    }),
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // API pass-through
  },
  additionalBehaviors: {
    '/hls/*': {
      origin: new origins.S3Origin(mediaBucket, { originAccessIdentity: oac }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      trustedKeyGroups: [keyGroup], // Require signed URLs
      cachePolicy: new cloudfront.CachePolicy(this, 'HlsCachePolicy', {
        defaultTtl: Duration.seconds(300), // 5 min for playlists
        maxTtl: Duration.days(365), // 1 year for segments
        minTtl: Duration.seconds(0),
        headerBehavior: cloudfront.CacheHeaderBehavior.none(),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(), // Include signature params
      }),
    },
    '/assets/*': {
      origin: new origins.S3Origin(mediaBucket, { originAccessIdentity: oac }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED, // Public, long cache
    },
  },
  domainNames: ['cdn.classroomio.com'],
  certificate: certificate, // ACM cert for *.classroomio.com
});
```

**S3 Bucket Policy** (OAC access):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::classroomio-media/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

**Cache Behavior Details**:

| Content Type | Path | Cache TTL | Reasoning |
|--------------|------|-----------|-----------|
| Master playlist | `master.m3u8` | 10s | Mutable - can add 1080p rendition later |
| Variant playlist | `*.m3u8` | 5 min | Rarely changes after initial upload |
| Video segments | `*.ts` | 1 year, immutable | Never changes, identified by assetId + filename |
| Static assets | `/assets/*` | 1 day | Course images, can update occasionally |

**Cost Model**:
- **S3 storage**: $0.023 per GB-month (100 GB = $2.30/month)
- **S3 GET requests**: $0.0004 per 1K (mostly cached by CloudFront)
- **CloudFront data transfer**: $0.085 per GB (first 10 TB/month)
- **CloudFront requests**: $0.0075 per 10K (HTTPS)
- **Example** (10K users/day, 10 min video, 2 MB/min, 80% cache hit):
  - Storage: 1 TB videos = $23/month
  - Data transfer: 10K * 10 * 2 MB * 30 days * 0.2 (cache miss) = 1.2 TB = $102/month
  - **Total**: ~$125/month for video serving


## Data Models

### Database Schema Changes

**No schema changes required for Neon migration** - PostgreSQL schema remains unchanged. Better Auth session storage already uses Drizzle ORM with PostgreSQL.

**Existing tables** (from `packages/db/src/schema`):
- `user`: User accounts
- `organization`: Organizations/tenants
- `organization_member`: Org membership with roles
- `course`: Course metadata
- `lesson`: Lesson content
- `assignment`: Assignment definitions
- `submission`: Student submissions
- `session`: Better Auth sessions (replaces Redis)
- `asset`: Media assets (videos, images)
- `enrollment`: Student enrollments
- `progress`: Lesson completion tracking

**Indexes optimized for Lambda**:
```sql
-- Session validation (runs on every auth request)
CREATE INDEX idx_session_token ON session(token);
CREATE INDEX idx_session_expires_at ON session(expires_at);

-- Course queries
CREATE INDEX idx_course_organization_id ON course(organization_id);
CREATE INDEX idx_course_slug ON course(slug);

-- Enrollment checks
CREATE INDEX idx_enrollment_user_course ON enrollment(user_id, course_id);

-- Asset lookups
CREATE INDEX idx_asset_organization_id ON asset(organization_id);
CREATE INDEX idx_asset_id_org ON asset(id, organization_id);
```

### DynamoDB Schema

#### Table: `rate-limits`

**Primary Key**: 
- Partition Key: `composite_key` (STRING) - Format: `"user:{userId}"` or `"ip:{ipAddress}"`
- Sort Key: `window_start` (NUMBER) - Unix timestamp (rounded to window boundary)

**Attributes**:
```json
{
  "composite_key": "user:550e8400-e29b-41d4-a716-446655440000",
  "window_start": 1701432000,
  "count": 42,
  "ttl": 1701518400,
  "created_at": 1701432123
}
```

**TTL**: Enabled on `ttl` attribute (24h retention)

**Access Patterns**:
1. Increment counter: `UpdateItem` with `ADD count :inc`
2. Check limit: `ConditionExpression: count < :limit`

#### Table: `job-metadata`

**Primary Key**:
- Partition Key: `job_id` (STRING) - UUID

**Attributes**:
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "type": "transcode-video",
  "status": "completed",
  "payload": {
    "assetId": "asset-123",
    "sourceKey": "uploads/video.mp4"
  },
  "created_at": 1701432000,
  "updated_at": 1701432300,
  "completed_at": 1701432300,
  "retry_count": 0,
  "ttl": 1702036800
}
```

**GSI**: `status-index`
- Partition Key: `status` (STRING)
- Sort Key: `created_at` (NUMBER)
- Use case: Query recent jobs by status (`pending`, `running`, `failed`)

**TTL**: Enabled on `ttl` attribute (7-day retention)

#### Table: `migration-routes`

**Primary Key**:
- Partition Key: `path` (STRING) - Route pattern (e.g., `/course/*`)

**Attributes**:
```json
{
  "path": "/course/*",
  "target": "lambda",
  "canary": 0,
  "lambda_function": "arn:aws:lambda:us-east-1:123456789012:function:course-handler",
  "updated_at": "2024-12-01T00:00:00Z",
  "updated_by": "user-admin-123"
}
```

**Access Pattern**: Query by exact path match, then longest prefix match

### S3 Object Structure

**Bucket**: `classroomio-media`

**Key Patterns**:
```
/hls/{assetId}/
  ├── master.m3u8                    # Master playlist
  ├── 720p.m3u8                      # Variant playlist (720p)
  ├── 720p-000.ts                    # Segment 0 (720p)
  ├── 720p-001.ts
  ├── ...
  ├── 1080p.m3u8                     # Variant playlist (1080p)
  ├── 1080p-000.ts
  └── ...

/assets/{orgId}/
  ├── course-images/{courseId}.jpg   # Course thumbnails
  ├── thumbnails/{assetId}.jpg       # Video thumbnails
  └── attachments/{lessonId}/{filename}  # Downloadable files

/uploads/{orgId}/{uploadId}.mp4      # Temporary upload staging
```

**Lifecycle Policies**:
1. **Uploads**: Delete after 7 days (if not finalized)
2. **Old assets**: Transition to Glacier after 90 days of no access (optional cost optimization)

**Versioning**: Enabled for critical assets (e.g., master playlists) to support rollback


## Security Design

### 1. IAM Roles and Least Privilege

**Principle**: Each Lambda function has a dedicated IAM role with only the permissions required for its specific operations.

**Example: Course Handler Lambda Role**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:us-east-1:*:log-group:/aws/lambda/course-handler:*"
    },
    {
      "Sid": "DynamoDBRateLimits",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:UpdateItem"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:*:table/rate-limits"
    },
    {
      "Sid": "S3ReadAssets",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::classroomio-media/assets/*"
    }
  ]
}
```

**Media Worker Lambda Role** (additional permissions):
```json
{
  "Sid": "S3WriteHLS",
  "Effect": "Allow",
  "Action": [
    "s3:PutObject",
    "s3:PutObjectAcl"
  ],
  "Resource": "arn:aws:s3:::classroomio-media/hls/*"
},
{
  "Sid": "SQSConsumeJobs",
  "Effect": "Allow",
  "Action": [
    "sqs:ReceiveMessage",
    "sqs:DeleteMessage",
    "sqs:GetQueueAttributes"
  ],
  "Resource": "arn:aws:sqs:us-east-1:*:media-jobs"
}
```

### 2. S3 Bucket Security

**Bucket Policy**: Block all public access, allow only CloudFront OAC
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyPublicAccess",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::classroomio-media/*",
      "Condition": {
        "StringNotEquals": {
          "aws:PrincipalArn": "arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity E123ABC"
        }
      }
    },
    {
      "Sid": "AllowCloudFrontOAC",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::classroomio-media/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::ACCOUNT_ID:distribution/DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

**Bucket Settings**:
- Public access: Blocked (all four settings)
- Versioning: Enabled (for master.m3u8 rollback)
- Encryption: SSE-S3 (server-side encryption)
- CORS: Enabled for cross-origin video playback

### 3. CloudFront Security

**Signed URLs**:
- Algorithm: RSA-SHA1
- Key rotation: Every 90 days (automated via Lambda + Secrets Manager)
- Expiration: 1 hour for master.m3u8, propagates to segments
- Key storage: AWS Secrets Manager (Lambda retrieves at cold start)

**HTTPS Enforcement**:
```typescript
viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
```

**Origin Access Control (OAC)**: Replaces legacy OAI, better security
- CloudFront signs requests to S3 with SigV4
- S3 validates signature before serving

### 4. API Gateway Security

**Authentication**: JWT validation via Lambda authorizer (Better Auth tokens)
```typescript
// Lambda: auth-authorizer
export async function handler(event: APIGatewayRequestAuthorizerEvent) {
  const token = extractTokenFromHeader(event.headers);
  
  if (!token) {
    return generateDenyPolicy('user', event.methodArn);
  }
  
  // Validate session token against Neon
  const session = await validateSession(token);
  
  if (!session) {
    return generateDenyPolicy('user', event.methodArn);
  }
  
  // Return allow policy with user context
  return {
    principalId: session.userId,
    policyDocument: generateAllowPolicy(event.methodArn),
    context: {
      userId: session.userId,
      orgId: session.orgId,
      role: session.role,
    },
  };
}
```

**CORS Configuration**:
```typescript
cors: {
  allowOrigins: [
    'https://app.classroomio.com',
    'https://*.classroomio.com', // Custom domains
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Cookie', 'cio-org-id'],
  allowCredentials: true,
  maxAge: 86400,
}
```

**Request Validation**:
- Request size limit: 10 MB
- Request timeout: 29 seconds
- Throttling: Enforced via usage plans (burst: 5000, rate: 2000/s)

### 5. Database Security

**Neon PostgreSQL**:
- SSL/TLS required: `sslmode=require` in connection string
- Channel binding: Supported by Neon, prevents MITM attacks
- Connection pooler: Encrypted connections between Lambda and Neon
- Credentials storage: AWS Secrets Manager (rotated every 30 days)

**Connection String** (stored in Secrets Manager):
```typescript
// Lambda retrieves at cold start
const secret = await secretsManager.getSecretValue({
  SecretId: 'neon-database-url',
});
const DATABASE_URL = JSON.parse(secret.SecretString).url;
```

**Database User**: Separate user per environment (dev, staging, prod) with limited permissions
```sql
-- Production Lambda user (read-only for most tables)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO lambda_prod_user;
GRANT INSERT, UPDATE ON session, enrollment, progress TO lambda_prod_user;
```

### 6. Lambda Environment Variables

**Encryption**: All sensitive env vars encrypted with AWS KMS
```typescript
// CDK configuration
const lambda = new lambda.Function(this, 'CourseHandler', {
  environment: {
    DATABASE_URL: secret.secretValueFromJson('url').toString(),
    PRIVATE_SERVER_KEY: secret.secretValueFromJson('key').toString(),
    CLOUDFRONT_KEY_PAIR_ID: keyPairIdParam.valueAsString,
  },
  environmentEncryption: kmsKey, // KMS key for at-rest encryption
});
```

**KMS Key Policy**: Lambda execution role can decrypt
```json
{
  "Sid": "AllowLambdaDecrypt",
  "Effect": "Allow",
  "Principal": {
    "AWS": "arn:aws:iam::ACCOUNT_ID:role/course-handler-role"
  },
  "Action": "kms:Decrypt",
  "Resource": "*"
}
```

### 7. Input Validation and Sanitization

**SQL Injection Prevention**:
- Use Drizzle ORM parameterized queries (never string concatenation)
- Validate all user inputs with Zod schemas (already in place)

**Example**:
```typescript
import { z } from 'zod';

const CourseQuerySchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
});

async function getCourse(id: string, orgId: string) {
  // Zod validates input
  const validated = CourseQuerySchema.parse({ id, orgId });
  
  // Drizzle uses parameterized query (safe from SQL injection)
  const course = await db
    .select()
    .from(coursesTable)
    .where(
      and(
        eq(coursesTable.id, validated.id),
        eq(coursesTable.organizationId, validated.orgId)
      )
    )
    .limit(1);
  
  return course[0];
}
```

**XSS Prevention**:
- API returns JSON only (no HTML rendering in Lambda)
- Dashboard sanitizes user-generated content before rendering
- CSP headers in dashboard (already implemented)

### 8. Secrets Management

**AWS Secrets Manager**:
- Database credentials: `neon-database-url`
- CloudFront private key: `cloudfront-signing-key`
- Better Auth server key: `better-auth-server-key`
- Rotation: Automated every 30 days via Lambda

**Access**: Lambda roles granted `secretsmanager:GetSecretValue` only
```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:*:secret:neon-database-url-*"
}
```

### 9. Network Security

**VPC Decision**: **Lambda functions run OUTSIDE VPC**

**Rationale**:
- **Neon is public**: Accepts connections from internet (TLS encrypted)
- **No private resources**: S3, DynamoDB, SQS are public AWS services
- **NAT Gateway cost**: $32/month + data transfer ($0.045/GB)
- **Simpler**: No VPC config, no ENI cold start penalty

**If VPC required later** (e.g., connecting to private RDS):
- Use VPC endpoints for S3, DynamoDB, SQS (no NAT Gateway needed)
- NAT Gateway only if Lambda needs public internet for external APIs

**Traffic Flow**:
```
Internet → CloudFront → API Gateway → Lambda (no VPC)
                                        ↓
Lambda → Neon (TLS)
Lambda → S3 (HTTPS)
Lambda → DynamoDB (HTTPS)
Lambda → SQS (HTTPS)
```

### 10. Logging and Audit

**CloudWatch Logs**:
- All Lambda invocations logged
- Retention: 30 days (compliance requirement)
- Log groups encrypted with KMS
- Access restricted via IAM

**Structured Logging**:
```typescript
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'course-handler' });

logger.info('Course accessed', {
  userId: user.id,
  courseId: course.id,
  orgId: org.id,
  action: 'view',
});
```

**Audit Trail**: Key actions logged to separate audit log group
- User login/logout
- Course enrollment
- Assignment submission
- Admin actions (delete course, change permissions)

### 11. DDoS Protection

**CloudFront**: Built-in DDoS protection (AWS Shield Standard)
- Layer 3/4 protection: SYN floods, UDP reflection
- Layer 7 protection: HTTP floods (automatic rate limiting)

**API Gateway**:
- Throttling: 5000 burst, 2000 sustained req/s
- Usage plans: Per-API-key rate limits

**Lambda**:
- Reserved concurrency: Prevents runaway invocations
- Example: Media worker limited to 10 concurrent (max $X/hour spend)


## Cost Modeling

### Service-by-Service Breakdown

#### 1. Lambda

**Pricing**:
- Requests: $0.20 per 1M invocations
- Duration (ARM64): $0.0000133334 per GB-second
- Free tier: 1M requests + 400,000 GB-seconds/month

**Scenarios**:

| Scenario | Requests/Day | Avg Duration | Memory | Requests/Month | GB-Seconds/Month | Cost |
|----------|-------------|-------------|---------|----------------|-----------------|------|
| **Idle** | 100 (health checks) | 100ms | 512 MB | 3,000 | 150 | $0 (free tier) |
| **Low** (1K users/day) | 10,000 | 200ms | 512 MB | 300,000 | 30,000 | $0 (free tier) |
| **Moderate** (10K users/day) | 100,000 | 200ms | 512 MB | 3,000,000 | 300,000 | $4.60 |

**Calculation** (moderate):
- Requests: 3M * $0.20 / 1M = $0.60
- Duration: 300K GB-s * $0.0000133334 = $4.00
- **Total**: $4.60/month

**Background Workers** (separate):
- Media transcode: 100 jobs/day * 30s avg * 2 GB = 180K GB-s = $2.40/month
- Email send: 1000 emails/day * 5s avg * 512 MB = 75K GB-s = $1.00/month

#### 2. API Gateway

**Pricing**: $1.00 per 1M requests (HTTP API)

**Scenarios**:

| Scenario | Requests/Month | Cost |
|----------|----------------|------|
| **Idle** | 3,000 | $0.003 |
| **Low** | 300,000 | $0.30 |
| **Moderate** | 3,000,000 | $3.00 |

#### 3. Neon PostgreSQL

**Pricing**:
- Free tier: 0.5 GB storage, 3 GB data transfer
- Scale plan: $19/month (10 GB storage, 100 GB transfer, included compute)
- Compute: $0.16 per compute hour (only when active)

**Scenarios**:

| Scenario | Active Compute Hours | Storage | Data Transfer | Cost |
|----------|---------------------|---------|---------------|------|
| **Idle** | 0 (paused) | 0.3 GB | 0.1 GB | $0 (free tier) |
| **Low** | 10 hours | 1 GB | 5 GB | $1.60 compute + $0 storage (free tier) = $1.60 |
| **Moderate** | 100 hours | 3 GB | 20 GB | $16 compute + $0 storage (free tier) = $16 |

**Note**: Scale plan at $19/month may be cheaper than pay-per-hour if usage exceeds ~120 hours/month

#### 4. DynamoDB

**Pricing** (On-Demand):
- Writes: $1.25 per 1M write units
- Reads: $0.25 per 1M read units
- Storage: $0.25 per GB-month

**Scenarios**:

| Scenario | Rate Limit Checks/Month | Job Metadata Writes/Month | Storage | Cost |
|----------|------------------------|--------------------------|---------|------|
| **Idle** | 10K | 100 | 0.01 GB | $0.01 |
| **Low** | 100K | 1K | 0.1 GB | $0.13 |
| **Moderate** | 1M | 10K | 0.5 GB | $0.40 |

**Calculation** (moderate):
- Rate limit reads: 1M * $0.25 / 1M = $0.25
- Rate limit writes: 1M * $1.25 / 1M = $1.25 (but updates are amortized, assume 0.1x)
- Job writes: 10K * $1.25 / 1M = $0.01
- Storage: 0.5 GB * $0.25 = $0.13
- **Total**: $0.40/month

#### 5. S3

**Pricing**:
- Storage: $0.023 per GB-month
- GET requests: $0.0004 per 1K
- PUT requests: $0.005 per 1K
- Data transfer out (to CloudFront): $0 (free)

**Scenarios**:

| Scenario | Storage | GET Requests/Month | PUT Requests/Month | Cost |
|----------|---------|-------------------|-------------------|------|
| **Idle** | 10 GB | 1K | 100 | $0.23 storage + $0 requests = $0.23 |
| **Low** | 50 GB | 50K | 1K | $1.15 storage + $0.02 + $0.005 = $1.18 |
| **Moderate** | 200 GB | 500K | 10K | $4.60 storage + $0.20 + $0.05 = $4.85 |

**Note**: Assumes 80-90% cache hit rate at CloudFront (S3 GET requests are low)

#### 6. CloudFront

**Pricing**:
- Data transfer out: $0.085 per GB (first 10 TB/month to internet)
- HTTPS requests: $0.0100 per 10K requests
- Invalidations: $0 for first 1000/month

**Scenarios**:

| Scenario | Data Transfer/Month | Requests/Month | Cost |
|----------|-------------------|----------------|------|
| **Idle** | 1 GB | 10K | $0.09 + $0.01 = $0.10 |
| **Low** | 50 GB | 500K | $4.25 + $0.50 = $4.75 |
| **Moderate** | 500 GB | 5M | $42.50 + $5.00 = $47.50 |

**Note**: Video streaming dominates data transfer (HLS segments)

#### 7. SQS

**Pricing**: $0.40 per 1M requests (first 1M free)

**Scenarios**:

| Scenario | Messages/Month | Cost |
|----------|----------------|------|
| **Idle** | 100 | $0 (free tier) |
| **Low** | 10K | $0 (free tier) |
| **Moderate** | 100K | $0.04 |

#### 8. EventBridge

**Pricing**: $1.00 per 1M invocations (first 14M free)

**Scenarios**:

| Scenario | Invocations/Month | Cost |
|----------|------------------|------|
| All | 800 (4 daily + 24 hourly + 4 weekly) | $0 (free tier) |

#### 9. CloudWatch

**Pricing**:
- Logs ingestion: $0.50 per GB
- Logs storage: $0.03 per GB-month
- Metrics: $0.30 per custom metric/month
- Dashboards: $3 per dashboard/month

**Scenarios**:

| Scenario | Logs Ingested/Month | Custom Metrics | Dashboards | Cost |
|----------|-------------------|----------------|------------|------|
| **Idle** | 0.1 GB | 5 | 1 | $0.05 + $1.50 + $3 = $4.55 |
| **Low** | 1 GB | 10 | 1 | $0.50 + $3.00 + $3 = $6.50 |
| **Moderate** | 5 GB | 20 | 2 | $2.50 + $6.00 + $6 = $14.50 |

### Total Cost by Scenario

| Service | Idle | Low (1K users/day) | Moderate (10K users/day) |
|---------|------|-------------------|-------------------------|
| Lambda | $0 | $0 | $4.60 |
| Lambda Workers | $0 | $1.00 | $3.40 |
| API Gateway | $0.003 | $0.30 | $3.00 |
| Neon PostgreSQL | $0 | $1.60 | $16.00 |
| DynamoDB | $0.01 | $0.13 | $0.40 |
| S3 | $0.23 | $1.18 | $4.85 |
| CloudFront | $0.10 | $4.75 | $47.50 |
| SQS | $0 | $0 | $0.04 |
| EventBridge | $0 | $0 | $0 |
| CloudWatch | $4.55 | $6.50 | $14.50 |
| **TOTAL** | **$4.89** | **$15.46** | **$94.29** |

### Achieving <$5/month Idle Target

**Baseline**: $4.89/month idle

**Optimization**: Reduce CloudWatch costs
- Single dashboard instead of 2: -$3/month
- Reduce custom metrics: 3 instead of 5: -$0.60/month
- **Optimized Idle**: $4.89 - $3.60 = **$1.29/month** ✅

### Cost Comparison: Current vs Serverless

**Current Infrastructure** (estimated):
- Render API server (Starter): $25/month
- Redis (Upstash 256MB): $10/month
- PostgreSQL (Render): $7/month
- MinIO/Object storage: $5/month
- **Total**: ~$47/month idle

**Serverless (Low Traffic)**:
- Total: $15.46/month
- **Savings**: $31.54/month (67% reduction)

**Serverless (Moderate Traffic)**:
- Total: $94.29/month
- Current equivalent (scaled): ~$200+/month (need larger instances)
- **Savings**: $105.71/month (53% reduction)

### Cost Monitoring

**CloudWatch Budget Alarms**:
```typescript
// CDK: Budget alarm
const budget = new budgets.CfnBudget(this, 'MonthlyBudget', {
  budget: {
    budgetType: 'COST',
    timeUnit: 'MONTHLY',
    budgetLimit: {
      amount: 20, // $20/month alert
      unit: 'USD',
    },
  },
  notificationsWithSubscribers: [{
    notification: {
      notificationType: 'ACTUAL',
      comparisonOperator: 'GREATER_THAN',
      threshold: 80, // Alert at 80% of budget
    },
    subscribers: [{
      subscriptionType: 'EMAIL',
      address: 'ops@classroomio.com',
    }],
  }],
});
```

**Cost Allocation Tags**:
- `Project`: `classroomio`
- `Environment`: `production`
- `Component`: `api`, `media`, `dashboard`
- Enables cost breakdown by component in Cost Explorer


## Performance Design

### Latency Targets and Strategies

#### 1. API Response Time

**Target**: p95 < 1 second (web requests)

**Breakdown**:
- API Gateway: ~5ms
- Lambda cold start: ~500-1500ms (first request)
- Lambda warm: ~50-100ms
- Database query: ~20-50ms
- Total (cold): ~600-1700ms
- Total (warm): ~100-200ms

**Optimization Strategies**:

**a) Connection Pooling**:
```typescript
// Reuse database connection across invocations
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1, // One connection per Lambda container
  idleTimeoutMillis: 0, // Never close (reuse)
});

// Container reused for ~15 min after last invocation
// Subsequent requests skip connection establishment (~300ms saved)
```

**b) Lazy Loading**:
```typescript
// Load heavy dependencies only when needed
let ffmpeg: typeof import('fluent-ffmpeg') | null = null;

async function getFFmpeg() {
  if (!ffmpeg) {
    ffmpeg = await import('fluent-ffmpeg');
  }
  return ffmpeg;
}
```

**c) Bundle Size Reduction**:
- Tree-shake unused code (ESBuild with `NODE_ENV=production`)
- Exclude dev dependencies
- Target: <5 MB zipped, <20 MB unzipped
- Faster cold start: 5 MB vs 50 MB = ~500ms difference

**d) Provisioned Concurrency** (optional, cost-adds ~$5.50/month per instance):
```typescript
// Enable for high-traffic routes if cold start p95 > 2s
const courseHandler = new lambda.Function(this, 'CourseHandler', {
  // ... config
  currentVersionOptions: {
    provisionedConcurrentExecutions: 1, // Keep 1 warm instance
  },
});
```

**Decision**: Defer provisioned concurrency until traffic validates necessity

#### 2. Database Query Performance

**Target**: p95 < 50ms

**Strategies**:

**a) Index Optimization**:
```sql
-- Session validation (every auth request)
CREATE INDEX idx_session_token ON session(token);
EXPLAIN ANALYZE SELECT * FROM session WHERE token = $1 AND expires_at > NOW();
-- Index Scan on session using idx_session_token (cost=0.29..8.31 rows=1)
-- Planning Time: 0.5ms, Execution Time: 1.2ms ✅

-- Course listing (common query)
CREATE INDEX idx_course_org_created ON course(organization_id, created_at DESC);
EXPLAIN ANALYZE 
  SELECT * FROM course 
  WHERE organization_id = $1 
  ORDER BY created_at DESC 
  LIMIT 20;
-- Index Scan using idx_course_org_created (cost=0.29..12.50 rows=20)
-- Planning Time: 0.3ms, Execution Time: 2.5ms ✅
```

**b) Query Optimization**:
```typescript
// BAD: N+1 query problem
const courses = await db.select().from(coursesTable);
for (const course of courses) {
  course.lessons = await db
    .select()
    .from(lessonsTable)
    .where(eq(lessonsTable.courseId, course.id));
}
// 1 + N queries = slow

// GOOD: Join or batch query
const coursesWithLessons = await db
  .select()
  .from(coursesTable)
  .leftJoin(lessonsTable, eq(coursesTable.id, lessonsTable.courseId))
  .where(eq(coursesTable.organizationId, orgId));
// 1 query = fast
```

**c) Neon Pooler**: Automatically handles connection pooling, reduces overhead

**d) Read Replicas** (future optimization if needed):
- Neon supports read replicas
- Route read-only queries to replica (reduce primary load)

#### 3. Video Streaming Performance

**Target**: Time-to-first-frame < 3 seconds (p95)

**Breakdown**:
- Generate signed URL: ~200ms (Lambda + Neon query)
- DNS resolution: ~50ms
- TLS handshake: ~100ms
- Request master.m3u8: ~50ms (cached) or ~200ms (origin)
- Parse manifest: ~50ms (client-side)
- Request first .ts segment: ~50ms (cached) or ~500ms (origin)
- Decode first frame: ~100ms
- **Total (cached)**: ~600ms ✅
- **Total (origin)**: ~1200ms ✅

**Optimization Strategies**:

**a) CloudFront Cache TTLs**:
- `master.m3u8`: 10s (mutable, allow updates)
- Variant playlists: 5 min (rarely change)
- Video segments: 1 year, immutable (never change)
- Cache hit ratio target: >90%

**b) Prefetch master.m3u8**:
```typescript
// Dashboard: Prefetch signed URL on page load
async function prefetchVideoUrl(courseSlug: string, itemSlug: string) {
  const { masterPlaylistUrl } = await fetch(
    `/api/course/${courseSlug}/item/${itemSlug}/video-url`
  ).then(r => r.json());
  
  // Prefetch master playlist (browser cache)
  fetch(masterPlaylistUrl, { credentials: 'include' });
}
```

**c) Adaptive Bitrate**: hls.js automatically selects optimal quality
- Start with lowest bitrate (fast first frame)
- Upgrade to higher quality as buffer builds

**d) Regional Edge Locations**: CloudFront serves from 400+ edge locations worldwide
- US/Europe: ~20-50ms latency
- Asia/LATAM: ~100-150ms latency

#### 4. Lambda Memory Configuration

**Trade-off**: Higher memory = more CPU = faster execution = higher cost

**Benchmarking**:
```bash
# Test different memory sizes
aws lambda invoke \
  --function-name course-handler \
  --payload '{"path": "/course/123"}' \
  --cli-binary-format raw-in-base64-out \
  out.json
  
# Results (sample):
# 256 MB: 350ms execution, $0.0000058 cost
# 512 MB: 200ms execution, $0.0000066 cost  ← Optimal
# 1024 MB: 150ms execution, $0.0000100 cost
# 2048 MB: 140ms execution, $0.0000186 cost
```

**Recommendation**: 512 MB for API handlers (best price/performance)
- Sufficient for typical queries + JSON serialization
- 2048 MB for media workers (ffmpeg needs memory)

#### 5. API Gateway Throttling

**Configuration**:
```typescript
const api = new apigateway.HttpApi(this, 'API', {
  defaultThrottle: {
    burstLimit: 5000,  // Max concurrent requests
    rateLimit: 2000,   // Sustained requests/second
  },
});
```

**Usage Plans** (per-user limits):
```typescript
const plan = api.addUsagePlan('StandardPlan', {
  throttle: {
    burstLimit: 100,
    rateLimit: 50,
  },
  quota: {
    limit: 100000,
    period: apigateway.Period.MONTH,
  },
});
```

**Prevents**:
- Single user monopolizing capacity
- Runaway API loops causing cost spike
- DDoS amplification

#### 6. DynamoDB Performance

**Target**: Read < 10ms (p95), Write < 50ms (p95)

**Configuration**:
- Billing mode: On-demand (auto-scales)
- Consistency: Eventual (faster + cheaper for rate limits)
- TTL: Automatic cleanup (no scan cost)

**Access Pattern Optimization**:
```typescript
// GOOD: Direct partition key access
await dynamodb.getItem({
  TableName: 'rate-limits',
  Key: { composite_key: `user:${userId}`, window_start: timestamp },
});
// Single-digit millisecond latency ✅

// BAD: Scan (slow, expensive)
await dynamodb.scan({
  TableName: 'rate-limits',
  FilterExpression: 'user_id = :userId',
});
// Reads entire table, seconds of latency ❌
```


#### 7. Dashboard Analytics Cold Start Mitigation

**Challenge**: Instructor dashboard with aggregated analytics queries may exceed 1s p95 target on first load after Neon pauses in low-traffic scenarios.

**Problem Breakdown**:
- Neon cold start (wake from pause): ~300-500ms
- Complex analytics query (enrollments, completions, submissions): ~400-800ms
- **Total first load**: ~700-1300ms (acceptable)
- **Worst case** (complex query + cold DB): ~1500-2000ms (exceeds target)

**Mitigation Strategies**:

**Option 1: Cache Analytics Results in DynamoDB** (Recommended for Phase 1)
```typescript
// EventBridge rule runs every 5 minutes
async function precomputeInstructorAnalytics() {
  const courses = await db.select().from(coursesTable);
  
  for (const course of courses) {
    const analytics = {
      enrollments: await countEnrollments(course.id),
      completions: await countCompletions(course.id),
      submissions: await countSubmissions(course.id),
      lastUpdated: Date.now(),
    };
    
    await dynamodb.putItem({
      TableName: 'cached-analytics',
      Item: {
        course_id: course.id,
        analytics: JSON.stringify(analytics),
        ttl: Date.now() + 3600, // 1 hour TTL
      },
    });
  }
}

// Dashboard Lambda reads from cache first
async function getInstructorDashboard(courseId: string) {
  const cached = await dynamodb.getItem({
    TableName: 'cached-analytics',
    Key: { course_id: courseId },
  });
  
  if (cached && Date.now() - cached.lastUpdated < 300000) {
    // Cache hit, <5 min old: return immediately
    return JSON.parse(cached.analytics);
  }
  
  // Cache miss or stale: fetch fresh data
  const fresh = await computeAnalytics(courseId);
  
  // Update cache asynchronously (don't block response)
  updateCache(courseId, fresh).catch(console.error);
  
  return fresh;
}
```

**Cost**: ~$0.50/month (DynamoDB writes + Lambda invocations)
**Benefit**: Dashboard loads in <200ms even when Neon is cold

**Option 2: Warm Queries with EventBridge Ping**
```typescript
// EventBridge rule runs every 4 minutes (keeps Neon awake)
async function warmDatabaseConnection() {
  await db.query('SELECT 1'); // Minimal query
}
```

**Cost**: ~$2/month (720 Lambda invocations/day × 30 days)
**Benefit**: Neon never pauses, all queries fast
**Tradeoff**: Defeats scale-to-zero benefit

**Option 3: Graceful Degradation**
```typescript
// Dashboard shows cached/stale data on first load
async function getInstructorDashboard(courseId: string) {
  const cached = await getCachedAnalytics(courseId);
  
  // Return cached data immediately (even if stale)
  const response = {
    analytics: cached || { enrollments: 0, completions: 0, submissions: 0 },
    isStale: cached && Date.now() - cached.lastUpdated > 300000,
  };
  
  // Fetch fresh data in background if stale
  if (!cached || response.isStale) {
    fetchFreshAnalytics(courseId).then(updateCache);
  }
  
  return response;
}
```

**Cost**: $0 (no additional infrastructure)
**Benefit**: Fast first load, fresh data arrives within seconds
**UX**: Show "Updating..." badge while fetching fresh data

**Option 4: Accept Higher p95 for Dashboard**
- Document that instructor dashboard first load after idle may be 1.5-2s
- Subsequent loads within 15 minutes: <500ms (Lambda + DB warm)
- Student-facing routes (courses, lessons, video) maintain <1s target

**Recommendation for Phase 1**:
Start with **Option 3 (Graceful Degradation)** for zero additional cost:
- Simple to implement
- Good UX (data appears immediately, updates in background)
- No infrastructure overhead

Add **Option 1 (DynamoDB Cache)** if analytics queries consistently exceed 1.5s or instructors report slow dashboards.

Avoid **Option 2 (Warm Queries)** as it defeats the cost-saving goal of scale-to-zero.

### Performance Monitoring

**CloudWatch Metrics**:
```typescript
// Custom metrics for business events
await cloudwatch.putMetricData({
  Namespace: 'ClassroomIO',
  MetricData: [
    {
      MetricName: 'CourseAccess',
      Value: 1,
      Unit: 'Count',
      Dimensions: [
        { Name: 'CourseId', Value: courseId },
        { Name: 'OrgId', Value: orgId },
      ],
    },
    {
      MetricName: 'APILatency',
      Value: duration,
      Unit: 'Milliseconds',
      StatisticValues: {
        SampleCount: 1,
        Sum: duration,
        Minimum: duration,
        Maximum: duration,
      },
    },
  ],
});
```

**CloudWatch Insights Queries**:
```sql
-- p95 latency by route
fields @timestamp, @message, @duration
| filter @type = "REPORT"
| stats percentile(@duration, 95) as p95 by @logStream
| sort p95 desc

-- Cold start rate
fields @timestamp, @message
| filter @message like /Init Duration/
| stats count() as cold_starts by bin(5m)

-- Error rate
fields @timestamp, @level, @message
| filter @level = "ERROR"
| stats count() as errors by bin(5m)
```

**Alarms**:
```typescript
// p95 latency alarm
const latencyAlarm = new cloudwatch.Alarm(this, 'HighLatency', {
  metric: lambda.metricDuration({ statistic: 'p95' }),
  threshold: 1000, // 1 second
  evaluationPeriods: 2,
  datapointsToAlarm: 2,
  alarmDescription: 'p95 latency exceeded 1 second',
});

// Error rate alarm
const errorAlarm = new cloudwatch.Alarm(this, 'HighErrorRate', {
  metric: lambda.metricErrors({ statistic: 'sum', period: Duration.minutes(5) }),
  threshold: 10,
  evaluationPeriods: 1,
  alarmDescription: 'More than 10 errors in 5 minutes',
});
```


## Error Handling

### 1. Lambda Error Classification

**Retryable Errors** (transient failures):
- Network timeouts
- Database connection errors (Neon waking from pause)
- Throttling (DynamoDB, S3)
- 5xx errors from downstream services

**Non-Retryable Errors** (client errors):
- Invalid input (400 Bad Request)
- Authentication failure (401 Unauthorized)
- Authorization failure (403 Forbidden)
- Resource not found (404 Not Found)
- Business logic errors (e.g., already enrolled)

### 2. Retry Strategy

**Lambda-level Retries**:
```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options = { maxRetries: 3, baseDelay: 100 }
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      // Don't retry client errors
      if (error instanceof ClientError) {
        throw error;
      }
      
      // Exponential backoff
      if (attempt < options.maxRetries) {
        const delay = options.baseDelay * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError!;
}

// Usage
const course = await withRetry(() => 
  db.select().from(coursesTable).where(eq(coursesTable.id, id)).limit(1)
);
```

**SQS-level Retries** (background jobs):
- Visibility timeout: 900s (job has 15 min to complete)
- Max retries: 3
- Dead Letter Queue: After 3 failed attempts
- Exponential backoff: Built into SQS (delay doubles per retry)

**API Gateway-level Retries**: None (client responsible for retry)

### 3. Error Response Format

**Standard Error Response**:
```typescript
interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId: string;
}

// Example
{
  "success": false,
  "error": {
    "code": "COURSE_NOT_FOUND",
    "message": "Course with ID 'course-123' not found",
    "details": { "courseId": "course-123" }
  },
  "requestId": "1234-5678-abcd"
}
```

**HTTP Status Code Mapping**:
```typescript
const ERROR_STATUS_CODES: Record<string, number> = {
  INVALID_INPUT: 400,
  AUTHENTICATION_REQUIRED: 401,
  INSUFFICIENT_PERMISSIONS: 403,
  COURSE_NOT_FOUND: 404,
  LESSON_NOT_FOUND: 404,
  ALREADY_ENROLLED: 409,
  RATE_LIMIT_EXCEEDED: 429,
  DATABASE_ERROR: 500,
  EXTERNAL_SERVICE_ERROR: 502,
  DATABASE_TIMEOUT: 504,
};

function handleError(error: Error): APIGatewayProxyResult {
  const code = getErrorCode(error);
  const statusCode = ERROR_STATUS_CODES[code] || 500;
  
  console.error('Request failed', {
    errorCode: code,
    errorMessage: error.message,
    stack: error.stack,
  });
  
  return {
    statusCode,
    body: JSON.stringify({
      success: false,
      error: {
        code,
        message: error.message,
      },
      requestId: context.requestId,
    }),
  };
}
```

### 4. Circuit Breaker Pattern

**For external services** (protect against cascading failures):
```typescript
class CircuitBreaker {
  private failureCount = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  
  constructor(
    private threshold: number = 5,
    private timeout: number = 60000 // 1 min
  ) {}
  
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker open');
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess() {
    this.failureCount = 0;
    this.state = 'closed';
  }
  
  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.failureCount >= this.threshold) {
      this.state = 'open';
    }
  }
}

// Usage
const neonBreaker = new CircuitBreaker(5, 60000);

async function queryCourse(id: string) {
  return neonBreaker.execute(() => 
    db.select().from(coursesTable).where(eq(coursesTable.id, id))
  );
}
```

### 5. Timeout Handling

**Lambda Timeouts**:
- API handlers: 10-15s (well below API Gateway 29s timeout)
- Background workers: 900s (15 min for long transcodes)

**Database Query Timeouts**:
```typescript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000, // 10s
  query_timeout: 5000, // 5s max per query
});
```

**API Gateway Timeout Handling**:
```typescript
// Lambda must respond before API Gateway 29s timeout
export async function handler(event: APIGatewayProxyEventV2) {
  const timeoutId = setTimeout(() => {
    throw new Error('Lambda timeout approaching');
  }, 25000); // 25s safety margin
  
  try {
    const result = await processRequest(event);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.message === 'Lambda timeout approaching') {
      return {
        statusCode: 504,
        body: JSON.stringify({
          success: false,
          error: {
            code: 'REQUEST_TIMEOUT',
            message: 'Request processing timed out',
          },
        }),
      };
    }
    
    throw error;
  }
}
```

### 6. Dead Letter Queues

**SQS DLQ Configuration**:
```typescript
// Media jobs DLQ
const mediaJobsDlq = new sqs.Queue(this, 'MediaJobsDLQ', {
  queueName: 'media-jobs-dlq',
  retentionPeriod: Duration.days(14), // 14-day retention
});

const mediaJobsQueue = new sqs.Queue(this, 'MediaJobsQueue', {
  queueName: 'media-jobs',
  deadLetterQueue: {
    queue: mediaJobsDlq,
    maxReceiveCount: 3, // Move to DLQ after 3 failures
  },
});
```

**DLQ Monitoring**:
```typescript
// CloudWatch alarm for DLQ messages
const dlqAlarm = new cloudwatch.Alarm(this, 'MediaDLQAlarm', {
  metric: mediaJobsDlq.metricApproximateNumberOfMessagesVisible(),
  threshold: 1,
  evaluationPeriods: 1,
  alarmDescription: 'Messages in media jobs DLQ',
});

// SNS notification
dlqAlarm.addAlarmAction(new actions.SnsAction(opsTopic));
```

**DLQ Processing** (manual investigation):
```typescript
// Lambda: dlq-processor (triggered manually or scheduled)
export async function handler() {
  const messages = await sqs.receiveMessage({
    QueueUrl: process.env.DLQ_URL,
    MaxNumberOfMessages: 10,
  });
  
  for (const message of messages.Messages || []) {
    const job: JobMessage = JSON.parse(message.Body);
    
    // Log for manual investigation
    console.error('DLQ message', {
      jobId: job.jobId,
      type: job.type,
      payload: job.payload,
      attemptCount: job.attemptCount,
    });
    
    // Store in DynamoDB for dashboard view
    await dynamodb.putItem({
      TableName: 'failed-jobs',
      Item: {
        job_id: job.jobId,
        type: job.type,
        payload: job.payload,
        failed_at: Date.now(),
        error_message: message.Attributes?.ApproximateReceiveCount,
      },
    });
    
    // Delete from DLQ after logging
    await sqs.deleteMessage({
      QueueUrl: process.env.DLQ_URL,
      ReceiptHandle: message.ReceiptHandle,
    });
  }
}
```

### 7. Error Logging and Alerting

**Structured Logging**:
```typescript
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ serviceName: 'course-handler' });

try {
  await enrollInCourse(userId, courseId);
} catch (error) {
  logger.error('Enrollment failed', {
    userId,
    courseId,
    errorCode: getErrorCode(error),
    errorMessage: error.message,
    stack: error.stack,
  });
  
  throw error;
}
```

**CloudWatch Log Insights Query** (find errors):
```sql
fields @timestamp, @message, errorCode, errorMessage
| filter @level = "ERROR"
| stats count() as errorCount by errorCode
| sort errorCount desc
```

**Error Rate Alarm**:
```typescript
const errorAlarm = new cloudwatch.Alarm(this, 'HighErrorRate', {
  metric: new cloudwatch.Metric({
    namespace: 'AWS/Lambda',
    metricName: 'Errors',
    dimensionsMap: { FunctionName: courseHandler.functionName },
    statistic: 'Sum',
    period: Duration.minutes(5),
  }),
  threshold: 10,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
  alarmDescription: 'More than 10 errors in 5 minutes',
});

errorAlarm.addAlarmAction(new actions.SnsAction(opsTopic));
```

### 8. Graceful Degradation

**Feature Flags** (disable non-critical features during incidents):
```typescript
// Check feature flag before expensive operation
const enableRecommendations = await getFeatureFlag('recommendations');

if (enableRecommendations) {
  try {
    course.recommendations = await getRecommendations(courseId);
  } catch (error) {
    logger.warn('Recommendations failed, returning without', { courseId });
    // Continue without recommendations (graceful degradation)
  }
}

return course;
```

**Fallback Responses**:
```typescript
// If analytics service fails, return placeholder data
async function getAnalytics(courseId: string) {
  try {
    return await analyticsService.getCourseStats(courseId);
  } catch (error) {
    logger.warn('Analytics service unavailable', { courseId });
    return {
      enrollments: null,
      completions: null,
      message: 'Analytics temporarily unavailable',
    };
  }
}
```


## Testing Strategy

### 1. Unit Tests

**Scope**: Individual Lambda functions, business logic

**Framework**: Vitest (already in repo)

**Test Structure**:
```typescript
// tests/handlers/course.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '@/handlers/course';
import * as db from '@/db';

describe('Course Handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  
  it('returns course details for valid ID', async () => {
    const mockCourse = {
      id: 'course-123',
      name: 'Test Course',
      organizationId: 'org-456',
    };
    
    vi.spyOn(db, 'getCourse').mockResolvedValue(mockCourse);
    
    const event = {
      pathParameters: { id: 'course-123' },
      requestContext: { authorizer: { userId: 'user-789' } },
    };
    
    const response = await handler(event);
    
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      success: true,
      data: mockCourse,
    });
  });
  
  it('returns 404 for non-existent course', async () => {
    vi.spyOn(db, 'getCourse').mockResolvedValue(null);
    
    const event = {
      pathParameters: { id: 'invalid' },
      requestContext: { authorizer: { userId: 'user-789' } },
    };
    
    const response = await handler(event);
    
    expect(response.statusCode).toBe(404);
  });
  
  it('retries on database connection error', async () => {
    vi.spyOn(db, 'getCourse')
      .mockRejectedValueOnce(new Error('Connection timeout'))
      .mockResolvedValueOnce({ id: 'course-123', name: 'Test' });
    
    const event = {
      pathParameters: { id: 'course-123' },
      requestContext: { authorizer: { userId: 'user-789' } },
    };
    
    const response = await handler(event);
    
    expect(response.statusCode).toBe(200);
    expect(db.getCourse).toHaveBeenCalledTimes(2);
  });
});
```

**Coverage Target**: >80% for business logic

### 2. Integration Tests

**Scope**: End-to-end API flows with real AWS services (local stack)

**Tools**: 
- LocalStack (mock AWS services)
- Docker Compose (run Neon PostgreSQL + LocalStack)

**Setup**:
```yaml
# docker-compose.test.yml
version: '3.8'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: classroomio_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports:
      - "5433:5432"
  
  localstack:
    image: localstack/localstack:latest
    environment:
      SERVICES: lambda,apigateway,dynamodb,s3,sqs,cloudwatch
      DEFAULT_REGION: us-east-1
    ports:
      - "4566:4566"
```

**Test Structure**:
```typescript
// tests/integration/course-flow.test.ts
import { beforeAll, describe, it, expect } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { deployLambda, invokeLambda } from './utils/lambda';

describe('Course Enrollment Flow', () => {
  beforeAll(async () => {
    // Deploy Lambda functions to LocalStack
    await deployLambda('course-handler', './dist/course-handler.zip');
    
    // Seed test data
    await seedDatabase({
      courses: [{ id: 'course-123', name: 'Test Course' }],
      users: [{ id: 'user-789', email: 'test@example.com' }],
    });
  });
  
  it('completes full enrollment flow', async () => {
    // 1. Get course details
    const courseResponse = await invokeLambda('course-handler', {
      path: '/course/course-123',
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    
    expect(courseResponse.statusCode).toBe(200);
    
    // 2. Enroll in course
    const enrollResponse = await invokeLambda('course-handler', {
      path: '/course/course-123/enroll',
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });
    
    expect(enrollResponse.statusCode).toBe(201);
    
    // 3. Verify enrollment in database
    const enrollment = await db.query(
      'SELECT * FROM enrollment WHERE user_id = $1 AND course_id = $2',
      ['user-789', 'course-123']
    );
    
    expect(enrollment.rows).toHaveLength(1);
  });
});
```

### 3. Load Tests

**Scope**: Validate performance under concurrent load

**Tool**: Artillery (already in package.json or add k6)

**Configuration**:
```yaml
# artillery/course-load-test.yml
config:
  target: "https://api-staging.classroomio.com"
  phases:
    - duration: 60
      arrivalRate: 10  # 10 users/sec for 1 min
      name: "Warm up"
    - duration: 300
      arrivalRate: 50  # 50 users/sec for 5 min
      name: "Sustained load"
    - duration: 120
      arrivalRate: 100  # 100 users/sec for 2 min
      name: "Peak load"
  defaults:
    headers:
      Authorization: "Bearer {{ $processEnvironment.TEST_TOKEN }}"

scenarios:
  - name: "Course browsing"
    flow:
      - get:
          url: "/course"
      - think: 2
      - get:
          url: "/course/{{ courseId }}"
      - think: 1
      - post:
          url: "/course/{{ courseId }}/enroll"
```

**Run**:
```bash
artillery run artillery/course-load-test.yml --output report.json
artillery report report.json
```

**Success Criteria**:
- p95 latency < 1 second
- p99 latency < 3 seconds
- Error rate < 1%
- No Lambda throttling errors

### 4. End-to-End Tests

**Scope**: Critical user journeys (Dashboard → API → Database)

**Tool**: Playwright (if dashboard is Svelte/SvelteKit)

**Test Structure**:
```typescript
// e2e/course-enrollment.spec.ts
import { test, expect } from '@playwright/test';

test.describe('Course Enrollment', () => {
  test.beforeEach(async ({ page }) => {
    // Login
    await page.goto('https://app-staging.classroomio.com/login');
    await page.fill('input[name="email"]', 'test@example.com');
    await page.fill('input[name="password"]', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard');
  });
  
  test('can enroll in a course', async ({ page }) => {
    // Navigate to course catalog
    await page.goto('https://app-staging.classroomio.com/courses');
    
    // Click first course
    await page.click('[data-testid="course-card"]:first-child');
    
    // Click enroll button
    await page.click('[data-testid="enroll-button"]');
    
    // Verify success message
    await expect(page.locator('[data-testid="success-message"]')).toContainText('Successfully enrolled');
    
    // Verify course appears in "My Courses"
    await page.goto('https://app-staging.classroomio.com/dashboard');
    await expect(page.locator('[data-testid="enrolled-course"]')).toBeVisible();
  });
  
  test('can watch video lesson', async ({ page }) => {
    await page.goto('https://app-staging.classroomio.com/course/course-123/lesson/lesson-456');
    
    // Video player should load
    await expect(page.locator('video')).toBeVisible();
    
    // Click play
    await page.click('[data-testid="play-button"]');
    
    // Wait for video to start
    await page.waitForTimeout(2000);
    
    // Verify video is playing
    const isPaused = await page.evaluate(() => {
      const video = document.querySelector('video') as HTMLVideoElement;
      return video.paused;
    });
    
    expect(isPaused).toBe(false);
  });
});
```

### 5. Chaos Engineering Tests

**Scope**: Validate resilience to failures

**Scenarios**:
1. **Database failures**: Kill Neon connection mid-request
2. **SQS delays**: Delay message delivery by 10+ minutes
3. **Lambda throttling**: Reduce reserved concurrency to trigger throttles
4. **S3 errors**: Return 503 errors for 50% of requests

**Tool**: AWS Fault Injection Simulator (FIS) or custom chaos scripts

**Example**:
```typescript
// chaos/simulate-db-failure.ts
import { Pool } from '@neondatabase/serverless';

async function simulateDatabaseFailure() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  // Kill all connections
  await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid()');
  
  console.log('Database connections terminated');
  
  // Wait 30 seconds
  await new Promise(resolve => setTimeout(resolve, 30000));
  
  // Verify system recovers
  const result = await fetch('https://api-staging.classroomio.com/health');
  console.log('Health check status:', result.status);
}
```

### 6. Migration Validation Tests

**Scope**: Verify functional equivalence between old and new infrastructure

**Strategy**: Shadow traffic (parallel requests)

**Implementation**:
```typescript
// Lambda: shadow-traffic-validator
export async function handler(event: APIGatewayProxyEventV2) {
  // Send request to both old (Hono) and new (Lambda) endpoints
  const [oldResponse, newResponse] = await Promise.allSettled([
    fetch(`${HONO_URL}${event.rawPath}`, {
      method: event.requestContext.http.method,
      headers: event.headers,
      body: event.body,
    }),
    fetch(`${LAMBDA_URL}${event.rawPath}`, {
      method: event.requestContext.http.method,
      headers: event.headers,
      body: event.body,
    }),
  ]);
  
  // Compare responses
  const diff = compareResponses(oldResponse, newResponse);
  
  if (diff.hasDifference) {
    console.warn('Response mismatch', {
      path: event.rawPath,
      diff,
    });
    
    // Emit metric
    await cloudwatch.putMetricData({
      Namespace: 'ClassroomIO/Migration',
      MetricData: [{
        MetricName: 'ResponseMismatch',
        Value: 1,
        Unit: 'Count',
      }],
    });
  }
  
  // Return old response (no disruption during validation)
  return oldResponse.value;
}
```

### 7. Test Data Management

**Seed Data**:
```typescript
// tests/seed.ts
export async function seedTestData() {
  const db = await connectDatabase();
  
  // Create test organization
  const org = await db.insert(organizationTable).values({
    id: 'org-test',
    name: 'Test Organization',
  });
  
  // Create test courses
  await db.insert(courseTable).values([
    {
      id: 'course-1',
      name: 'Introduction to AWS',
      organizationId: 'org-test',
      slug: 'intro-aws',
    },
    {
      id: 'course-2',
      name: 'Advanced Lambda',
      organizationId: 'org-test',
      slug: 'advanced-lambda',
    },
  ]);
  
  // Create test users
  await db.insert(userTable).values({
    id: 'user-test',
    email: 'test@example.com',
    name: 'Test User',
  });
}
```

**Cleanup**:
```typescript
export async function cleanupTestData() {
  const db = await connectDatabase();
  
  await db.delete(enrollmentTable).where(eq(enrollmentTable.userId, 'user-test'));
  await db.delete(courseTable).where(eq(courseTable.organizationId, 'org-test'));
  await db.delete(organizationTable).where(eq(organizationTable.id, 'org-test'));
  await db.delete(userTable).where(eq(userTable.id, 'user-test'));
}
```

### 8. CI/CD Integration

**GitHub Actions Pipeline**:
```yaml
# .github/workflows/test.yml
name: Test Suite

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: pnpm install
      - run: pnpm test:unit
  
  integration-tests:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: classroomio_test
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
      localstack:
        image: localstack/localstack:latest
        env:
          SERVICES: lambda,dynamodb,s3,sqs
        ports:
          - 4566:4566
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: pnpm install
      - run: pnpm test:integration
  
  deploy-staging:
    needs: [unit-tests, integration-tests]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: pnpm install
      - run: pnpm build
      - run: pnpm cdk deploy --require-approval never
        env:
          AWS_REGION: us-east-1
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
  
  e2e-tests:
    needs: deploy-staging
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: pnpm install
      - run: npx playwright install
      - run: pnpm test:e2e
        env:
          BASE_URL: https://app-staging.classroomio.com
```


## Deployment Strategy

### 1. Infrastructure as Code with AWS CDK

**Repository Structure**:
```
infrastructure/
├── bin/
│   └── app.ts                    # CDK app entry point
├── lib/
│   ├── stacks/
│   │   ├── api-stack.ts          # API Gateway + Lambda
│   │   ├── database-stack.ts     # Neon config (external)
│   │   ├── storage-stack.ts      # S3 + CloudFront
│   │   ├── queue-stack.ts        # SQS + EventBridge
│   │   ├── monitoring-stack.ts   # CloudWatch dashboards/alarms
│   │   └── migration-stack.ts    # Migration router
│   ├── constructs/
│   │   ├── lambda-function.ts    # Reusable Lambda construct
│   │   ├── api-route.ts          # API Gateway route construct
│   │   └── sqs-worker.ts         # SQS + Lambda worker construct
│   └── config/
│       ├── dev.ts                # Dev environment config
│       ├── staging.ts            # Staging environment config
│       └── production.ts         # Production environment config
├── cdk.json
├── package.json
└── tsconfig.json
```

**CDK App Entry Point**:
```typescript
// bin/app.ts
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/stacks/api-stack';
import { StorageStack } from '../lib/stacks/storage-stack';
import { QueueStack } from '../lib/stacks/queue-stack';
import { MonitoringStack } from '../lib/stacks/monitoring-stack';
import { getConfig } from '../lib/config';

const app = new cdk.App();
const env = app.node.tryGetContext('env') || 'dev';
const config = getConfig(env);

// Storage stack (S3 + CloudFront) - no dependencies
const storageStack = new StorageStack(app, `ClassroomIO-Storage-${env}`, {
  env: { region: config.region, account: config.account },
  config,
});

// Queue stack (SQS + EventBridge) - no dependencies
const queueStack = new QueueStack(app, `ClassroomIO-Queue-${env}`, {
  env: { region: config.region, account: config.account },
  config,
});

// API stack (API Gateway + Lambda) - depends on storage and queues
const apiStack = new ApiStack(app, `ClassroomIO-API-${env}`, {
  env: { region: config.region, account: config.account },
  config,
  mediaBucket: storageStack.mediaBucket,
  mediaQueue: queueStack.mediaQueue,
  emailQueue: queueStack.emailQueue,
});

// Monitoring stack (CloudWatch) - depends on API
const monitoringStack = new MonitoringStack(app, `ClassroomIO-Monitoring-${env}`, {
  env: { region: config.region, account: config.account },
  config,
  lambdaFunctions: apiStack.lambdaFunctions,
  distribution: storageStack.distribution,
});
```

**Environment Configuration**:
```typescript
// lib/config/production.ts
export const productionConfig = {
  region: 'us-east-1',
  account: '123456789012',
  
  // Neon PostgreSQL (external, managed outside CDK)
  databaseUrl: 'postgresql://user:pass@ep-xyz.us-east-1.aws.neon.tech/classroomio',
  
  // Lambda configuration
  lambda: {
    memorySize: 512,
    timeout: 15,
    architecture: lambda.Architecture.ARM_64,
    reservedConcurrency: {
      courseHandler: 100,
      mediaWorker: 10,
    },
  },
  
  // API Gateway
  apiGateway: {
    throttling: {
      burstLimit: 5000,
      rateLimit: 2000,
    },
  },
  
  // CloudFront
  cloudFront: {
    priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US + Europe
    cacheTtls: {
      masterPlaylist: 10,
      variantPlaylist: 300,
      segment: 31536000,
    },
  },
  
  // DynamoDB
  dynamoDB: {
    billingMode: dynamodb.BillingMode.ON_DEMAND,
    ttl: {
      rateLimits: 86400,  // 24 hours
      jobMetadata: 604800, // 7 days
    },
  },
  
  // Monitoring
  monitoring: {
    logRetentionDays: 30,
    alarmEmail: 'ops@classroomio.com',
    dashboardName: 'ClassroomIO-Production',
  },
};
```

### 2. Deployment Environments

**Environment Separation**:

| Environment | Purpose | Domain | Database | Budget |
|-------------|---------|--------|----------|--------|
| **dev** | Local/PR testing | api-dev.classroomio.com | Neon free tier | $10/month |
| **staging** | Pre-production validation | api-staging.classroomio.com | Neon Scale | $50/month |
| **production** | Live traffic | api.classroomio.com | Neon Scale | $200/month |

**Deploy Commands**:
```bash
# Deploy to dev
pnpm cdk deploy --all --context env=dev

# Deploy to staging
pnpm cdk deploy --all --context env=staging --require-approval never

# Deploy to production (with manual approval)
pnpm cdk deploy --all --context env=production
```

### 3. CI/CD Pipeline

**GitHub Actions Workflow**:
```yaml
# .github/workflows/deploy.yml
name: Deploy to AWS

on:
  push:
    branches:
      - main
      - develop
  pull_request:
    branches:
      - main

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: pnpm install
      - run: pnpm test:unit
      - run: pnpm lint
  
  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: pnpm install
      - run: pnpm build
      - uses: actions/upload-artifact@v3
        with:
          name: lambda-dist
          path: dist/
  
  deploy-dev:
    needs: build
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/download-artifact@v3
        with:
          name: lambda-dist
          path: dist/
      - uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - run: pnpm cdk deploy --all --context env=dev --require-approval never
  
  deploy-staging:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/download-artifact@v3
        with:
          name: lambda-dist
          path: dist/
      - uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1
      - run: pnpm cdk deploy --all --context env=staging --require-approval never
      
      # Run integration tests against staging
      - run: pnpm test:integration
        env:
          API_BASE_URL: https://api-staging.classroomio.com
      
      # Run E2E tests
      - run: npx playwright install
      - run: pnpm test:e2e
        env:
          BASE_URL: https://app-staging.classroomio.com
  
  deploy-production:
    needs: deploy-staging
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://api.classroomio.com
    steps:
      - uses: actions/checkout@v3
      - uses: actions/download-artifact@v3
        with:
          name: lambda-dist
          path: dist/
      - uses: aws-actions/configure-aws-credentials@v2
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID_PROD }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY_PROD }}
          aws-region: us-east-1
      
      # Manual approval required (GitHub Environments)
      - run: pnpm cdk deploy --all --context env=production
```

### 4. Lambda Deployment

**Build Process**:
```typescript
// infrastructure/lib/constructs/lambda-function.ts
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';

export function createLambdaFunction(
  scope: Construct,
  id: string,
  props: {
    entry: string;
    handler?: string;
    memorySize?: number;
    timeout?: Duration;
    environment?: Record<string, string>;
  }
) {
  return new nodejs.NodejsFunction(scope, id, {
    entry: props.entry,
    handler: props.handler || 'handler',
    runtime: lambda.Runtime.NODEJS_20_X,
    architecture: lambda.Architecture.ARM_64,
    memorySize: props.memorySize || 512,
    timeout: props.timeout || Duration.seconds(15),
    bundling: {
      minify: true,
      sourceMap: true,
      target: 'node20',
      format: nodejs.OutputFormat.ESM,
      esbuildArgs: {
        '--tree-shaking': 'true',
      },
      externalModules: [
        '@aws-sdk/*', // Already in Lambda runtime
      ],
    },
    environment: props.environment,
  });
}
```

**Versioning and Aliases**:
```typescript
// Create new version on each deployment
const version = courseHandler.currentVersion;

// Create alias pointing to version
const alias = new lambda.Alias(this, 'CourseHandlerLive', {
  aliasName: 'live',
  version,
});

// API Gateway points to alias (not latest)
// Enables rollback without redeployment
```

### 5. Database Migration

**Drizzle Kit Migration**:
```bash
# Generate migration
pnpm drizzle-kit generate:pg

# Run migration against Neon
pnpm drizzle-kit migrate --url=$DATABASE_URL
```

**Migration Script** (automated in CI/CD):
```typescript
// scripts/migrate.ts
import { drizzle } from 'drizzle-orm/neon-serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { Pool } from '@neondatabase/serverless';

async function runMigrations() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  
  console.log('Running migrations...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations complete');
  
  await pool.end();
}

runMigrations().catch(console.error);
```

**CI/CD Integration**:
```yaml
# Add to deploy workflow BEFORE CDK deploy
- name: Run Database Migrations
  run: pnpm db:migrate
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

### 6. Rollback Procedures

**Lambda Rollback** (via Alias):
```bash
# List recent versions
aws lambda list-versions-by-function --function-name course-handler

# Update alias to previous version
aws lambda update-alias \
  --function-name course-handler \
  --name live \
  --function-version 42  # Previous stable version
```

**Route Rollback** (via DynamoDB):
```bash
# Update migration route target to "hono"
aws dynamodb update-item \
  --table-name migration-routes \
  --key '{"path": {"S": "/course/*"}}' \
  --update-expression "SET #target = :hono" \
  --expression-attribute-names '{"#target": "target"}' \
  --expression-attribute-values '{":hono": {"S": "hono"}}'

# Traffic immediately routes back to old Hono server
```

**Full Stack Rollback** (via CDK):
```bash
# List CloudFormation stacks
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE

# Rollback to previous stack
aws cloudformation rollback-stack --stack-name ClassroomIO-API-production

# Or delete and redeploy previous CDK version
git checkout <previous-commit>
pnpm cdk deploy --all --context env=production
```

**Database Rollback** (Drizzle migrations):
```bash
# Revert last migration
pnpm drizzle-kit drop

# OR apply specific migration
git checkout <previous-commit>
pnpm db:migrate
```

### 7. Blue/Green Deployment (Advanced)

**Strategy**: Deploy new Lambda version alongside old, gradually shift traffic

**Implementation**:
```typescript
// Use Lambda weighted aliases
const blueAlias = new lambda.Alias(this, 'Blue', {
  aliasName: 'blue',
  version: oldVersion,
});

const greenAlias = new lambda.Alias(this, 'Green', {
  aliasName: 'green',
  version: newVersion,
});

// API Gateway stages
const blueStage = api.addStage('blue', {
  stageName: 'blue',
  deployment: blueDeployment,
});

const greenStage = api.addStage('green', {
  stageName: 'green',
  deployment: greenDeployment,
});

// Route 53 weighted routing
new route53.RecordSet(this, 'BlueRecord', {
  zone: hostedZone,
  recordType: route53.RecordType.A,
  target: route53.RecordTarget.fromAlias(
    new targets.ApiGatewayDomain(blueDomain)
  ),
  weight: 90, // 90% to blue (old)
});

new route53.RecordSet(this, 'GreenRecord', {
  zone: hostedZone,
  recordType: route53.RecordType.A,
  target: route53.RecordTarget.fromAlias(
    new targets.ApiGatewayDomain(greenDomain)
  ),
  weight: 10, // 10% to green (new)
});

// Gradually shift: 90/10 → 50/50 → 10/90 → 0/100
```

### 8. Monitoring During Deployment

**Pre-Deployment Checklist**:
- [ ] All tests pass (unit, integration, E2E)
- [ ] Database migrations tested in staging
- [ ] Lambda bundle size < 10 MB
- [ ] Environment variables configured
- [ ] CloudWatch alarms enabled
- [ ] Rollback plan documented

**Post-Deployment Validation**:
```bash
# Health check
curl https://api.classroomio.com/health

# Smoke tests
pnpm test:smoke --env=production

# Monitor CloudWatch metrics for 15 minutes
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Errors \
  --dimensions Name=FunctionName,Value=course-handler \
  --start-time $(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum

# Check for DLQ messages
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/media-jobs-dlq \
  --attribute-names ApproximateNumberOfMessages
```

**Automated Rollback Trigger**:
```typescript
// CloudWatch alarm triggers rollback Lambda
const errorAlarm = new cloudwatch.Alarm(this, 'HighErrorRatePostDeploy', {
  metric: lambda.metricErrors({ period: Duration.minutes(5) }),
  threshold: 10,
  evaluationPeriods: 2,
  alarmDescription: 'Rollback if errors exceed threshold',
});

errorAlarm.addAlarmAction(
  new actions.LambdaAction(rollbackFunction)
);
```


## Phase 1 Implementation Plan

### Week 1-2: Foundation & Infrastructure Setup

**Deliverables**:
- CDK project structure
- Base AWS resources (S3, DynamoDB, CloudWatch)
- Neon PostgreSQL connection validation
- Development environment setup

**Tasks**:
1. **CDK Project Setup**:
   - Create `infrastructure/` directory
   - Initialize CDK app with TypeScript
   - Configure environments (dev, staging, production)
   - Set up CI/CD pipeline (GitHub Actions)

2. **AWS Resources**:
   - Create S3 bucket (classroomio-media)
   - Create DynamoDB tables (rate-limits, job-metadata, migration-routes)
   - Set up CloudWatch log groups
   - Configure IAM roles (least privilege)

3. **Neon Integration**:
   - Test connection pooling from Lambda
   - Benchmark cold start with Neon wake-up
   - Validate Better Auth session storage
   - Run Drizzle migrations

4. **Development Tools**:
   - LocalStack setup for local testing
   - Docker Compose for integration tests
   - ESBuild Lambda bundler configuration

**Success Criteria**:
- ✅ CDK deploys successfully to dev environment
- ✅ Lambda connects to Neon in <500ms (warm)
- ✅ Better Auth validates sessions against Neon
- ✅ Unit tests pass with mocked AWS services

### Week 2-3: Authentication & Core API Routes

**Deliverables**:
- Auth Lambda functions (login, logout, session)
- API Gateway configuration
- Migration router Lambda
- Account/profile routes

**Tasks**:
1. **Authentication Routes**:
   - `/auth/login` → Lambda (session creation in Neon)
   - `/auth/logout` → Lambda (session deletion)
   - `/auth/session` → Lambda (session validation)
   - Better Auth integration (Drizzle ORM)

2. **API Gateway Setup**:
   - HTTP API with custom domain
   - CORS configuration
   - Usage plans and throttling
   - JWT validation (Lambda authorizer)

3. **Migration Router**:
   - DynamoDB-based routing config
   - Hono proxy Lambda (forwards to current server)
   - Route matching logic (longest prefix)
   - Logging (routing decisions to CloudWatch)

4. **Account Routes**:
   - `/account/profile` → Lambda
   - `/account/settings` → Lambda

**Success Criteria**:
- ✅ Login flow works end-to-end
- ✅ Session persists in Neon
- ✅ Migration router routes 100% to Hono initially
- ✅ API Gateway returns 401 for invalid tokens

### Week 3-4: Course & Lesson Routes

**Deliverables**:
- Course Lambda functions
- Lesson Lambda functions
- Rate limiting (DynamoDB counters)
- CloudWatch dashboards

**Tasks**:
1. **Course Routes**:
   - `/course` (list) → Lambda
   - `/course/:id` (details) → Lambda
   - `/course/:id/enroll` → Lambda
   - Enrollment validation logic

2. **Lesson Routes**:
   - `/course/:id/lessons` → Lambda
   - `/lesson/:id` → Lambda
   - `/lesson/:id/progress` → Lambda
   - Progress tracking (update in Neon)

3. **Rate Limiting**:
   - DynamoDB counters (per-user, per-IP)
   - Atomic increment with condition check
   - TTL cleanup (24h)

4. **Monitoring**:
   - CloudWatch dashboard (requests, errors, latency)
   - Custom metrics (enrollments, lesson views)
   - Alarms (error rate, latency)

**Success Criteria**:
- ✅ Course listing returns results in <500ms (p95)
- ✅ Enrollment flow creates database record
- ✅ Rate limiting blocks requests after limit
- ✅ Dashboard shows real-time metrics

**Migration Rollout**:
- Update migration router: `/course/*` → canary: 10%
- Monitor for 24 hours (errors, latency, logs)
- Increase canary: 10% → 25% → 50% → 100%
- Update migration router: `/course/*` → target: lambda

### Week 4-5: Video Streaming

**Deliverables**:
- CloudFront distribution with signed URLs
- HLS cookie/URL generation Lambda
- S3 bucket policies (OAC)
- Video playback validation

**Tasks**:
1. **CloudFront Setup**:
   - Distribution with S3 origin (OAC)
   - Cache behaviors (/hls/*, /assets/*)
   - Trusted key groups (for signed URLs)
   - Custom domain (cdn.classroomio.com)

2. **Signed URL Generation**:
   - `/course/:slug/item/:slug/video-url` → Lambda
   - Verify enrollment
   - Generate CloudFront signed URL (1h expiry)
   - Return to dashboard

3. **S3 Migration**:
   - Copy existing HLS content to S3
   - Update asset metadata (S3 keys)
   - Test playback (master.m3u8 → segments)

4. **Dashboard Integration**:
   - Update video player (fetch signed URL first)
   - hls.js configuration (signed URL propagation)
   - Error handling (403, expired URL)

**Success Criteria**:
- ✅ Video plays without buffering
- ✅ Signed URL expires after 1 hour
- ✅ Unauthorized users get 403
- ✅ CloudFront cache hit ratio >80%

**Migration Rollout**:
- Update migration router: `/hls-cookie` → canary: 10%
- Test video playback in staging
- Increase canary: 50% → 100%
- DNS cutover: cdn.classroomio.com → CloudFront

### Week 5-6: Assignments & Dashboard

**Deliverables**:
- Assignment Lambda functions
- Submission handling
- Student dashboard routes
- Instructor dashboard routes

**Tasks**:
1. **Assignment Routes**:
   - `/assignment/:id` → Lambda
   - `/assignment/:id/submit` → Lambda
   - Submission validation (file size, format)
   - Store submission in Neon

2. **Dashboard Routes**:
   - `/dashboard/student` → Lambda (enrolled courses, progress)
   - `/dashboard/instructor` → Lambda (course analytics)
   - Aggregated queries (optimize for performance)

3. **Performance Optimization**:
   - Query optimization (indexes, joins)
   - Connection pooling (reuse across invocations)
   - Response caching (CloudFront for read-heavy)

**Success Criteria**:
- ✅ Assignment submission creates database record
- ✅ Dashboard loads in <1s (p95)
- ✅ Instructor analytics query completes in <500ms

**Migration Rollout**:
- Update migration router: `/assignment/*`, `/dashboard/*` → canary: 10%
- Monitor for 48 hours
- Increase canary: 50% → 100%

### Week 6-8: Background Jobs & Cleanup

**Deliverables**:
- SQS queues (media, email, notification)
- Lambda workers (SQS event source mapping)
- EventBridge scheduled tasks
- Dead Letter Queue monitoring

**Tasks**:
1. **Media Jobs (SQS + Lambda)**:
   - Create SQS queue (media-jobs)
   - Media worker Lambda (transcode, thumbnail, metadata)
   - DynamoDB job metadata tracking
   - DLQ for failed jobs

2. **Email Jobs**:
   - Email queue + worker
   - Migrate BullMQ email jobs to SQS pattern
   - Template rendering (same as current)

3. **Notification Jobs**:
   - Notification queue + worker
   - Push notification logic

4. **Scheduled Tasks (EventBridge)**:
   - Cleanup expired sessions (daily 2 AM)
   - Aggregate analytics (daily 3 AM)
   - Session reminders (hourly)
   - Map existing BullMQ cron jobs

5. **Migration from BullMQ**:
   - Refactor job enqueue calls (queue.add → SQS SendMessage)
   - Rewrite workers (polling → event-driven)
   - Test job execution end-to-end
   - Decommission BullMQ + Redis

**Success Criteria**:
- ✅ Media jobs complete successfully (transcode, thumbnail)
- ✅ Email jobs send without errors
- ✅ Scheduled tasks run on time
- ✅ DLQ captures failed jobs for investigation
- ✅ Redis decommissioned (cost saved)

**Migration Rollout**:
- Deploy SQS + Lambda workers
- Dual-write: Enqueue to both BullMQ and SQS (1 week overlap)
- Monitor SQS job success rate (target >99%)
- Stop BullMQ enqueuing
- Terminate Redis instance

### Week 8: Final Validation & Cutover

**Deliverables**:
- Load testing results
- Documentation
- Runbooks
- Cost analysis
- Production cutover

**Tasks**:
1. **Load Testing**:
   - Artillery load test (50-100 req/sec sustained)
   - Validate p95 latency <1s
   - Validate error rate <1%
   - Identify bottlenecks

2. **Documentation**:
   - Architecture diagrams (updated)
   - Deployment guide
   - Troubleshooting runbook
   - Cost breakdown spreadsheet

3. **Monitoring Setup**:
   - CloudWatch dashboards (production)
   - Alarms (error rate, latency, cost)
   - SNS notifications (ops team)
   - Budget alerts ($200/month)

4. **Production Cutover**:
   - Update migration router: `/*` → target: lambda (default)
   - DNS cutover: api.classroomio.com → API Gateway
   - Monitor for 24 hours (errors, latency, cost)
   - Decommission Render API server

**Success Criteria**:
- ✅ All P0 routes migrated to Lambda
- ✅ Load test passes (p95 <1s, error rate <1%)
- ✅ Cost <$20/month (low traffic scenario)
- ✅ CloudWatch dashboards operational
- ✅ Runbooks documented
- ✅ Old infrastructure decommissioned

### Post-Migration (Week 9+)

**Ongoing Tasks**:
1. **Cost Optimization**:
   - Review CloudWatch logs (reduce verbosity)
   - Optimize Lambda memory sizes (benchmark)
   - Consider Savings Plans (if usage stabilizes)

2. **Performance Tuning**:
   - Enable provisioned concurrency (if cold starts >2s)
   - Add read replicas (if database becomes bottleneck)
   - Optimize DynamoDB indexes

3. **Feature Expansion**:
   - Phase 2: Video upload/transcode pipeline
   - Phase 2: AI features
   - Phase 2: Multi-region deployment

## Risks and Mitigation

### Risk 1: Lambda Cold Starts Exceed 1s (p95)

**Impact**: Poor user experience, missed performance target

**Probability**: Medium

**Mitigation**:
- Bundle size <5 MB (tree-shake, minify)
- Connection pooling (reuse database connections)
- Lazy load heavy dependencies (ffmpeg only in workers)
- **Fallback**: Enable provisioned concurrency ($5.50/month per function)

### Risk 2: Neon Connection Limits Exhausted

**Impact**: Database errors, failed requests

**Probability**: Low-Medium

**Mitigation**:
- Use Neon connection pooler (handles 10K+ connections)
- Lambda reserved concurrency (limit max concurrent executions)
- Connection timeout + retry logic
- **Fallback**: Upgrade Neon plan or add PgBouncer

### Risk 3: CloudFront Signed URLs Add Latency

**Impact**: Slower video playback startup

**Probability**: Low

**Mitigation**:
- Generate signed URL asynchronously (prefetch on page load)
- Cache master.m3u8 at edge (10s TTL)
- Use relative URLs in playlists (signature propagates)
- **Fallback**: Increase signed URL expiry to 2-4 hours

### Risk 4: DynamoDB Rate Limiting Eventual Consistency Issues

**Impact**: Rate limit bypass window (5s)

**Probability**: Medium

**Mitigation**:
- Acceptable trade-off (5s window unlikely to be exploited)
- API Gateway throttling (coarse-grained backstop)
- Monitor for abuse patterns
- **Fallback**: Switch to strongly consistent reads (+50% cost)

### Risk 5: Migration Router Adds Latency Overhead

**Impact**: Extra 50-100ms per request

**Probability**: High (expected)

**Mitigation**:
- Cache routing decisions in Lambda (in-memory TTL cache)
- Minimize DynamoDB query overhead (single-item read)
- **Fallback**: Hard-code routes in API Gateway (no dynamic routing)

### Risk 6: Cost Exceeds Budget

**Impact**: Higher than expected monthly cost

**Probability**: Medium

**Mitigation**:
- CloudWatch budget alarms ($20, $50, $100)
- Lambda reserved concurrency (cap runaway invocations)
- S3 lifecycle policies (archive old videos to Glacier)
- **Fallback**: Scale back features or increase budget

### Risk 7: Video Upload Disruption (Out of Scope for Phase 1)

**Impact**: Users cannot upload videos during migration

**Probability**: Low (Phase 1 serves existing HLS only)

**Mitigation**:
- Keep current upload pipeline running (Hono + BullMQ)
- Phase 1: Only migrate playback (serving)
- Phase 2: Migrate upload/transcode (Step Functions)


## Appendix

### A. Service Selection Decision Matrix

| Requirement | Option 1 | Option 2 | Option 3 | Chosen | Rationale |
|-------------|----------|----------|----------|--------|-----------|
| **Compute** | Lambda | ECS Fargate | - | **Lambda** | Serverless, pay-per-use, <$5 idle. Fargate minimum $15/month for 0.25 vCPU. |
| **Database** | Neon PostgreSQL | Aurora Serverless v2 | - | **Neon** | True scale-to-zero ($0 idle). Aurora minimum 0.5 ACU = $40/month. |
| **Session Storage** | Neon PostgreSQL | ElastiCache Redis | - | **Neon** | Eliminates Redis cost ($10-20/month). Better Auth supports Drizzle. |
| **Rate Limiting** | DynamoDB | ElastiCache Redis | - | **DynamoDB** | Pay-per-use ($0.25/1M reads). Redis fixed cost $10+/month. |
| **Background Jobs** | SQS + Lambda | BullMQ + Redis | - | **SQS + Lambda** | No Redis needed. Native Lambda integration. |
| **Scheduled Tasks** | EventBridge | EC2 cron server | - | **EventBridge** | Serverless, free tier covers usage. EC2 minimum $5/month. |
| **Video Streaming** | CloudFront | Direct S3 | - | **CloudFront** | Edge caching, signed URLs, 30% cheaper data transfer. |
| **Video Transcoding** | MediaConvert | Lambda + ffmpeg | ECS + ffmpeg | **MediaConvert** | Serverless pay-per-minute, no 15-min Lambda limit, no EC2 fixed cost. HLS/DASH output built-in. |
| **Email Service** | Amazon SES | SMTP server | SendGrid | **Amazon SES** | Serverless, $0.10 per 1K emails, high deliverability. SMTP needs server ($5+/month). SendGrid costlier at scale. |
| **Static Assets** | CloudFront + S3 | S3 only | - | **CloudFront + S3** | Global edge caching, lower latency, HTTPS. |
| **Ephemeral State** | DynamoDB | Redis | - | **DynamoDB** | Pay-per-use, TTL auto-cleanup, no management. |
| **API Gateway** | HTTP API | REST API | - | **HTTP API** | Simpler, 70% cheaper ($1/1M vs $3.50/1M). |
| **Connection Pooling** | Neon pooler | RDS Proxy | - | **Neon pooler** | Built-in, no extra cost. RDS Proxy $50+/month. |

#### MediaConvert Decision Details

**Why AWS Elemental MediaConvert**:
- Serverless, pay-per-minute transcoding ($0.015/min SD, $0.03/min HD)
- HLS and DASH output formats built-in with adaptive bitrate
- No infrastructure management (vs ECS) or timeout limits (vs Lambda)
- Automatic job queuing and scaling

**Why NOT Lambda + ffmpeg**:
- Lambda has 15-minute max timeout (insufficient for long videos)
- Lambda ephemeral storage limited to 10 GB
- Complex to manage ffmpeg binary and dependencies at scale
- Would require Step Functions orchestration for long videos

**Why NOT ECS + ffmpeg**:
- Fixed cost for always-on or Fargate instances ($15-50/month minimum)
- Need to manage ffmpeg updates and worker scaling
- Higher operational complexity

**Cost**: ~$0.30 per 10-minute HD video vs ~$0.50+ for ECS worker time

### Dashboard Analytics Cold Start Mitigation

**Problem**: Instructor dashboard with aggregated analytics may exceed 1s p95 on first load after Neon pause, especially with complex multi-table joins for course statistics.

**Mitigation Options**:

1. **Cache analytics results** (Recommended for Phase 2):
   - Store pre-computed aggregates in DynamoDB
   - Refresh every 5 minutes via EventBridge + Lambda
   - First load reads from cache (<50ms), background refresh updates
   - Cost: +$1-2/month for DynamoDB storage and compute

2. **Warm queries**:
   - EventBridge rule pings dashboard endpoints every 4 minutes
   - Keeps Neon awake during business hours
   - Cost: +$0.20/month for EventBridge invocations
   - Trade-off: Defeats scale-to-zero benefit

3. **Graceful degradation** (Phase 1 approach):
   - Show cached/stale data on first load with "Refreshing..." indicator
   - Fetch fresh data in background, update UI when ready
   - User sees instant load, fresh data within 2-3 seconds
   - No additional cost

4. **Accept higher p95**:
   - Document that first load after idle may be 2-3 seconds
   - Subsequent loads <500ms (Neon stays warm for 5 minutes)
   - Most users won't hit cold start (continuous traffic keeps warm)
   - No additional cost

**Phase 1 Recommendation**: Use option 3 (graceful degradation) - provide instant feedback with cached data, fetch fresh data asynchronously. Monitor actual p95 in production; if cold starts become problematic, implement option 1 (cache) in Phase 2.

**Implementation**:
```typescript
// Dashboard route: show cached data immediately
const cachedData = await getCachedAnalytics(courseId);
if (cachedData) {
  return { data: cachedData, stale: true };
}

// Background: fetch fresh and update cache
fetchFreshAnalytics(courseId).then(freshData => {
  setCachedAnalytics(courseId, freshData);
  notifyClient({ data: freshData, stale: false });
});
```

#### Email Service Decision Details

**Why Amazon SES**:
- Serverless, pay-per-email ($0.10 per 1,000 emails sent)
- High deliverability with AWS infrastructure
- No fixed monthly cost
- Supports templates, bounce/complaint handling

**Why NOT SMTP server**:
- Fixed cost for server instance ($5-10/month minimum)
- Management overhead (updates, monitoring)
- Lower deliverability without warm-up

**Why NOT third-party (SendGrid, Mailgun)**:
- Higher cost at scale ($15-80/month for moderate volume)
- External dependency
- SES sufficient for transactional emails

**Cost**: $0.10 per 1K emails vs $15/month minimum for alternatives

### B. Cost Optimization Strategies

**Immediate (Phase 1)**:
1. ARM64 Lambda (20% cost savings)
2. Neon free tier (0.5 GB storage, 3 GB transfer)
3. CloudWatch log filtering (reduce ingestion)
4. S3 Intelligent-Tiering (auto-archive cold data)
5. DynamoDB on-demand (no over-provisioning)

**Medium-Term (Month 2-3)**:
1. Lambda Savings Plans (if usage stabilizes)
2. CloudFront reserved capacity (if predictable)
3. S3 Glacier Deep Archive (old videos)
4. Neon Scale plan ($19/month vs pay-per-hour if >120h/month)
5. CloudWatch metric filters (reduce custom metrics)

**Long-Term (Month 4+)**:
1. Reserved concurrency review (reduce if not needed)
2. Multi-region failover (CloudFront origin groups)
3. Read replicas (if database becomes bottleneck)
4. Compute Savings Plans (1-year commit)

### C. Monitoring Queries (CloudWatch Logs Insights)

**Find slowest routes**:
```sql
fields @timestamp, route, @duration
| filter @type = "REPORT"
| stats max(@duration) as maxDuration, avg(@duration) as avgDuration by route
| sort maxDuration desc
| limit 20
```

**Cold start analysis**:
```sql
fields @timestamp, @message, @initDuration
| filter @message like /Init Duration/
| stats count() as coldStarts, avg(@initDuration) as avgInit by bin(1h)
```

**Error breakdown by code**:
```sql
fields @timestamp, errorCode, errorMessage
| filter @level = "ERROR"
| stats count() as errorCount by errorCode
| sort errorCount desc
```

**Database query performance**:
```sql
fields @timestamp, query, duration_ms
| filter query like /SELECT/
| stats percentile(duration_ms, 95) as p95, max(duration_ms) as max by query
| sort p95 desc
```

**Rate limit violations**:
```sql
fields @timestamp, userId, ipAddress, action
| filter action = "rate_limit_exceeded"
| stats count() as violations by userId, ipAddress
| sort violations desc
```

### D. Troubleshooting Guide

**Issue**: Lambda cold start >3 seconds

**Diagnosis**:
```bash
# Check bundle size
ls -lh dist/course-handler.zip

# Check initialization duration
aws logs filter-log-events \
  --log-group-name /aws/lambda/course-handler \
  --filter-pattern "Init Duration"
```

**Solution**:
- Reduce bundle size (tree-shake, external modules)
- Lazy load heavy dependencies
- Consider provisioned concurrency

---

**Issue**: Database connection timeout

**Diagnosis**:
```sql
-- CloudWatch Logs Insights
fields @timestamp, @message
| filter @message like /Connection timeout/
| stats count() by bin(5m)
```

**Solution**:
- Check Neon status (paused vs active)
- Increase connection timeout (10s → 15s)
- Add retry logic with exponential backoff

---

**Issue**: Rate limit not enforcing

**Diagnosis**:
```bash
# Check DynamoDB item
aws dynamodb get-item \
  --table-name rate-limits \
  --key '{"composite_key": {"S": "user:USER_ID"}, "window_start": {"N": "TIMESTAMP"}}'
```

**Solution**:
- Verify TTL is enabled
- Check ConditionExpression logic
- Consider strongly consistent reads

---

**Issue**: Video playback 403 error

**Diagnosis**:
- Check CloudFront signed URL expiry
- Verify CloudFront key pair ID matches
- Check S3 bucket policy (OAC permissions)

**Solution**:
- Regenerate signed URL
- Update CloudFront trusted key groups
- Verify OAC permissions in S3 policy

---

**Issue**: SQS messages not processing

**Diagnosis**:
```bash
# Check DLQ
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/ACCOUNT_ID/media-jobs-dlq \
  --attribute-names All

# Check Lambda errors
aws logs filter-log-events \
  --log-group-name /aws/lambda/media-worker \
  --filter-pattern "ERROR"
```

**Solution**:
- Check Lambda reserved concurrency (may be throttled)
- Inspect DLQ messages (manual reprocessing)
- Verify Lambda IAM role (SQS permissions)

### E. Glossary

- **API Gateway**: AWS service providing HTTP API frontend for Lambda
- **ARM64**: CPU architecture (Graviton2) offering 20% cost savings vs x86
- **Better Auth**: Authentication library using Drizzle ORM + PostgreSQL
- **BullMQ**: Current Redis-based job queue (to be replaced)
- **CloudFront**: AWS CDN for global content delivery
- **CloudWatch**: AWS monitoring and logging service
- **Cold Start**: Lambda initialization time on first invocation
- **DLQ**: Dead Letter Queue for failed messages
- **DynamoDB**: AWS serverless NoSQL database
- **EventBridge**: AWS serverless event scheduler
- **HLS**: HTTP Live Streaming video protocol
- **Lambda**: AWS serverless compute service
- **Neon**: Serverless PostgreSQL with scale-to-zero
- **OAC**: Origin Access Control (CloudFront → S3 security)
- **P0 Routes**: Priority zero routes (core MOOC functionality)
- **SQS**: AWS Simple Queue Service
- **Strangler Fig**: Incremental migration pattern
- **TTL**: Time-to-Live (DynamoDB auto-expiration)

### F. References

**AWS Documentation**:
- [Lambda Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)
- [API Gateway HTTP APIs](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api.html)
- [CloudFront Signed URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-urls.html)
- [DynamoDB On-Demand Mode](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadWriteCapacityMode.html)
- [SQS Event Source Mapping](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)

**Neon Documentation**:
- [Neon Serverless Driver](https://neon.tech/docs/serverless/serverless-driver)
- [Connection Pooling](https://neon.tech/docs/connect/connection-pooling)
- [Autoscaling](https://neon.tech/docs/introduction/autoscaling)

**Better Auth**:
- [Drizzle Adapter](https://www.better-auth.com/docs/adapters/drizzle)
- [Session Management](https://www.better-auth.com/docs/concepts/sessions)

**Blog Posts & Case Studies**:
- [The Economics of Serverless](https://aws.amazon.com/blogs/compute/the-economics-of-serverless/)
- [Neon + Lambda Case Study](https://neon.tech/blog/serverless-postgres-on-aws-lambda)
- [Strangler Fig Pattern](https://martinfowler.com/bliki/StranglerFigApplication.html)

### G. Change Log

| Date | Version | Changes | Author |
|------|---------|---------|--------|
| 2024-12-01 | 1.0 | Initial design document | AI Agent |
| TBD | 1.1 | Post-review updates | TBD |
| TBD | 2.0 | Phase 2 additions (video upload) | TBD |

---

**Document Status**: Draft for Review  
**Last Updated**: 2024-12-01  
**Next Review**: After requirements approval

