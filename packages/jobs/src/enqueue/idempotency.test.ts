/**
 * Unit tests for the email idempotency backstop (Task 6.1).
 *
 * Spec: .kiro/specs/ses-email-delivery
 *
 * Runner: Node's built-in `node:test` + `mock.module` (matching the
 * `infrastructure/src/lambda/_shared/*.test.ts` convention, and this
 * package's own `connection.regression.test.ts`).
 *
 * How to run:
 *   cd packages/jobs
 *   node --experimental-test-module-mocks --require tsx/cjs --test src/enqueue/idempotency.test.ts
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

process.env.JOB_METADATA_TABLE_NAME = 'classroomio-job-metadata-test';

// In-memory fake table, keyed by the DynamoDB item's `job_id`.
let fakeTable = new Map<string, Record<string, unknown>>();
let sendCallCount = 0;
let forceSendError = false;

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
          sendCallCount += 1;
          if (forceSendError) {
            throw new Error('simulated DynamoDB failure');
          }

          if (command.constructor.name === 'FakeGetCommand') {
            const item = fakeTable.get(command.input.Key.job_id);
            return { Item: item };
          }

          if (command.constructor.name === 'FakePutCommand') {
            fakeTable.set(command.input.Item.job_id, command.input.Item);
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

let wasAlreadyEnqueued: typeof import('./idempotency').wasAlreadyEnqueued;
let recordEnqueued: typeof import('./idempotency').recordEnqueued;

before(async () => {
  const mod = await import('./idempotency');
  wasAlreadyEnqueued = mod.wasAlreadyEnqueued;
  recordEnqueued = mod.recordEnqueued;
});

beforeEach(() => {
  fakeTable = new Map();
  sendCallCount = 0;
  forceSendError = false;
});

describe('email idempotency backstop', () => {
  it('wasAlreadyEnqueued returns false for a key that was never recorded', async () => {
    const result = await wasAlreadyEnqueued('welcome:user-1');
    assert.equal(result, false);
  });

  it('recordEnqueued then wasAlreadyEnqueued returns true for the same key', async () => {
    await recordEnqueued('welcome:user-1');
    const result = await wasAlreadyEnqueued('welcome:user-1');
    assert.equal(result, true);
  });

  it('uses a job_id namespaced under email-idempotency: to avoid colliding with other job types', async () => {
    await recordEnqueued('welcome:user-1');
    assert.ok(fakeTable.has('email-idempotency:welcome:user-1'));
  });

  it('sets a ttl attribute on the recorded item', async () => {
    const before = Math.floor(Date.now() / 1000);
    await recordEnqueued('welcome:user-1');
    const item = fakeTable.get('email-idempotency:welcome:user-1');
    assert.ok(item);
    assert.ok(typeof item!.ttl === 'number');
    assert.ok((item!.ttl as number) > before);
  });

  it('wasAlreadyEnqueued fails open (returns false) on a DynamoDB error', async () => {
    forceSendError = true;
    const result = await wasAlreadyEnqueued('welcome:user-1');
    assert.equal(result, false);
  });

  it('recordEnqueued swallows DynamoDB errors instead of throwing', async () => {
    forceSendError = true;
    await assert.doesNotReject(() => recordEnqueued('welcome:user-1'));
  });

  it('two different idempotency keys do not collide', async () => {
    await recordEnqueued('welcome:user-1');
    const otherKeyResult = await wasAlreadyEnqueued('welcome:user-2');
    assert.equal(otherKeyResult, false);
  });
});
