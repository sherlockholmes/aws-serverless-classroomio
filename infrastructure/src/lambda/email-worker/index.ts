/**
 * email-worker — SQS-triggered Lambda that delivers queued emails via SES.
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Task: 6.4 "Create infrastructure/src/lambda/email-worker/index.ts"
 * Design: Components § infrastructure/src/lambda/email-worker/index.ts
 *
 * NOT behind API Gateway — this Lambda is triggered by an SQS event source
 * mapping (Task 6.5), so its handler signature is `SQSEvent ->
 * SQSBatchResponse`, not the `APIGatewayProxyEventV2` shape every other
 * handler in this directory uses.
 *
 * Ports `apps/jobs/src/processors/emails/send.ts`'s `processSendEmail`
 * logic (parse `ZSendEmailPayload`, dispatch to `sendEmail`/`deliverEmail`
 * from `@cio/email`) into this standalone Lambda-native form. Uses SQS's
 * partial-batch-failure feature (`batchItemFailures` in the response) so
 * one bad message in a batch doesn't force the whole batch to retry —
 * see https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#services-sqs-batchfailurereporting
 *
 * Error classification (design.md § Error Handling):
 * - Retryable (SES throttling, transient AWS errors): included in
 *   `batchItemFailures` so SQS's redrive policy retries it (up to 3
 *   attempts per queue-stack.ts, then DLQ).
 * - Permanent (`MessageRejected`, schema validation failure): logged with
 *   a `sendFailedPermanently` marker and NOT included in
 *   `batchItemFailures` — the message is acked/deleted since retrying
 *   would never succeed. The CloudWatch alarm in Task 4.2 watches DLQ
 *   depth, not this log marker directly, but the marker is what an
 *   operator greps for when triaging why a specific email never arrived.
 *
 * Bundling note: this bundle resolves `@cio/email`, `@cio/jobs/payloads`
 * (folder-level subpath, per the established esbuild resolution rule —
 * see AGENTS.md's recurring-bug-pattern note in this spec's memory) and
 * `@cio/db/queries/notifications` (also folder-level). Verified via real
 * esbuild bundling, not just `tsc --noEmit` (this directory's tsconfig.json
 * doesn't even include `src/lambda/**`, so `tsc` never type-checks this
 * file at all — esbuild is the only real verification).
 */

import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { deliverEmail, isRetryableSesError, sendEmail, type EmailId } from '@cio/email';
import { ZSendEmailPayload } from '@cio/jobs/payloads';

interface SesResponseLike {
  success: boolean;
  error?: string;
  details?: unknown;
}

function extractProviderId(responses: readonly SesResponseLike[]): string {
  for (const response of responses) {
    const details = response.details as { messageId?: string } | undefined;
    if (details?.messageId) {
      return details.messageId;
    }
  }
  return '';
}

/**
 * Processes a single SQS record's email payload. Throws a retryable error
 * (caller adds it to `batchItemFailures`) or logs-and-swallows a permanent
 * one, mirroring `apps/jobs`' `processSendEmail` but Lambda-native.
 */
async function processRecord(record: SQSRecord): Promise<void> {
  const rawPayload = JSON.parse(record.body);
  const payload = ZSendEmailPayload.parse(rawPayload);

  try {
    const responses =
      payload.kind === 'template'
        ? await sendEmail(payload.template as EmailId, {
            to: payload.to,
            fields: payload.fields as never,
            from: payload.from,
            replyTo: payload.replyTo,
            subject: payload.subject,
            ics: payload.ics
          })
        : await deliverEmail([
            {
              to: payload.to,
              subject: payload.subject,
              content: payload.content,
              from: payload.from,
              replyTo: payload.replyTo
            }
          ]);

    const failed = responses.find((response) => !response.success);
    if (failed) {
      throw Object.assign(new Error(failed.error ?? 'email provider returned an unsuccessful response'), {
        name: (failed.details as { name?: string } | undefined)?.name ?? 'EmailDeliveryError'
      });
    }

    const providerId = extractProviderId(responses);
    console.log('email-worker: sent', {
      messageId: record.messageId,
      kind: payload.kind,
      template: payload.kind === 'template' ? payload.template : undefined,
      providerId
    });
  } catch (error) {
    if (isRetryableSesError(error)) {
      console.error('email-worker: retryable failure', { messageId: record.messageId, error });
      throw error;
    }

    // Permanent failure: log distinctly and swallow — retrying would never
    // succeed (bad identity, unverified recipient, malformed content).
    console.error('email-worker: sendFailedPermanently', {
      messageId: record.messageId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      await processRecord(record);
    } catch (error) {
      console.error('email-worker: unhandled failure, marking for retry', {
        messageId: record.messageId,
        error
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
