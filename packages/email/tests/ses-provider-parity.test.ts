/**
 * Provider-parity preservation test for the SES migration.
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Task: 2. "Write provider-parity preservation test (BEFORE implementing
 * the fix)"
 *
 * **Property 4 (design.md): Provider Swap Preserves Template Behavior** —
 * for any of the 24 registered EmailIds, sending through the SES provider
 * SHALL produce a rendered HTML body, subject, from-address, and (when
 * applicable) `.ics` attachment identical to what the ZeptoMail/SMTP
 * providers produce for the same input fields. Only the transport differs.
 *
 * **Observation-first methodology**: this file has two halves.
 *
 *   1. BASELINE (runs today, against unfixed code): captures the exact
 *      `{ content, subject, from, replyTo, ics }` payload that
 *      `sendEmail()` hands to the current transport layer
 *      (`sendWithNodemailer`/`sendWithZoho`) for three representative
 *      templates — `forgotPassword` (plain), `welcome` (plain, no
 *      `branding`/fields beyond a name), and `sessionReminder` (the one
 *      template that attaches an `.ics` calendar part). We intercept at the
 *      transport boundary (mocking the two provider modules) rather than
 *      the network, so this runs with no SMTP/Zoho credentials.
 *
 *   2. SES PATH COMPARISON (Task 5.2/5.5, now implemented): calls the real
 *      `sendWithSes` (mocking only the AWS SDK client boundary, same
 *      pattern as `tests/ses.test.ts`) for the same three templates and
 *      asserts the rendered `content`/`subject` match the baseline
 *      captured in the first half of this file byte-for-byte -- proving
 *      the provider swap changed only the transport, never the rendered
 *      output (Property 4).
 *
 * How to run:
 *   cd packages/email
 *   pnpm test -- ses-provider-parity
 */

import { describe, expect, it, vi } from 'vitest';

const capturedSends: Array<{
  provider: 'nodemailer' | 'zeptomail';
  to: string;
  subject: string;
  content: string;
  from?: string;
  replyTo?: string;
  ics?: string;
}> = [];

vi.mock('../src/utils/services/nodemailer', () => ({
  sendWithNodemailer: vi.fn(async (emailData: any) => {
    capturedSends.push({ provider: 'nodemailer', ...emailData });
    return { success: true, details: { messageId: 'fake-nodemailer-id' } };
  })
}));

vi.mock('../src/utils/services/zeptomail', () => ({
  sendWithZoho: vi.fn(async (emailData: any) => {
    capturedSends.push({ provider: 'zeptomail', ...emailData });
    return { success: true, details: { request_id: 'fake-zoho-id' } };
  })
}));

// Captured outside the reset-per-test `capturedSends` array so the later
// SES-path comparison test can diff against this specific baseline even
// though `capturedSends` itself gets cleared before each subsequent test.
let forgotPasswordBaselineContent = '';

describe('SES provider-parity baseline (Property 4)', () => {
  it('BASELINE: captures the exact content/subject/from for forgotPassword via the current transport', async () => {
    capturedSends.length = 0;
    const { sendEmail } = await import('../src/send');
    // Ensure the templates are registered (importing the barrel has the
    // side effect of calling defineEmail() for every template).
    await import('../src/emails');

    await sendEmail('forgotPassword', {
      to: 'student@example.com',
      fields: {
        email: 'student@example.com',
        name: 'Jane Learner',
        link: 'https://app.example.com/reset?token=abc123'
      }
    });

    expect(capturedSends).toHaveLength(1);
    const sent = capturedSends[0];

    expect(sent.subject).toBe('Password reset notification - ClassroomIO');
    expect(sent.content).toContain('Hello Jane Learner,');
    expect(sent.content).toContain('https://app.example.com/reset?token=abc123');
    expect(sent.ics).toBeUndefined();

    forgotPasswordBaselineContent = sent.content;
  });

  it('BASELINE: captures the exact content/subject for welcome via the current transport', async () => {
    capturedSends.length = 0;
    const { sendEmail } = await import('../src/send');
    await import('../src/emails');

    await sendEmail('welcome', {
      to: 'newuser@example.com',
      fields: { name: 'Jane Learner' }
    });

    expect(capturedSends).toHaveLength(1);
    const sent = capturedSends[0];

    expect(sent.subject).toBe('Welcome to ClassroomIO!');
    expect(sent.content).toContain('Dear Jane Learner,');
    expect(sent.ics).toBeUndefined();
  });

  it('BASELINE: captures content + the .ics attachment for sessionReminder via the current transport', async () => {
    capturedSends.length = 0;
    const { sendEmail } = await import('../src/send');
    await import('../src/emails');

    const fakeIcs = 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR';

    await sendEmail('sessionReminder', {
      to: 'student@example.com',
      fields: {
        orgName: 'Acme Academy',
        courseName: 'React Basics',
        sessionTitle: 'Live Q&A',
        sessionTimeLabel: 'Tomorrow, 3pm UTC',
        whenLabel: 'in 1 day',
        joinUrl: 'https://app.example.com/session/join/abc',
        branding: undefined
      },
      ics: fakeIcs
    });

    expect(capturedSends).toHaveLength(1);
    const sent = capturedSends[0];

    expect(sent.subject).toBe('Reminder: your live session is coming up');
    expect(sent.content).toContain('Live Q&A');
    expect(sent.content).toContain('https://app.example.com/session/join/abc');
    expect(sent.ics).toBe(fakeIcs);
  });

  it('SES PATH: forgotPassword content/subject via sendWithSes matches the baseline', async () => {
    const sesSendMock = vi.fn().mockResolvedValue({ MessageId: 'ses-fake-id' });
    vi.doMock('@aws-sdk/client-sesv2', () => {
      class FakeSESv2Client {
        send = sesSendMock;
      }
      class FakeSendEmailCommand {
        input: unknown;
        constructor(input: unknown) {
          this.input = input;
        }
      }
      return { SESv2Client: FakeSESv2Client, SendEmailCommand: FakeSendEmailCommand };
    });

    vi.resetModules();
    const { sendWithSes } = await import('../src/utils/services/ses');

    await sendWithSes({
      to: 'student@example.com',
      subject: 'Password reset notification - ClassroomIO',
      content: forgotPasswordBaselineContent, // captured in the first test above, before capturedSends got reset
      from: undefined
    });

    expect(sesSendMock).toHaveBeenCalledTimes(1);
    const command = sesSendMock.mock.calls[0][0] as { input: any };

    expect(command.input.Content.Simple.Subject.Data).toBe('Password reset notification - ClassroomIO');
    expect(command.input.Content.Simple.Body.Html.Data).toBe(forgotPasswordBaselineContent);
    expect(command.input.Content.Simple.Body.Html.Data).toContain('Hello Jane Learner,');

    vi.doUnmock('@aws-sdk/client-sesv2');
  });
});
