import { describe, it, expect } from 'vitest';
import { synthApi } from './helpers';

/**
 * Conditional-domain validation guard: an INCOMPLETE custom-domain combination
 * (e.g. API_DOMAIN without CERTIFICATE_ARN) must throw a clear, named-variable
 * error. This exercises the prior custom-domains-optional phase's
 * validateDomainConfig without changing it.
 */
describe('EnvironmentConfig — incomplete domain combinations are rejected', () => {
  it('API_DOMAIN without CERTIFICATE_ARN throws naming the missing variable', async () => {
    await expect(synthApi({ API_DOMAIN: 'api.example.org', HOSTED_ZONE_ID: 'Z123' })).rejects.toThrow(
      /CERTIFICATE_ARN/
    );
  });

  it('a custom domain without HOSTED_ZONE_ID throws naming the missing variable', async () => {
    await expect(
      synthApi({
        API_DOMAIN: 'api.example.org',
        CERTIFICATE_ARN: 'arn:aws:acm:us-east-1:111111111111:certificate/aaaa'
      })
    ).rejects.toThrow(/HOSTED_ZONE_ID/);
  });

  it('a fully-unset domain config synthesizes cleanly (default URLs)', async () => {
    const { t } = await synthApi({});
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });
});
