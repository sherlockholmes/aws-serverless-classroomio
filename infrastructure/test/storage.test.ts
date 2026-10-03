import { describe, it, beforeAll } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { synthApi, FULL_DOMAIN_ENV } from './helpers';

/**
 * StorageStack assertions: the private media bucket (all public access blocked,
 * encryption, versioning, lifecycle, per-env removal policy) and the CloudFront
 * distribution (HTTPS redirect, min TLS, HLS trusted-key-group behaviors, and
 * conditional custom-domain aliases/alias record).
 */
describe('StorageStack — S3 media bucket', () => {
  let tsDev: Template;
  let tsProd: Template;

  beforeAll(async () => {
    ({ ts: tsDev } = await synthApi({}, 'dev'));
    ({ ts: tsProd } = await synthApi({}, 'production'));
  });

  it('creates the media bucket with ALL public access blocked, AES256 encryption, and versioning', () => {
    tsDev.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'classroomio-media-dev',
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }]
      },
      VersioningConfiguration: { Status: 'Enabled' }
    });
  });

  it('has the uploads-expiration and HLS-Glacier lifecycle rules', () => {
    tsDev.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'uploads/', ExpirationInDays: 7, Status: 'Enabled' }),
          Match.objectLike({
            Prefix: 'hls/',
            Status: 'Enabled',
            Transitions: Match.arrayWith([Match.objectLike({ StorageClass: 'GLACIER', TransitionInDays: 90 })])
          })
        ])
      }
    });
  });

  it('removal policy: Delete in dev, Retain in production', () => {
    tsDev.hasResource('AWS::S3::Bucket', {
      Properties: Match.objectLike({ BucketName: 'classroomio-media-dev' }),
      DeletionPolicy: 'Delete'
    });
    tsProd.hasResource('AWS::S3::Bucket', {
      Properties: Match.objectLike({ BucketName: 'classroomio-media-production' }),
      DeletionPolicy: 'Retain'
    });
  });
});

describe('StorageStack — CloudFront distribution', () => {
  let tsDev: Template;
  let tsFull: Template;

  beforeAll(async () => {
    ({ ts: tsDev } = await synthApi({}, 'dev'));
    ({ ts: tsFull } = await synthApi(FULL_DOMAIN_ENV, 'dev'));
  });

  it('redirects to HTTPS on the default behavior', () => {
    tsDev.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' })
      })
    });
  });

  it('enforces min TLS 1.2_2021 on the custom-domain viewer certificate', () => {
    // The default *.cloudfront.net certificate carries no ViewerCertificate
    // block; the minimum-protocol-version only applies to a custom ACM cert, so
    // this is asserted on the full-domain synth.
    tsFull.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: 'TLSv1.2_2021' })
      })
    });
  });

  it('attaches TrustedKeyGroups to the three HLS behaviors only, never to assets/* or the default', () => {
    tsDev.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: 'hls/*/master.m3u8', TrustedKeyGroups: Match.anyValue() }),
          Match.objectLike({ PathPattern: 'hls/*/*.m3u8', TrustedKeyGroups: Match.anyValue() }),
          Match.objectLike({ PathPattern: 'hls/*/*.ts', TrustedKeyGroups: Match.anyValue() })
        ])
      })
    });

    // Pull the raw config and assert assets/* and the default behavior have NO
    // TrustedKeyGroups (a signed-URL bypass would be a security regression).
    const dist = Object.values(tsDev.findResources('AWS::CloudFront::Distribution'))[0] as {
      Properties: {
        DistributionConfig: {
          DefaultCacheBehavior: Record<string, unknown>;
          CacheBehaviors: Array<Record<string, unknown>>;
        };
      };
    };
    const dc = dist.Properties.DistributionConfig;
    if ('TrustedKeyGroups' in dc.DefaultCacheBehavior) {
      throw new Error('DefaultCacheBehavior unexpectedly has TrustedKeyGroups (signed-URL bypass risk)');
    }
    const assets = dc.CacheBehaviors.find((b) => b.PathPattern === 'assets/*');
    if (!assets) throw new Error('assets/* behavior missing');
    if ('TrustedKeyGroups' in assets) {
      throw new Error('assets/* unexpectedly has TrustedKeyGroups');
    }
  });

  it('adds custom Aliases + a Route 53 alias record only in the full-domain case', () => {
    tsDev.resourceCountIs('AWS::Route53::RecordSet', 0);

    tsFull.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Aliases: ['cdn.example.org'] })
    });
    const records = tsFull.findResources('AWS::Route53::RecordSet');
    if (Object.keys(records).length < 1) {
      throw new Error('expected at least one Route53 RecordSet in the full-domain case');
    }
  });
});
