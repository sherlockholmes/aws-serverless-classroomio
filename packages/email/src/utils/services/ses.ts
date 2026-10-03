import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { SESClient as SESv1Client, SendRawEmailCommand } from '@aws-sdk/client-ses';

import { EmailResponse } from '../types';
import type { TEmailData } from '@cio/utils/validation/mail';
import { env } from '../../config/env';
import { EMAIL_FROM } from '../constants';
import { extractNameAndEmail } from '../functions/email-helpers';

/**
 * Amazon SES email provider.
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Task: 5.2 "Implement packages/email/src/utils/services/ses.ts"
 * Design: Decision 5 "Raw SES send (not simple SendEmail) for
 * calendar-attachment templates only"
 *
 * Two SDK clients are used deliberately:
 * - `@aws-sdk/client-sesv2`'s `SendEmailCommand` for the simple HTML-only
 *   case (no `.ics` attachment) — SESv2's simple send API.
 * - `@aws-sdk/client-ses` (v1) `SendRawEmailCommand` for the `.ics`
 *   attachment case — SESv2's `SendEmail` simple API has no attachment
 *   mechanism beyond templated-email attachments, so a hand-built MIME
 *   multipart message via the v1 raw-send API is required, mirroring how
 *   `zeptomail.ts` branches on `ics` presence for its own attachment API.
 *
 * Both clients pick up credentials/region from the Lambda execution
 * environment automatically (IAM role, not static keys — see
 * Requirement 4.3) via the SDK's default credential provider chain.
 */

let sesv2Client: SESv2Client | undefined;
let sesv1Client: SESv1Client | undefined;

function getSesV2Client(): SESv2Client {
  if (!sesv2Client) {
    sesv2Client = new SESv2Client({});
  }
  return sesv2Client;
}

function getSesV1Client(): SESv1Client {
  if (!sesv1Client) {
    sesv1Client = new SESv1Client({});
  }
  return sesv1Client;
}

/**
 * SES error codes that indicate a transient failure the caller should
 * retry (e.g. via the SQS redrive policy in `email-worker`), as opposed to
 * a permanent failure (bad identity, unverified recipient in sandbox mode,
 * malformed content) that retrying will never fix.
 *
 * Spec Requirement 2.4: IF the Email_Worker receives a throttling response
 * from SES, THE Email_Worker SHALL retry with backoff rather than dropping
 * the message.
 */
const RETRYABLE_SES_ERROR_NAMES = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'InternalServiceErrorException'
]);

export function isRetryableSesError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const name = (error as { name?: string }).name;
  return typeof name === 'string' && RETRYABLE_SES_ERROR_NAMES.has(name);
}

function buildFromEmailAddress(from?: string): string {
  const fromData = extractNameAndEmail(from ?? EMAIL_FROM);
  if (!fromData?.email) {
    return from ?? EMAIL_FROM;
  }

  // SES's simple FromEmailAddress field accepts the full RFC 5322
  // "Display Name" <email> form directly, so pass through as given.
  return from ?? EMAIL_FROM;
}

async function sendSimple(emailData: TEmailData): Promise<EmailResponse> {
  const { from, to, subject, content, replyTo } = emailData;

  const input: SendEmailCommandInput = {
    FromEmailAddress: buildFromEmailAddress(from),
    Destination: { ToAddresses: [to] },
    ReplyToAddresses: replyTo ? [replyTo] : undefined,
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Html: { Data: content, Charset: 'UTF-8' } }
      }
    },
    ConfigurationSetName: env.SES_CONFIGURATION_SET_NAME
  };

  try {
    const result = await getSesV2Client().send(new SendEmailCommand(input));

    return {
      success: true,
      details: { messageId: result.MessageId }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      details: error
    };
  }
}

/** RFC 2822 CRLF line ending — required by the MIME spec, not just "\n". */
const CRLF = '\r\n';

function buildRawMimeMessage(params: {
  from: string;
  to: string;
  subject: string;
  htmlContent: string;
  replyTo?: string;
  ics: string;
}): string {
  const { from, to, subject, htmlContent, replyTo, ics } = params;
  const boundary = `----ClassroomIOBoundary${Date.now()}`;

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : undefined,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ].filter((line): line is string => Boolean(line));

  const htmlPart = [
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    htmlContent
  ].join(CRLF);

  const icsPart = [
    `--${boundary}`,
    'Content-Type: text/calendar; method=PUBLISH; name="session.ics"',
    'Content-Transfer-Encoding: 7bit',
    'Content-Disposition: attachment; filename="session.ics"',
    '',
    ics
  ].join(CRLF);

  return [headers.join(CRLF), '', htmlPart, icsPart, `--${boundary}--`, ''].join(CRLF);
}

async function sendRawWithAttachment(emailData: TEmailData): Promise<EmailResponse> {
  const { from, to, subject, content, replyTo, ics } = emailData;

  if (!ics) {
    throw new Error(
      'sendRawWithAttachment called without an ics body — this is a programming error, use sendSimple instead'
    );
  }

  const rawMessage = buildRawMimeMessage({
    from: buildFromEmailAddress(from),
    to,
    subject,
    htmlContent: content,
    replyTo,
    ics
  });

  try {
    const result = await getSesV1Client().send(
      new SendRawEmailCommand({
        Destinations: [to],
        RawMessage: { Data: new TextEncoder().encode(rawMessage) },
        ConfigurationSetName: env.SES_CONFIGURATION_SET_NAME
      })
    );

    return {
      success: true,
      details: { messageId: result.MessageId }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      details: error
    };
  }
}

/**
 * Sends a single email via Amazon SES.
 *
 * Branches to the raw MIME multipart send path when an `.ics` calendar
 * body is present (Requirement 4.5), otherwise uses SESv2's simple send
 * API (Requirement 4.4).
 */
export async function sendWithSes(emailData: TEmailData): Promise<EmailResponse> {
  if (emailData.ics) {
    return sendRawWithAttachment(emailData);
  }

  return sendSimple(emailData);
}
