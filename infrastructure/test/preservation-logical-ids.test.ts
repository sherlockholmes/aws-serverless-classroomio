import { describe, it, beforeAll, expect } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { synthApi, FULL_DOMAIN_ENV } from './helpers';
import { BEFORE_FUNCTION_LOGICAL_IDS, BEFORE_NAMED_LOGICAL_IDS } from './fixtures/before-logical-ids';

/**
 * Logical-ID preservation guard.
 *
 * The refactor moves construction logic into per-domain constructs but keeps
 * every resource on the ApiStack scope, so logical IDs MUST be unchanged. A
 * rename of a stateful/named resource is the highest-severity regression (data
 * loss / `already exists` deploy failure). This test fails loudly if any of the
 * committed before-template logical IDs disappear.
 */
describe('ApiStack — logical-ID preservation', () => {
  let resources: Record<string, { Type: string }>;
  let domainResources: Record<string, { Type: string }>;

  beforeAll(async () => {
    const noDomain = await synthApi({});
    resources = (noDomain.t.toJSON() as { Resources: Record<string, { Type: string }> }).Resources;

    const full = await synthApi(FULL_DOMAIN_ENV);
    domainResources = (full.t.toJSON() as { Resources: Record<string, { Type: string }> }).Resources;
  });

  it('all 39 Lambda function logical IDs are present as AWS::Lambda::Function', () => {
    const entries = Object.entries(BEFORE_FUNCTION_LOGICAL_IDS);
    expect(entries.length).toBe(39);

    for (const [functionName, ids] of entries) {
      expect(resources[ids.fn], `missing Lambda logical ID for ${functionName} (${ids.fn})`).toBeDefined();
      expect(resources[ids.fn].Type).toBe('AWS::Lambda::Function');
    }
  });

  it('each function keeps its log group (except email-worker, which imports one)', () => {
    for (const [functionName, ids] of Object.entries(BEFORE_FUNCTION_LOGICAL_IDS)) {
      if (ids.logGroup) {
        expect(resources[ids.logGroup], `missing LogGroup for ${functionName} (${ids.logGroup})`).toBeDefined();
        expect(resources[ids.logGroup].Type).toBe('AWS::Logs::LogGroup');
      }
    }

    // email-worker specifically must NOT create its own log group (it imports
    // the MonitoringStack-owned one by name).
    expect(BEFORE_FUNCTION_LOGICAL_IDS['email-worker-dev'].logGroup).toBeUndefined();
  });

  it('the named stateful/shared resources keep their logical IDs', () => {
    const named = BEFORE_NAMED_LOGICAL_IDS;

    expect(resources[named.httpApi].Type).toBe('AWS::ApiGatewayV2::Api');
    expect(resources[named.stage].Type).toBe('AWS::ApiGatewayV2::Stage');
    expect(resources[named.sesConfigSet].Type).toBe('AWS::SES::ConfigurationSet');
    expect(resources[named.sesEventDest].Type).toBe('AWS::SES::ConfigurationSetEventDestination');
    expect(resources[named.emailWorkerEventSource].Type).toBe('AWS::Lambda::EventSourceMapping');
  });

  it('the SES domain identity keeps its logical ID in the full-domain case', () => {
    const id = BEFORE_NAMED_LOGICAL_IDS.sesDomainIdentity;
    expect(domainResources[id], `missing SES domain identity (${id})`).toBeDefined();
    expect(domainResources[id].Type).toBe('AWS::SES::EmailIdentity');
  });
});
