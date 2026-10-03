import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthCicd } from './helpers';

/**
 * OIDC + GitHub Actions deploy role assertions (CicdStack).
 *
 * NOTE: the L2 `iam.OpenIdConnectProvider` synthesizes a custom-resource-backed
 * provider of type `Custom::AWSCDKOpenIdConnectProvider` (with `Url` +
 * `ClientIDList`), NOT the native `AWS::IAM::OIDCProvider`.
 */
describe('CicdStack — GitHub OIDC provider and deploy role', () => {
  let t: Template;

  beforeAll(async () => {
    ({ t } = await synthCicd({}));
  });

  it('creates the custom-resource OIDC provider for GitHub Actions', () => {
    t.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 1);
    t.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIDList: ['sts.amazonaws.com']
    });
  });

  it('creates the deploy role trusted by the classroomio repo develop + main branches', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'ClassroomIO-GitHubActions-Deploy-dev',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: Match.objectLike({ Federated: Match.anyValue() }),
            Condition: Match.objectLike({
              StringLike: {
                'token.actions.githubusercontent.com:sub': [
                  'repo:classroomio/classroomio:ref:refs/heads/develop',
                  'repo:classroomio/classroomio:ref:refs/heads/main'
                ]
              }
            })
          })
        ])
      })
    });
  });
});
