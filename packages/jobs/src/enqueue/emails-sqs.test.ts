/**
 * Behavioral tests for `enqueueEmailSendSqs` (Task 6.2, re-verified per
 * Task 6.7).
 *
 * Spec: .kiro/specs/ses-email-delivery
 *
 * This file started (Task 1) as an exploration baseline asserting
 * `enqueueEmailSendSqs` did NOT exist yet. Now that Task 6.2 has landed it,
 * this file is upgraded to a real behavioral test, per the file's own
 * original header comment ("re-run this file as a real behavioral test
 * instead — see Task 6.7").
 *
 * Covers:
 * - Property 1 (Async Delivery Never Blocks the Caller): the enqueue call
 *   resolves as soon as the mocked SQS `SendMessageCommand` resolves.
 * - Property 3 (Idempotency Key Prevents Duplicate Sends): two enqueue
 *   calls sharing the same `idempotencyKey` result in exactly one
 *   `SendMessageCommand` call to SQS — the second is short-circuited by
 *   the DynamoDB idempotency backstop (Task 6.1).
 *
 * Runner: Node's built-in `node:test` + `mock.module`, matching this
 * package's other tests (`idempotency.test.ts`,
 * `connection.regression.test.ts`).
 *
 * How to run:
 *   cd packages/jobs
 *   node --experimental-test-module-mocks --import tsx --test src/enqueue/emails-sqs.test.ts
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

process.env.EMAIL_QUEUE_URL = 'https://sqs.us-east-2.amazonaws.com/123456789012/classroomio-email-test';
process.env.JOB_METADATA_TABLE_NAME = 'classroomio-job-metadata-test';

let sqsSendCallCount = 0;
let fakeIdempotencyTable = new Map<string, Record<string, unknown>>();

mock.module('@aws-sdk/client-sqs', {
  namedExports: {
    SQSClient: class {
      async send() {
        sqsSendCallCount += 1;
        return { MessageId: `fake-sqs-message-id-${sqsSendCallCount}` };
      }
    },
    SendMessageCommand: class FakeSendMessageCommand {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    }
  }
});

mock.module('@aws-sdk/client-dynamodb', {
  namedExports: {
    DynamoDBClient: class {}
  }
});

mock.module('@aws-sdk/lib-dynamodb', {
  namedExports: {
    DynamoDBDocumentClient: {
      from: () => ({
        send: async (command: { constructor: { name: string }; input?: any }) => {
          if (command.constructor.name === 'FakeGetCommand') {
            return { Item: fakeIdempotencyTable.get(command.input.Key.job_id) };
          }
          if (command.constructor.name === 'FakePutCommand') {
            fakeIdempotencyTable.set(command.input.Item.job_id, command.input.Item);
            return {};
          }
          throw new Error(`Unexpected command: ${command.constructor.name}`);
        }
      })
    },
    GetCommand: class FakeGetCommand {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    },
    PutCommand: class FakePutCommand {
      input: any;
      constructor(input: any) {
        this.input = input;
      }
    }
  }
});

let enqueueEmailSendSqs: typeof import('./emails').enqueueEmailSendSqs;
let EmailQueueNotConfiguredError: typeof import('./emails').EmailQueueNotConfiguredError;

before(async () => {
  const mod = await import('./emails');
  enqueueEmailSendSqs = mod.enqueueEmailSendSqs;
  EmailQueueNotConfiguredError = mod.EmailQueueNotConfiguredError;
});

beforeEach(() => {
  sqsSendCallCount = 0;
  fakeIdempotencyTable = new Map();
});

const TEMPLATE_PAYLOAD = {
  kind: 'template' as const,
  template: 'welcome',
  to: 'student@example.com',
  fields: { name: 'Jane Learner' }
};

describe('enqueueEmailSendSqs', () => {
  it('Property 1: resolves with a message id after the mocked SQS send resolves', async () => {
    const messageId = await enqueueEmailSendSqs(TEMPLATE_PAYLOAD);

    assert.equal(sqsSendCallCount, 1);
    assert.equal(messageId, 'fake-sqs-message-id-1');
  });

  it('Property 3: two enqueue calls sharing an idempotencyKey result in exactly one SQS send', async () => {
    const firstId = await enqueueEmailSendSqs(TEMPLATE_PAYLOAD, { idempotencyKey: 'welcome:user-1' });
    const secondId = await enqueueEmailSendSqs(TEMPLATE_PAYLOAD, { idempotencyKey: 'welcome:user-1' });

    assert.equal(sqsSendCallCount, 1, 'SQS SendMessageCommand should only be called once for the duplicate key');
    assert.equal(firstId, 'fake-sqs-message-id-1');
    assert.equal(
      secondId,
      'welcome:user-1',
      'the second call should short-circuit and return the idempotency key itself'
    );
  });

  it('enqueues normally (no dedup) when no idempotencyKey is provided', async () => {
    await enqueueEmailSendSqs(TEMPLATE_PAYLOAD);
    await enqueueEmailSendSqs(TEMPLATE_PAYLOAD);

    assert.equal(sqsSendCallCount, 2);
  });

  it('different idempotencyKeys do not collide', async () => {
    await enqueueEmailSendSqs(TEMPLATE_PAYLOAD, { idempotencyKey: 'welcome:user-1' });
    await enqueueEmailSendSqs(TEMPLATE_PAYLOAD, { idempotencyKey: 'welcome:user-2' });

    assert.equal(sqsSendCallCount, 2);
  });

  it('throws EmailQueueNotConfiguredError when EMAIL_QUEUE_URL is unset', async () => {
    const original = process.env.EMAIL_QUEUE_URL;
    delete process.env.EMAIL_QUEUE_URL;

    try {
      await assert.rejects(() => enqueueEmailSendSqs(TEMPLATE_PAYLOAD), EmailQueueNotConfiguredError);
    } finally {
      process.env.EMAIL_QUEUE_URL = original;
    }
  });
});
