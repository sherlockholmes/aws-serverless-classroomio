import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { EnvironmentConfig, getRootZoneName } from '../config/environment';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Storage Stack
 *
 * This stack provisions:
 * - S3 bucket for media storage (HLS videos, assets, uploads)
 * - CloudFront distribution for CDN delivery
 * - Bucket lifecycle policies for cost optimization
 * - CloudFront signed URL configuration
 * - Origin Access Control (OAC) for private S3 access
 *
 * Requirements: 13.1, 13.4, 13.5, 13.6, 8.1, 8.2, 8.4, 8.5
 * Design: Components § S3 + CloudFront
 * Tasks: 3.1, 18.1, 18.2, 18.3, 19.1, 19.2
 */
export class StorageStack extends cdk.Stack {
  public readonly mediaBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly signingKeyGroup: cloudfront.KeyGroup;

  constructor(
    scope: Construct,
    id: string,
    config: EnvironmentConfig,
    props?: cdk.StackProps & { certificateArn?: string }
  ) {
    super(scope, id, props);

    // Apply environment tags to all resources in this stack
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    /**
     * S3 Bucket for Media Storage
     *
     * Task 3.1: Create S3 bucket for media storage
     * Requirements: 13.1, 13.4, 13.5, 13.6
     *
     * This bucket stores:
     * - /hls/{assetId}/ - Transcoded HLS video segments and manifests
     * - /assets/{orgId}/ - Course images, thumbnails, attachments
     * - /uploads/{orgId}/ - Temporary upload staging (7-day retention)
     */
    this.mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      bucketName: `${config.bucketPrefix}-media-${config.environmentName}`,

      // Versioning enabled for critical assets (Requirement 13.6)
      versioned: true,

      // Block all public access (Requirement 13.4)
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,

      // Enable server-side encryption with S3-managed keys
      encryption: s3.BucketEncryption.S3_MANAGED,

      // Enable intelligent tiering for cost optimization
      intelligentTieringConfigurations: [
        {
          name: 'ArchiveOldAssets',
          archiveAccessTierTime: cdk.Duration.days(90),
          deepArchiveAccessTierTime: cdk.Duration.days(180)
        }
      ],

      // Lifecycle policies (Requirement 13.5)
      lifecycleRules: [
        {
          // Delete temporary uploads after 7 days
          id: 'DeleteOldUploads',
          prefix: 'uploads/',
          enabled: true,
          expiration: cdk.Duration.days(7)
        },
        {
          // Transition old HLS content to Glacier after 90 days of no access
          id: 'ArchiveOldHLSContent',
          prefix: 'hls/',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90)
            }
          ]
        }
      ],

      // Enable CORS for cross-origin video playback
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: config.allowedOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3600
        }
      ],

      // Retain bucket on stack deletion (production safety)
      removalPolicy: config.environmentName === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,

      // Auto-delete objects when bucket is destroyed (dev/staging only)
      autoDeleteObjects: config.environmentName !== 'production'
    });

    // Create directory structure via deployment-time custom resource (optional)
    // This is informational - S3 doesn't require explicit folder creation
    // but we document the expected structure in CloudFormation outputs

    /**
     * Task 18.1: CloudFront Distribution with S3 Origin
     * Requirements: 8.1, 13.4
     *
     * Creates a CloudFront distribution with:
     * - Origin Access Control (OAC) for private S3 access (automatic via withOriginAccessControl)
     * - An optional custom domain + us-east-1 ACM certificate (only when
     *   CDN_DOMAIN and its certificate are configured; otherwise the default
     *   *.cloudfront.net URL is used)
     * - Standard logging enabled
     */

    // Resolve the us-east-1 CloudFront certificate (CloudFront requires its
    // certificate in us-east-1 regardless of the distribution region).
    // Priority: 1) ARN passed via props (from env or the optional
    // CertificateStack), 2) config.domain.cloudFrontCertificateArn,
    // 3) undefined — no custom CDN domain, use the default *.cloudfront.net URL.
    const certificateArn = props?.certificateArn || config.domain.cloudFrontCertificateArn;
    const cdnDomain = config.domain.cdnDomain;

    // A custom CDN domain is only attached when BOTH the domain and its
    // us-east-1 certificate are configured.
    const useCustomCdnDomain = Boolean(cdnDomain && certificateArn);

    const certificate =
      useCustomCdnDomain && certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'CdnCertificate', certificateArn)
        : undefined;

    // Look up the Route 53 hosted zone only when a custom CDN domain and a
    // hosted zone are both configured — the alias record requires it.
    const hostedZone =
      useCustomCdnDomain && cdnDomain && config.domain.hostedZoneId
        ? route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
            hostedZoneId: config.domain.hostedZoneId,
            zoneName: getRootZoneName(cdnDomain)
          })
        : undefined;

    /**
     * Task 18.2: Configure Cache Behaviors for Video Content
     * Requirements: 8.4, 8.5
     *
     * Cache behaviors configured:
     * 1. HLS Master Playlist (master.m3u8): TTL 10 seconds
     * 2. HLS Variant Playlists (*.m3u8, NOT master.m3u8): TTL 5 minutes
     * 3. HLS Video Segments (*.ts): TTL 1 year, immutable
     * 4. Assets (/assets/*): TTL 1 day
     * 5. Default: TTL 1 hour
     */

    // Cache policy for HLS master playlist (mutable, short TTL)
    const masterPlaylistCachePolicy = new cloudfront.CachePolicy(this, 'MasterPlaylistCachePolicy', {
      cachePolicyName: `${config.environmentName}-master-playlist-policy`,
      comment: 'Cache policy for HLS master playlists (10s TTL)',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.seconds(10),
      maxTtl: cdk.Duration.seconds(10),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none()
    });

    // Cache policy for HLS variant playlists (rarely changes, medium TTL)
    const variantPlaylistCachePolicy = new cloudfront.CachePolicy(this, 'VariantPlaylistCachePolicy', {
      cachePolicyName: `${config.environmentName}-variant-playlist-policy`,
      comment: 'Cache policy for HLS variant playlists (5 min TTL)',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.minutes(5),
      maxTtl: cdk.Duration.minutes(5),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none()
    });

    // Cache policy for HLS video segments (immutable, long TTL)
    const videoSegmentsCachePolicy = new cloudfront.CachePolicy(this, 'VideoSegmentsCachePolicy', {
      cachePolicyName: `${config.environmentName}-video-segments-policy`,
      comment: 'Cache policy for HLS video segments (1 year TTL, immutable)',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      enableAcceptEncodingGzip: false, // Video already compressed
      enableAcceptEncodingBrotli: false,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none()
    });

    // Cache policy for static assets (images, thumbnails)
    const assetsCachePolicy = new cloudfront.CachePolicy(this, 'AssetsCachePolicy', {
      cachePolicyName: `${config.environmentName}-assets-policy`,
      comment: 'Cache policy for static assets (1 day TTL)',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.days(1),
      maxTtl: cdk.Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none()
    });

    // Default cache policy (moderate TTL for other content)
    const defaultCachePolicy = new cloudfront.CachePolicy(this, 'DefaultCachePolicy', {
      cachePolicyName: `${config.environmentName}-default-policy`,
      comment: 'Default cache policy (1 hour TTL)',
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.hours(1),
      maxTtl: cdk.Duration.hours(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none()
    });

    // Origin request policy for CloudFront → S3
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, 'S3OriginRequestPolicy', {
      originRequestPolicyName: `${config.environmentName}-s3-origin-policy`,
      comment: 'Origin request policy for S3 access',
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.none(),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none()
    });

    // Response headers policy (security headers)
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeadersPolicy', {
      responseHeadersPolicyName: `${config.environmentName}-security-headers`,
      comment: 'Security headers for CloudFront responses',
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.seconds(31536000),
          includeSubdomains: true,
          override: true
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true
        },
        xssProtection: { protection: true, modeBlock: true, override: true }
      },
      corsBehavior: {
        accessControlAllowOrigins: config.allowedOrigins,
        accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
        accessControlAllowHeaders: ['*'],
        accessControlExposeHeaders: ['ETag'],
        accessControlMaxAge: cdk.Duration.seconds(3600),
        accessControlAllowCredentials: false,
        originOverride: true
      }
    });

    /**
     * Task 18.3: CloudFront Signed URLs (trusted key group)
     *
     * Requirements: 8.2, 16.2
     * Design: Security Design § CloudFront Security § Signed URLs
     *
     * Only the PUBLIC key lives in CDK/git (infrastructure/keys/cloudfront-public-key.pem) —
     * it is not secret. The matching PRIVATE key is never stored here; it is
     * passed to the video-url-generator Lambda as an env var at deploy time
     * (CLOUDFRONT_PRIVATE_KEY), the same pattern used for BETTER_AUTH_SECRET.
     * Cost: $0 — CloudFront key groups have no AWS charge.
     *
     * Key rotation (every 90 days): generate a new RSA pair, add a second
     * PublicKey + KeyGroup, add it to trustedKeyGroups alongside the old one,
     * redeploy the Lambda with the new private key, then remove the old key
     * group once no outstanding signed URLs reference it (max URL TTL: 1h).
     */
    const cloudFrontPublicKeyPem = fs.readFileSync(
      path.join(__dirname, '../../keys/cloudfront-public-key.pem'),
      'utf-8'
    );

    const signingPublicKey = new cloudfront.PublicKey(this, 'HlsSigningPublicKey', {
      publicKeyName: `${config.environmentName}-hls-signing-key`,
      encodedKey: cloudFrontPublicKeyPem,
      comment: 'RSA public key for HLS signed URL verification (rotate every 90 days)'
    });

    this.signingKeyGroup = new cloudfront.KeyGroup(this, 'HlsSigningKeyGroup', {
      keyGroupName: `${config.environmentName}-hls-signing-key-group`,
      items: [signingPublicKey],
      comment: 'Trusted key group for HLS master/variant playlist and segment signed URLs'
    });

    // Create S3 origin for CloudFront with Origin Access Control (OAC)
    // S3BucketOrigin.withOriginAccessControl() automatically creates and configures OAC
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.mediaBucket);

    // Create CloudFront distribution
    this.distribution = new cloudfront.Distribution(this, 'CdnDistribution', {
      comment: `ClassroomIO CDN - ${config.environmentName}`,

      // Custom domain configuration — only attached when a custom CDN domain
      // and its us-east-1 certificate are configured; otherwise CloudFront
      // serves the default *.cloudfront.net URL.
      domainNames: useCustomCdnDomain && cdnDomain ? [cdnDomain] : undefined,
      certificate: certificate,

      // Default behavior (catch-all)
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: defaultCachePolicy,
        originRequestPolicy: originRequestPolicy,
        responseHeadersPolicy: responseHeadersPolicy
      },

      // Additional behaviors for specific content types
      additionalBehaviors: {
        // HLS master playlists (master.m3u8) - 10 second TTL
        'hls/*/master.m3u8': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: false, // Don't compress playlists (small, text-based)
          cachePolicy: masterPlaylistCachePolicy,
          originRequestPolicy: originRequestPolicy,
          responseHeadersPolicy: responseHeadersPolicy,
          trustedKeyGroups: [this.signingKeyGroup]
        },

        // HLS variant playlists (*.m3u8 except master.m3u8) - 5 minute TTL
        'hls/*/*.m3u8': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: false,
          cachePolicy: variantPlaylistCachePolicy,
          originRequestPolicy: originRequestPolicy,
          responseHeadersPolicy: responseHeadersPolicy,
          trustedKeyGroups: [this.signingKeyGroup]
        },

        // HLS video segments (*.ts) - 1 year TTL, immutable
        'hls/*/*.ts': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: false, // Video already compressed
          cachePolicy: videoSegmentsCachePolicy,
          originRequestPolicy: originRequestPolicy,
          responseHeadersPolicy: responseHeadersPolicy,
          trustedKeyGroups: [this.signingKeyGroup]
        },

        // Static assets (images, thumbnails, attachments) - 1 day TTL
        'assets/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          compress: true,
          cachePolicy: assetsCachePolicy,
          originRequestPolicy: originRequestPolicy,
          responseHeadersPolicy: responseHeadersPolicy
        }
      },

      // Price class (use all edge locations for best performance)
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,

      // Enable IPv6
      enableIpv6: true,

      // Logging configuration

      // No geo restrictions (allow all countries)
      // geoRestriction is optional - omitting it allows all locations

      // HTTP version
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,

      // Minimum TLS version
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,

      // Error responses
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 403,
          responsePagePath: '/errors/403.html',
          ttl: cdk.Duration.minutes(5)
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/errors/404.html',
          ttl: cdk.Duration.minutes(5)
        }
      ]
    });

    /**
     * Task 19.1: Configure S3 Bucket Policy for CloudFront OAC
     * Requirements: 13.4, 13.6, 16.2
     *
     * Grant CloudFront distribution access to S3 bucket via OAC
     * Note: This is handled automatically by S3BucketOrigin.withOriginAccessControl()
     */

    /**
     * Create the Route 53 DNS alias record for the custom CDN domain.
     * Only created when the custom domain, its certificate, and a hosted zone
     * are all configured.
     */
    if (hostedZone && certificate && cdnDomain) {
      new route53.ARecord(this, 'CdnAliasRecord', {
        zone: hostedZone,
        recordName: cdnDomain,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
        comment: `CloudFront distribution for ${config.environmentName} CDN`
      });
    }

    // Stack Outputs

    // CloudFront signing key group (Task 18.3)
    new cdk.CfnOutput(this, 'SigningKeyGroupId', {
      value: this.signingKeyGroup.keyGroupId,
      description: 'CloudFront key group ID trusted for HLS signed URLs',
      exportName: `${config.environmentName}-SigningKeyGroupId`
    });

    new cdk.CfnOutput(this, 'MediaBucketName', {
      value: this.mediaBucket.bucketName,
      description: 'S3 bucket name for media storage',
      exportName: `${config.environmentName}-MediaBucketName`
    });

    new cdk.CfnOutput(this, 'MediaBucketArn', {
      value: this.mediaBucket.bucketArn,
      description: 'S3 bucket ARN for media storage',
      exportName: `${config.environmentName}-MediaBucketArn`
    });

    new cdk.CfnOutput(this, 'MediaBucketDomainName', {
      value: this.mediaBucket.bucketDomainName,
      description: 'S3 bucket domain name'
    });

    new cdk.CfnOutput(this, 'DirectoryStructure', {
      value: '/hls/, /assets/, /uploads/',
      description: 'Expected directory structure in media bucket'
    });

    new cdk.CfnOutput(this, 'LifecyclePolicies', {
      value: 'uploads/: 7-day deletion, hls/: 90-day Glacier transition',
      description: 'Lifecycle policies configured'
    });

    // CloudFront Distribution Outputs
    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID',
      exportName: `${config.environmentName}-DistributionId`
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name (*.cloudfront.net)',
      exportName: `${config.environmentName}-DistributionDomainName`
    });

    // CDN base URL: the custom domain when configured, otherwise the default
    // CloudFront distribution domain (*.cloudfront.net).
    const cdnHost = useCustomCdnDomain && cdnDomain ? cdnDomain : this.distribution.distributionDomainName;

    new cdk.CfnOutput(this, 'CdnDomain', {
      value: cdnHost,
      description: 'CDN host (custom domain when configured, else CloudFront default domain)'
    });

    new cdk.CfnOutput(this, 'CdnUrl', {
      value: `https://${cdnHost}`,
      description: 'CDN base URL for accessing media'
    });

    new cdk.CfnOutput(this, 'CacheBehaviors', {
      value: 'master.m3u8: 10s, *.m3u8: 5min, *.ts: 1year, /assets/*: 1day',
      description: 'Cache TTL configuration for different content types'
    });
  }
}
