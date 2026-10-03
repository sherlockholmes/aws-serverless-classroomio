/**
 * Unit tests for `sendWithSes` (Task 5.2/5.5).
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Mocks the AWS SDK SES clients so no real network/credentials are needed.
 */

import { describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('@aws-sdk/client-sesv2', () => {
  class FakeSESv2Client {
    send = sendMock;
  }
  class FakeSendEmailCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { SESv2Client: FakeSESv2Client, SendEmailCommand: FakeSendEmailCommand };
});

vi.mock('@aws-sdk/client-ses', () => {
  class FakeSESClient {
    send = sendMock;
  }
  class FakeSendRawEmailCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { SESClient: FakeSESClient, SendRawEmailCommand: FakeSendRawEmailCommand };
});

describe('sendWithSes', () => {
  it('uses SendEmailCommand (simple send) when there is no .ics body', async () => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ MessageId: 'simple-message-id' });

    const { sendWithSes } = await import('../src/utils/services/ses');

    const result = await sendWithSes({
      to: 'student@example.com',
      subject: 'Test subject',
      content: '<p>Hello</p>',
      from: '"ClassroomIO" <notify@example.com>'
    });

    expect(result.success).toBe(true);
    expect((result.details as { messageId: string }).messageId).toBe('simple-message-id');
    expect(sendMock).toHaveBeenCalledTimes(1);

    const command = sendMock.mock.calls[0][0] as { input: any };
    expect(command.input.Destination.ToAddresses).toEqual(['student@example.com']);
    expect(command.input.Content.Simple.Subject.Data).toBe('Test subject');
    expect(command.input.Content.Simple.Body.Html.Data).toBe('<p>Hello</p>');
  });

  it('uses SendRawEmailCommand (raw MIME) with the .ics part when an .ics body is present', async () => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ MessageId: 'raw-message-id' });

    const { sendWithSes } = await import('../src/utils/services/ses');

    const fakeIcs = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';

    const result = await sendWithSes({
      to: 'student@example.com',
      subject: 'Session reminder',
      content: '<p>Your session starts soon</p>',
      from: '"ClassroomIO" <notify@example.com>',
      ics: fakeIcs
    });

    expect(result.success).toBe(true);
    expect((result.details as { messageId: string }).messageId).toBe('raw-message-id');
    expect(sendMock).toHaveBeenCalledTimes(1);

    const command = sendMock.mock.calls[0][0] as { input: any };
    expect(command.input.Destinations).toEqual(['student@example.com']);

    const rawBytes = command.input.RawMessage.Data as Uint8Array;
    const rawText = new TextDecoder().decode(rawBytes);

    expect(rawText).toContain('Content-Type: text/calendar; method=PUBLISH; name="session.ics"');
    expect(rawText).toContain('Content-Disposition: attachment; filename="session.ics"');
    expect(rawText).toContain('BEGIN:VCALENDAR');
    expect(rawText).toContain('Content-Type: text/html; charset=UTF-8');
    expect(rawText).toContain('<p>Your session starts soon</p>');
    expect(rawText).toContain('Subject: Session reminder');
  });

  it('returns a failure EmailResponse (not a throw) when SES rejects the send', async () => {
    sendMock.mockReset();
    sendMock.mockRejectedValue(Object.assign(new Error('Email address is not verified'), { name: 'MessageRejected' }));

    const { sendWithSes } = await import('../src/utils/services/ses');

    const result = await sendWithSes({
      to: 'unverified@example.com',
      subject: 'Test',
      content: '<p>Hi</p>'
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not verified');
  });
});

describe('isRetryableSesError', () => {
  it('classifies throttling-style errors as retryable', async () => {
    const { isRetryableSesError } = await import('../src/utils/services/ses');

    expect(isRetryableSesError(Object.assign(new Error('rate exceeded'), { name: 'ThrottlingException' }))).toBe(true);
    expect(isRetryableSesError(Object.assign(new Error('too many'), { name: 'TooManyRequestsException' }))).toBe(true);
  });

  it('classifies MessageRejected and validation errors as permanent (not retryable)', async () => {
    const { isRetryableSesError } = await import('../src/utils/services/ses');

    expect(isRetryableSesError(Object.assign(new Error('rejected'), { name: 'MessageRejected' }))).toBe(false);
    expect(isRetryableSesError(new Error('plain error, no name property override'))).toBe(false);
    expect(isRetryableSesError(null)).toBe(false);
    expect(isRetryableSesError('a string, not an error object')).toBe(false);
  });
});
