import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvironmentConfig, getRootZoneName } from '../config/environment';

/**
 * Certificate Stack (us-east-1)
 *
 * This stack provisions an ACM certificate in us-east-1 for CloudFront.
 * CloudFront requires certificates in us-east-1 regardless of where the
 * distribution is deployed.
 *
 * This stack is OPTIONAL. It is only instantiated (see bin/app.ts) when a
 * custom CDN domain (CDN_DOMAIN) is configured AND no pre-existing
 * CLOUDFRONT_CERTIFICATE_ARN was supplied. A deployment without a custom CDN
 * domain uses the default *.cloudfront.net URL and this stack is never created.
 *
 * The certificate's domain names are derived entirely from the configured
 * cdnDomain and its apex zone — there are no hardcoded domains here.
 *
 * Requirements: 8.1, 16.2
 * Design: Components § CloudFront Distribution
 *
 * IMPORTANT: This stack MUST be deployed to us-east-1 even if other stacks are
 * in different regions.
 */
export class CertificateStack extends cdk.Stack {
  public readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, config: EnvironmentConfig, props?: cdk.StackProps) {
    // Force us-east-1 region for CloudFront certificates
    super(scope, id, {
      ...props,
      env: {
        account: config.account,
        region: 'us-east-1' // CloudFront requires us-east-1
      },
      crossRegionReferences: true // Enable cross-region stack references
    });

    // Apply environment tags to all resources in this stack
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    const cdnDomain = config.domain.cdnDomain;
    if (!cdnDomain) {
      throw new Error(
        `CertificateStack requires CDN_DOMAIN to be set in ${config.environmentName}. ` +
          'It should only be instantiated when a custom CDN domain is configured.'
      );
    }

    if (!config.domain.hostedZoneId) {
      throw new Error(
        `HOSTED_ZONE_ID is required to create and DNS-validate the CloudFront certificate for '${cdnDomain}' ` +
          `in ${config.environmentName}. Either set HOSTED_ZONE_ID, or supply a pre-issued CLOUDFRONT_CERTIFICATE_ARN ` +
          '(a us-east-1 ACM certificate) so this stack is not needed.'
      );
    }

    const zoneName = getRootZoneName(cdnDomain);

    /**
     * ACM Certificate for CloudFront (us-east-1)
     *
     * Covers the configured CDN domain and a wildcard on its apex zone so
     * other subdomains under the same zone can reuse it. Validated via DNS
     * through the configured Route 53 hosted zone.
     */
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: config.domain.hostedZoneId,
      zoneName
    });

    this.certificate = new acm.Certificate(this, 'CloudFrontCertificate', {
      domainName: cdnDomain,
      subjectAlternativeNames: [`*.${zoneName}`],
      validation: acm.CertificateValidation.fromDns(hostedZone)
    });

    // Stack Outputs
    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      description: 'ACM certificate ARN for CloudFront (us-east-1)',
      exportName: `${config.environmentName}-CloudFrontCertificateArn`
    });

    new cdk.CfnOutput(this, 'CertificateRegion', {
      value: 'us-east-1',
      description: 'Certificate region (required for CloudFront)'
    });

    new cdk.CfnOutput(this, 'CertificateDomains', {
      value: `${cdnDomain}, *.${zoneName}`,
      description: 'Domains covered by the certificate'
    });

    new cdk.CfnOutput(this, 'ValidationMethod', {
      value: 'DNS (automatic via Route 53)',
      description: 'Certificate validation method'
    });
  }
}
