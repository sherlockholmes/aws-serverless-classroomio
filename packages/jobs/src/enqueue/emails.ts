import type { JobsOptions } from 'bullmq';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import { JOB_NAMES, QUEUE_NAMES } from '../queues/names';
import { QUEUE_DEFAULTS } from '../queues/defaults';
import { getQueue } from '../queues/factories';
import type { TSendEmailPayload } from '../payloads/emails';
import { recordEnqueued, wasAlreadyEnqueued } from './idempotency';

/**
 * BullMQ rejects `:` in custom job ids (it uses `:` as a separator in its
 * Redis key scheme). Callers tend to pass keys like `welcome:<userId>` for
 * readability, so we normalize the boundary here instead of forcing every
 * caller to remember.
 */
function toJobId(idempotencyKey: string): string {
  return `email-${idempotencyKey.replace(/:/g, '-')}`;
}

/**
 * Enqueue a single `emails:send` job. BullMQ deduplicates on `jobId`, so
 * pass an `idempotencyKey` (e.g. `welcome:<userId>`) when the same domain
 * action might fire more than once.
 *
 * Local-dev / BullMQ path only — see `enqueueEmailSendSqs` for the AWS
 * production path.
 */
export async function enqueueEmailSend(
  payload: TSendEmailPayload,
  options: { idempotencyKey?: string } & JobsOptions = {}
): Promise<string | undefined> {
  const { idempotencyKey, ...jobOptions } = options;

  const job = await getQueue(QUEUE_NAMES.emails).add(JOB_NAMES.emails.send, payload, {
    ...QUEUE_DEFAULTS[QUEUE_NAMES.emails],
    ...(idempotencyKey ? { jobId: toJobId(idempotencyKey) } : {}),
    ...jobOptions
  });

  return job.id;
}

/**
 * Thrown by `enqueueEmailSendSqs` when `EMAIL_QUEUE_URL` is not set.
 * Mirrors `RedisNotConfiguredError` in `../connection.ts` — fail loudly
 * rather than silently dropping the send.
 */
export class EmailQueueNotConfiguredError extends Error {
  constructor() {
    super(
      'EMAIL_QUEUE_URL is not set. The SQS-backed email path requires it to point at the ' +
        'classroomio-email-{env} queue provisioned in infrastructure/lib/stacks/queue-stack.ts.'
    );
    this.name = 'EmailQueueNotConfiguredError';
  }
}

let sqsClient: SQSClient | undefined;

function getSqsClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

/**
 * Returns true when `EMAIL_QUEUE_URL` is set. Mirrors `isRedisConfigured`
 * for the SQS path — useful for the transport-selecting wrapper in
 * `apps/api/src/services/jobs/email-jobs.ts` (Task 6.3).
 */
export function isEmailQueueConfigured(): boolean {
  return Boolean(process.env.EMAIL_QUEUE_URL);
}

/**
 * Enqueue a single email send via SQS — the AWS production path.
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Task: 6.2 "Implement enqueueEmailSendSqs in
 * packages/jobs/src/enqueue/emails.ts"
 * Design: Decision 2 "New enqueue path lives in packages/jobs, gated by
 * transport" / Decision 6 "Standard SQS queue, not FIFO"
 *
 * Unlike BullMQ's `jobId`-based dedup, SQS standard queues have no built-in
 * dedup — idempotency is enforced via the DynamoDB backstop in
 * `./idempotency.ts` (Task 6.1) before the message is ever sent to SQS.
 *
 * Returns the caller-supplied idempotency key (not a fresh SQS message id)
 * when a duplicate is detected and skipped, so callers get a stable,
 * predictable return value either way — mirroring `enqueueEmailSend`'s
 * "returns an id" contract closely enough for the transport-selecting
 * wrapper in Task 6.3 to not need special-casing.
 */
export async function enqueueEmailSendSqs(
  payload: TSendEmailPayload,
  options: { idempotencyKey?: string } = {}
): Promise<string | undefined> {
  const queueUrl = process.env.EMAIL_QUEUE_URL;
  if (!queueUrl) {
    throw new EmailQueueNotConfiguredError();
  }

  const { idempotencyKey } = options;

  if (idempotencyKey && (await wasAlreadyEnqueued(idempotencyKey))) {
    return idempotencyKey;
  }

  const result = await getSqsClient().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
      ...(idempotencyKey
        ? {
            MessageAttributes: {
              idempotencyKey: { DataType: 'String', StringValue: idempotencyKey }
            }
          }
        : {})
    })
  );

  if (idempotencyKey) {
    await recordEnqueued(idempotencyKey);
  }

  return result.MessageId;
}
