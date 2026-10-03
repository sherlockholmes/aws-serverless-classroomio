import { describe, it, beforeAll, expect } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { synthApi } from './helpers';

type PolicyStatement = {
  Effect?: string;
  Action?: string | string[];
  Resource?: string | string[];
};

type IamPolicy = {
  Properties: { PolicyDocument: { Statement: PolicyStatement[] } };
};

function allStatements(t: Template): PolicyStatement[] {
  const policies = t.findResources('AWS::IAM::Policy') as Record<string, IamPolicy>;
  const out: PolicyStatement[] = [];
  for (const p of Object.values(policies)) {
    for (const s of p.Properties.PolicyDocument.Statement) out.push(s);
  }

  return out;
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];

  return Array.isArray(v) ? v : [v];
}

describe('ApiStack — least-privilege IAM', () => {
  let t: Template;
  let statements: PolicyStatement[];

  beforeAll(async () => {
    ({ t } = await synthApi({}));
    statements = allStatements(t);
  });

  it('migration-router invoke is TIGHTENED to this environment (function:*-dev), never bare function:*', () => {
    const invokeStmts = statements.filter((s) => asArray(s.Action).includes('lambda:InvokeFunction'));
    expect(invokeStmts.length).toBeGreaterThan(0);

    for (const s of invokeStmts) {
      const resources = asArray(s.Resource);
      for (const r of resources) {
        expect(typeof r).toBe('string');
        expect(r.endsWith(':function:*-dev')).toBe(true);
        // The pre-tightening bare `:function:*` (no -<env> suffix) must be gone.
        expect(/:function:\*$/.test(r)).toBe(false);
      }
    }
  });

  it('SES send grants carry both the identity/* and configuration-set ARNs', () => {
    const sesStmts = statements.filter((s) => asArray(s.Action).includes('ses:SendEmail'));
    expect(sesStmts.length).toBeGreaterThanOrEqual(2); // email-worker + auth-handler

    for (const s of sesStmts) {
      expect(asArray(s.Action).sort()).toEqual(['ses:SendEmail', 'ses:SendRawEmail']);
      // The identity ARN is a plain string; the configuration-set ARN is an
      // Fn::Join of a `configuration-set/` prefix + the config-set Ref token.
      // Serialize the whole Resource so both forms are visible.
      const serialized = JSON.stringify(s.Resource);
      expect(serialized).toMatch(/:identity\/\*/);
      expect(serialized).toMatch(/:configuration-set\//);
    }
  });

  it('cloudwatch:PutMetricData uses the required Resource: "*" wildcard', () => {
    const cwStmts = statements.filter((s) => asArray(s.Action).includes('cloudwatch:PutMetricData'));
    expect(cwStmts.length).toBeGreaterThan(0);
    for (const s of cwStmts) {
      expect(asArray(s.Resource)).toEqual(['*']);
    }
  });

  it('negative: no handler grants s3:*, dynamodb:*, or bare lambda invoke on function:*', () => {
    for (const s of statements) {
      const actions = asArray(s.Action);
      expect(actions).not.toContain('s3:*');
      expect(actions).not.toContain('dynamodb:*');

      if (actions.includes('lambda:InvokeFunction')) {
        for (const r of asArray(s.Resource)) {
          expect(/:function:\*$/.test(r)).toBe(false);
        }
      }
    }
  });

  it('the three non-metric functions (neon-test, migration-router, email-worker) have no PutMetricData', () => {
    const policies = t.findResources('AWS::IAM::Policy') as Record<string, IamPolicy>;
    for (const [logicalId, p] of Object.entries(policies)) {
      if (!/^(NeonTestFunction|MigrationRouterFunction|EmailWorkerFunction)/.test(logicalId)) continue;

      for (const s of p.Properties.PolicyDocument.Statement) {
        expect(asArray(s.Action)).not.toContain('cloudwatch:PutMetricData');
      }
    }
  });
});
