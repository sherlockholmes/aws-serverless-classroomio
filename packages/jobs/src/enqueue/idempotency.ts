import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Idempotency backstop for the SQS-backed email enqueue path, using the
 * existing `classroomio-job-metadata-{env}` DynamoDB table (already
 * provisioned in `infrastructure/lib/stacks/queue-stack.ts`).
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Task: 6.1 "Implement the idempotency backstop against the existing
 * job-metadata DynamoDB table"
 * Design: Decision 6 "Standard SQS queue, not FIFO" — SQS FIFO's 5-minute
 * dedup window is too short to replace BullMQ's `jobId` dedup semantics
 * (effectively indefinite until the job is processed), so idempotency is
 * enforced here instead, against a table that already exists and already
 * has a TTL mechanism.
 *
 * A new `job_type = 'email-idempotency'` partition is used so these
 * records never collide with whatever other job types write to this table
 * (e.g. transcoding jobs use `job_id` as the natural key; here the
 * caller-supplied `idempotencyKey`, e.g. `welcome:<userId>`, is the key).
 *
 * Deliberately NOT imported from `packages/jobs`' main barrel
 * (`src/index.ts`) — only from `./emails.ts` directly — so that Lambda
 * bundles which only need the SQS enqueue path (like `email-worker` and
 * the native Lambda handlers in Task 7) never pull in `bullmq`/`ioredis`
 * (see `connection.ts`), which this module has no dependency on.
 */

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h — well within the table's existing 7-day TTL config

let documentClient: DynamoDBDocumentClient | undefined;

function getDocumentClient(): DynamoDBDocumentClient {
  if (!documentClient) {
    documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }
  return documentClient;
}

function resolveTableName(): string {
  const tableName = process.env.JOB_METADATA_TABLE_NAME;
  if (!tableName) {
    throw new Error(
      'JOB_METADATA_TABLE_NAME is not set. Set it to the classroomio-job-metadata-{env} DynamoDB table name.'
    );
  }
  return tableName;
}

/**
 * Returns true if this idempotency key was already recorded as enqueued
 * (and not yet expired). Fails OPEN (returns false, i.e. "not yet
 * enqueued") on any DynamoDB error — per design.md's Error Handling
 * section, a duplicate email is preferable to blocking all email sends
 * because a lookup table hiccuped.
 */
export async function wasAlreadyEnqueued(idempotencyKey: string): Promise<boolean> {
  try {
    const result = await getDocumentClient().send(
      new GetCommand({
        TableName: resolveTableName(),
        Key: {
          job_id: `email-idempotency:${idempotencyKey}`
        }
      })
    );

    return Boolean(result.Item);
  } catch (error) {
    console.error('wasAlreadyEnqueued error (failing open):', error);
    return false;
  }
}

/**
 * Records that this idempotency key has been enqueued, with a 24h TTL.
 * Best-effort — swallows errors (logging only) rather than throwing, since
 * a failure to record must not prevent the email itself from being sent
 * (fail open, same rationale as `wasAlreadyEnqueued`).
 */
export async function recordEnqueued(idempotencyKey: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  try {
    await getDocumentClient().send(
      new PutCommand({
        TableName: resolveTableName(),
        Item: {
          job_id: `email-idempotency:${idempotencyKey}`,
          job_type: 'email-idempotency',
          status: 'enqueued',
          created_at: new Date().toISOString(),
          ttl: nowSeconds + ttlSeconds
        }
      })
    );
  } catch (error) {
    console.error('recordEnqueued error (best-effort, not rethrown):', error);
  }
}
