import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthApi } from './helpers';

/**
 * Lambda assertions: total count, representative function shapes
 * (runtime/arch/memory/timeout/handler), critical env vars, and X-Ray off.
 */
describe('ApiStack — Lambda functions', () => {
  let t: Template;

  beforeAll(async () => {
    ({ t } = await synthApi({}));
  });

  it('creates exactly 39 Lambda functions', () => {
    t.resourceCountIs('AWS::Lambda::Function', 39);
  });

  it('auth-handler has the expected runtime/arch/memory/timeout/handler', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'auth-handler-dev',
      Runtime: 'nodejs20.x',
      Architectures: ['arm64'],
      MemorySize: 1024,
      Timeout: 29,
      Handler: 'index.handler'
    });
  });

  it('account-profile is 512MB / 15s', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'account-profile-dev',
      MemorySize: 512,
      Timeout: 15
    });
  });

  it('migration-router timeout is 29s', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'migration-router-dev',
      Timeout: 29
    });
  });

  it('email-worker is 512MB / 30s', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'email-worker-dev',
      MemorySize: 512,
      Timeout: 30
    });
  });

  it('neon-test is 512MB / 30s', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'neon-test-dev',
      MemorySize: 512,
      Timeout: 30
    });
  });

  it('email-worker carries the SES + job-metadata + connection-timeout env', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'email-worker-dev',
      Environment: {
        Variables: Match.objectLike({
          EMAIL_PROVIDER: 'ses',
          // configuration-set name is a CloudFormation Ref token, not a literal
          SES_CONFIGURATION_SET_NAME: Match.anyValue(),
          JOB_METADATA_TABLE_NAME: Match.anyValue(),
          CONNECTION_TIMEOUT_MS: '10000'
        })
      }
    });
  });

  it('auth-handler carries SES provider + Better Auth env keys', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'auth-handler-dev',
      Environment: {
        Variables: Match.objectLike({
          EMAIL_PROVIDER: 'ses',
          BETTER_AUTH_SECRET: Match.anyValue(),
          PUBLIC_IS_SELFHOSTED: Match.anyValue()
        })
      }
    });
  });

  it('a representative authEnv consumer (course-details) carries the shared auth env keys', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'course-details-dev',
      Environment: {
        Variables: Match.objectLike({
          TRUSTED_ORIGINS: Match.anyValue(),
          DASHBOARD_ORIGIN: Match.anyValue(),
          PRIVATE_SERVER_KEY: Match.anyValue()
        })
      }
    });
  });

  it('video-url-generator carries the CloudFront signing env keys', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'video-url-generator-dev',
      Environment: {
        Variables: Match.objectLike({
          CDN_DOMAIN: Match.anyValue(),
          CLOUDFRONT_KEY_PAIR_ID: Match.anyValue(),
          CLOUDFRONT_PRIVATE_KEY: Match.anyValue()
        })
      }
    });
  });

  it('X-Ray tracing stays OFF — no TracingConfig is emitted on any function', () => {
    const fns = t.findResources('AWS::Lambda::Function');
    for (const [logicalId, res] of Object.entries(fns)) {
      const props = (res as { Properties?: Record<string, unknown> }).Properties ?? {};
      if ('TracingConfig' in props) {
        throw new Error(`Function ${logicalId} unexpectedly has TracingConfig (X-Ray should be disabled)`);
      }
    }
  });
});
