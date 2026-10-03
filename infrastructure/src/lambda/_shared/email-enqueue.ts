/**
 * Shared SQS email enqueue helper for native Lambda handlers.
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Task: 7.1 "Add a shared SQS-enqueue helper under
 * infrastructure/src/lambda/_shared/email-enqueue.ts"
 *
 * Native Lambda bundles under infrastructure/src/lambda/ can't import
 * `apps/api`'s `@api/services/jobs` alias (that alias only resolves inside
 * the apps/api TypeScript project). This module is the equivalent for
 * these standalone bundles: it validates the payload shape against
 * `ZSendTemplateEmailPayload` (imported from `@cio/jobs/payloads`, the same
 * folder-level subpath already proven to resolve via esbuild in
 * `email-worker`) and sends it to the Email_Queue via SQS directly,
 * mirroring `packages/jobs/src/enqueue/emails.ts`'s `enqueueEmailSendSqs`
 * but without pulling in that package's `bullmq`/`ioredis` dependencies
 * (this only imports `@aws-sdk/client-sqs` + the payload schema).
 *
 * Callers (organization-team-handler, onboarding-handler,
 * organization-audience-handler — Tasks 7.2-7.4) build the exact field
 * shape their real apps/api service would have built (read from the
 * corresponding apps/api/src/services/*.ts file), then call
 * `enqueueTemplateEmail(...)` here. No idempotency-key backstop is wired
 * here deliberately — these are one-shot user-triggered actions (send an
 * invite, complete onboarding), not the kind of retryable background job
 * that risks double-enqueueing on retry the way apps/api's queue-based
 * flows do; if that changes, promote this to also import
 * `@cio/jobs/enqueue`'s idempotency helpers.
 */

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ZSendTemplateEmailPayload, type TSendTemplateEmailPayload } from '@cio/jobs/payloads';

let sqsClient: SQSClient | undefined;

function getSqsClient(): SQSClient {
  if (!sqsClient) {
    sqsClient = new SQSClient({});
  }
  return sqsClient;
}

export class EmailQueueNotConfiguredError extends Error {
  constructor() {
    super(
      'EMAIL_QUEUE_URL is not set on this Lambda. Add it to the environment block in ' +
        'infrastructure/lib/stacks/api-stack.ts for this function.'
    );
    this.name = 'EmailQueueNotConfiguredError';
  }
}

/**
 * Enqueues a registered `@cio/email` template send via SQS.
 *
 * Validates the payload against `ZSendTemplateEmailPayload` up front so a
 * malformed call fails loudly in the calling handler rather than silently
 * inside `email-worker`. Returns the SQS `MessageId` on success.
 */
export async function enqueueTemplateEmail(payload: TSendTemplateEmailPayload): Promise<string | undefined> {
  const queueUrl = process.env.EMAIL_QUEUE_URL;
  if (!queueUrl) {
    throw new EmailQueueNotConfiguredError();
  }

  const validated = ZSendTemplateEmailPayload.parse(payload);

  const result = await getSqsClient().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(validated)
    })
  );

  return result.MessageId;
}
