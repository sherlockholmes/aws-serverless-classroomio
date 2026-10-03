import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthApi } from './helpers';

/**
 * DynamoDB assertions (tables live in QueueStack): names, billing mode, TTL
 * presence/absence, GSIs, and per-environment removal policy.
 */
describe('DynamoDB tables (QueueStack)', () => {
  let tqDev: Template;
  let tqProd: Template;

  beforeAll(async () => {
    ({ tq: tqDev } = await synthApi({}, 'dev'));
    ({ tq: tqProd } = await synthApi({}, 'production'));
  });

  it('creates the three expected tables, all PAY_PER_REQUEST', () => {
    tqDev.resourceCountIs('AWS::DynamoDB::Table', 3);
    for (const name of [
      'classroomio-rate-limits-dev',
      'classroomio-job-metadata-dev',
      'classroomio-migration-routes-dev'
    ]) {
      tqDev.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: name,
        BillingMode: 'PAY_PER_REQUEST'
      });
    }
  });

  it('rate-limits and job-metadata have a ttl attribute; migration-routes has none', () => {
    tqDev.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'classroomio-rate-limits-dev',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true }
    });
    tqDev.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'classroomio-job-metadata-dev',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true }
    });

    const tables = tqDev.findResources('AWS::DynamoDB::Table');
    const migration = Object.values(tables).find(
      (r) => (r as { Properties: { TableName: string } }).Properties.TableName === 'classroomio-migration-routes-dev'
    ) as { Properties: Record<string, unknown> };
    if ('TimeToLiveSpecification' in migration.Properties) {
      throw new Error('migration-routes table unexpectedly has a TTL specification');
    }
  });

  it('job-metadata has status + job-type-status GSIs; migration-routes has enabled-index', () => {
    tqDev.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'classroomio-job-metadata-dev',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'status-index' }),
        Match.objectLike({ IndexName: 'job-type-status-index' })
      ])
    });
    tqDev.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'classroomio-migration-routes-dev',
      GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({ IndexName: 'enabled-index' })])
    });
  });

  it('migration-routes is always Retain; rate-limits/job-metadata are Delete in dev, Retain in production', () => {
    tqDev.hasResource('AWS::DynamoDB::Table', {
      Properties: Match.objectLike({ TableName: 'classroomio-migration-routes-dev' }),
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain'
    });
    tqDev.hasResource('AWS::DynamoDB::Table', {
      Properties: Match.objectLike({ TableName: 'classroomio-rate-limits-dev' }),
      DeletionPolicy: 'Delete'
    });

    tqProd.hasResource('AWS::DynamoDB::Table', {
      Properties: Match.objectLike({ TableName: 'classroomio-rate-limits-production' }),
      DeletionPolicy: 'Retain'
    });
    tqProd.hasResource('AWS::DynamoDB::Table', {
      Properties: Match.objectLike({ TableName: 'classroomio-job-metadata-production' }),
      DeletionPolicy: 'Retain'
    });
  });
});
