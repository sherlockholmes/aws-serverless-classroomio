import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthApi, FULL_DOMAIN_ENV } from './helpers';

/**
 * SES assertions: the always-present configuration set + event destination, and
 * the Route 53-backed EmailIdentity that appears ONLY when a custom domain +
 * hosted zone are configured.
 */
describe('SES configuration set and conditional domain identity', () => {
  describe('no-domain deploy', () => {
    let t: Template;

    beforeAll(async () => {
      ({ t } = await synthApi({}));
    });

    it('creates the configuration set and its event destination', () => {
      t.hasResourceProperties('AWS::SES::ConfigurationSet', { Name: 'classroomio-dev' });
      t.resourceCountIs('AWS::SES::ConfigurationSetEventDestination', 1);
    });

    it('does NOT create a Route 53-backed EmailIdentity', () => {
      t.resourceCountIs('AWS::SES::EmailIdentity', 0);
    });
  });

  describe('full-domain deploy', () => {
    let t: Template;

    beforeAll(async () => {
      ({ t } = await synthApi(FULL_DOMAIN_ENV));
    });

    it('creates exactly one EmailIdentity for the apex zone with the mail-from subdomain', () => {
      t.resourceCountIs('AWS::SES::EmailIdentity', 1);
      t.hasResourceProperties('AWS::SES::EmailIdentity', {
        EmailIdentity: 'example.org',
        MailFromAttributes: { MailFromDomain: 'mail.example.org' },
        // ConfigurationSetName resolves to a CloudFormation Ref token (not a literal)
        ConfigurationSetAttributes: { ConfigurationSetName: Match.anyValue() }
      });
    });
  });
});
