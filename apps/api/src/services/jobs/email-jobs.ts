import { enqueueEmailSend, enqueueEmailSendSqs, isEmailQueueConfigured, isRedisConfigured } from '@cio/jobs';
import type { TSendEmailPayload } from '@cio/jobs';
import { EmailRegistry, type EmailId, type EmailSchemaFor } from '@cio/email';
import { EmailPreferenceLookupCache } from '@cio/db/queries/notifications';
import * as z from 'zod';

import { logRedisUnavailableOnce } from '@cio/core/utils/redis/redis';

type Recipient = string | string[];

interface CommonOptions {
  /**
   * Stable key used as BullMQ `jobId` for idempotent enqueue (e.g.
   * `welcome:<userId>`). When omitted the job gets an auto-generated id, so
   * duplicate calls produce duplicate emails.
   */
  idempotencyKey?: string;
}

export interface EnqueueTemplateEmailInput<TId extends EmailId> extends CommonOptions {
  to: Recipient;
  fields: z.infer<EmailSchemaFor<TId>>;
  from?: string;
  replyTo?: string;
  /** Override the template's default subject (e.g. org-scoped transactional mail). */
  subject?: string;
  /** Optional iCalendar (.ics) body attached as a text/calendar part. */
  ics?: string;
  preference?: {
    organizationId?: string;
    recipientProfileId?: string;
  };
}

export interface EnqueueRawEmailInput extends CommonOptions {
  to: Recipient;
  subject: string;
  content: string;
  from?: string;
  replyTo?: string;
}

export interface EnqueueResult {
  /** BullMQ job ids — one per recipient. */
  jobIds: string[];
}

function toRecipientArray(to: Recipient): string[] {
  return Array.isArray(to) ? to : [to];
}

function recipientKey(base: string | undefined, recipient: string, total: number): string | undefined {
  if (!base) return undefined;

  return total === 1 ? base : `${base}:${recipient}`;
}

/**
 * Dispatches to the transport selected by env presence.
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Task: 6.3 "Update apps/api/src/services/jobs/email-jobs.ts to select
 * transport"
 *
 * `EMAIL_QUEUE_URL` set -> SQS (AWS production path, Task 6.2's
 * `enqueueEmailSendSqs`). Otherwise falls back to the existing
 * `isRedisConfigured()` / BullMQ path for local dev parity (Requirement 7),
 * unchanged from before this task. Neither configured -> the existing
 * no-op-with-warning behavior, also unchanged.
 *
 * `enqueueTransactionalEmail`/`enqueueRawEmail`'s exported signatures are
 * untouched by this change — every one of their ~15 call sites across
 * `apps/api` keeps compiling without modification.
 */
async function enqueueViaResolvedTransport(
  payload: TSendEmailPayload,
  options: { idempotencyKey?: string }
): Promise<string | undefined> {
  if (isEmailQueueConfigured()) {
    return enqueueEmailSendSqs(payload, options);
  }

  if (isRedisConfigured()) {
    return enqueueEmailSend(payload, options);
  }

  logRedisUnavailableOnce('Redis not configured: emails not enqueued. Set REDIS_URL and run apps/jobs to send them.');
  return undefined;
}

/**
 * Fire-and-forget enqueue of a registered template email. Validates `fields`
 * against the template's Zod schema up front so bad payloads fail in the
 * domain handler instead of silently inside the worker.
 *
 * **Link fields** (`courseUrl`, `autoEnrollUrl`, `loginUrl`, `inviteUrl`, etc.)
 * must be built by the caller before enqueueing. Use `getAppBaseUrl()` for
 * teacher/tutor/admin dashboard links and `getDashboardBaseUrl(org)` for
 * student/learner links — see `packages/email/README.md` § Email link URLs.
 *
 * BullMQ tracks send state, retries, and failure history — no DB ledger is
 * written. Final failures are recorded in `dead_letter_job` by the worker
 * for operator triage.
 */
export async function enqueueTransactionalEmail<TId extends EmailId>(
  template: TId,
  input: EnqueueTemplateEmailInput<TId>
): Promise<EnqueueResult> {
  const definition = EmailRegistry.get(template);
  if (!definition) {
    throw new Error(`Email template "${template}" is not registered`);
  }

  const validatedFields = definition.schema.parse(input.fields) as Record<string, unknown>;

  const recipients = toRecipientArray(input.to);
  const jobIds: string[] = [];
  const preferenceCache = input.preference ? new EmailPreferenceLookupCache() : null;

  for (const recipient of recipients) {
    if (preferenceCache && input.preference) {
      const allowed = await preferenceCache.shouldSend({
        emailId: template,
        organizationId: input.preference.organizationId,
        recipientEmail: recipient,
        recipientProfileId: input.preference.recipientProfileId
      });

      if (!allowed) {
        continue;
      }
    }

    const jobId = await enqueueViaResolvedTransport(
      {
        kind: 'template',
        template,
        to: recipient,
        fields: validatedFields,
        from: input.from,
        replyTo: input.replyTo,
        subject: input.subject,
        ics: input.ics
      },
      { idempotencyKey: recipientKey(input.idempotencyKey, recipient, recipients.length) }
    );

    if (jobId) jobIds.push(jobId);
  }

  return { jobIds };
}

/**
 * Fire-and-forget enqueue of a free-form subject/content email — used by the
 * public mail route and submission notifications that don't have a registered
 * template.
 */
export async function enqueueRawEmail(input: EnqueueRawEmailInput): Promise<EnqueueResult> {
  const recipients = toRecipientArray(input.to);
  const jobIds: string[] = [];

  for (const recipient of recipients) {
    const jobId = await enqueueViaResolvedTransport(
      {
        kind: 'raw',
        to: recipient,
        subject: input.subject,
        content: input.content,
        from: input.from,
        replyTo: input.replyTo
      },
      { idempotencyKey: recipientKey(input.idempotencyKey, recipient, recipients.length) }
    );

    if (jobId) jobIds.push(jobId);
  }

  return { jobIds };
}
