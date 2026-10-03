import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environment';

/**
 * Certificate Stack (us-east-1)
 *
 * This stack provisions ACM certificates in us-east-1 for CloudFront.
 * CloudFront requires certificates in us-east-1 regardless of where the distribution is deployed.
 *
 * Requirements: 8.1, 16.2
 * Design: Components § CloudFront Distribution
 * Tasks: 18.1 - CloudFront certificate creation
 *
 * IMPORTANT: This stack MUST be deployed to us-east-1 even if other stacks are in different regions.
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

    /**
     * ACM Certificate for CloudFront
     *
     * Task 18.1: Create ACM certificate in us-east-1 for CloudFront distribution
     *
     * Certificate covers:
     * - cdn.example.com (CDN domain)
     * - example.com (Primary domain - for future frontend hosting)
     * - *.example.com (Wildcard for all subdomains)
     *
     * Validation: DNS (automatic via Route 53)
     */

    if (!config.domain.hostedZoneId) {
      throw new Error(`Hosted Zone ID is required for certificate creation in ${config.environmentName} environment`);
    }

    // Look up Route 53 hosted zone
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: config.domain.hostedZoneId,
      zoneName: 'example.com' // Root domain
    });

    // Create ACM certificate for CloudFront (must be in us-east-1)
    this.certificate = new acm.Certificate(this, 'CloudFrontCertificate', {
      domainName: 'example.com',
      subjectAlternativeNames: ['*.example.com'],
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
      value: 'example.com, *.example.com',
      description: 'Domains covered by the certificate'
    });

    new cdk.CfnOutput(this, 'ValidationMethod', {
      value: 'DNS (automatic via Route 53)',
      description: 'Certificate validation method'
    });
  }
}
