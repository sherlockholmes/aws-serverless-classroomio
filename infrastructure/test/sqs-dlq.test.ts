import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthApi } from './helpers';

/**
 * SQS + DLQ assertions: the email queue + DLQ (QueueStack) and the ApiStack
 * event source mapping wiring the email-worker to the queue.
 */
describe('Email queue, DLQ, and event source mapping', () => {
  let tq: Template;
  let t: Template;

  beforeAll(async () => {
    ({ t, tq } = await synthApi({}));
  });

  it('QueueStack creates the email queue with a 3-attempt redrive to the DLQ', () => {
    tq.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'classroomio-email-dev',
      VisibilityTimeout: 60,
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 })
    });
  });

  it('QueueStack creates the email DLQ with a 14-day retention', () => {
    tq.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'classroomio-email-dlq-dev',
      MessageRetentionPeriod: 1209600
    });
  });

  it('ApiStack wires email-worker to the queue with batchSize 10 + partial-batch failures', () => {
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      EventSourceArn: Match.anyValue()
    });
    t.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
  });
});
