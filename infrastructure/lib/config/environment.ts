/**
 * Environment configuration for ClassroomIO AWS Serverless Migration
 *
 * Each environment (dev, staging, production) has specific AWS account and region settings,
 * plus resource configuration for CDK stacks.
 */

export interface EnvironmentConfig {
  /** AWS account ID */
  account: string;
  /** AWS region */
  region: string;
  /** Environment name (used for resource naming) */
  environmentName: string;
  /** Bucket prefix for S3 buckets */
  bucketPrefix: string;
  /** Allowed origins for CORS */
  allowedOrigins: string[];
  /** Domain configuration */
  domain: DomainConfig;
  /** Neon PostgreSQL connection details */
  database: DatabaseConfig;
  /** Lambda configuration */
  lambda: LambdaConfig;
  /** S3 bucket configuration */
  storage: StorageConfig;
  /** DynamoDB configuration */
  dynamodb: DynamoDBConfig;
  /** CloudWatch configuration */
  monitoring: MonitoringConfig;
  /** Tags applied to all resources */
  tags: Record<string, string>;
}

export interface DomainConfig {
  /** API domain (e.g., api.example.com). Optional: omit to use the default API Gateway URL. */
  apiDomain?: string;
  /** CDN domain for CloudFront (e.g., cdn.example.com). Optional: omit to use the default CloudFront URL. */
  cdnDomain?: string;
  /** Hosted zone ID for Route53 DNS management */
  hostedZoneId?: string;
  /** ACM certificate ARN for API Gateway (must be in same region as API Gateway) */
  certificateArn?: string;
  /** ACM certificate ARN for CloudFront (must be in us-east-1) */
  cloudFrontCertificateArn?: string;
}

export interface DatabaseConfig {
  /** Neon PostgreSQL connection string (pooler endpoint) */
  connectionString: string;
  /** Maximum connections per Lambda container (should be 1) */
  maxConnections: number;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs: number;
}

export interface LambdaConfig {
  /** Default memory size for Lambda functions (MB) */
  defaultMemorySize: number;
  /** Default timeout for Lambda functions (seconds) */
  defaultTimeout: number;
  /** Lambda architecture (ARM64 for cost savings) */
  architecture: 'ARM_64' | 'X86_64';
  /** Log level for Lambda functions */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface StorageConfig {
  /** S3 bucket name for media storage */
  mediaBucketName: string;
  /** Enable versioning for critical assets */
  enableVersioning: boolean;
  /** Lifecycle policies */
  lifecyclePolicies: {
    /** Days before transitioning uploads to deletion */
    uploadsDeletionDays: number;
    /** Days before transitioning old HLS to Glacier */
    hlsGlacierTransitionDays: number;
  };
}

export interface DynamoDBConfig {
  /** Billing mode (on-demand for unpredictable workload) */
  billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED';
  /** TTL settings for automatic record expiration */
  ttl: {
    /** TTL for rate limit counters (seconds) */
    rateLimits: number;
    /** TTL for job metadata (seconds) */
    jobMetadata: number;
  };
}

export interface MonitoringConfig {
  /** CloudWatch log retention (days) */
  logRetentionDays: number;
  /** Enable detailed CloudWatch metrics */
  enableDetailedMetrics: boolean;
  /** Alarm configuration */
  alarms: {
    /** Email for alarm notifications */
    notificationEmail?: string;
    /** Error rate threshold (percentage) */
    errorRateThreshold: number;
    /** p95 latency threshold (milliseconds) */
    latencyThresholdMs: number;
  };
}

/**
 * Get environment configuration based on environment name
 */
export function getEnvironmentConfig(env: string): EnvironmentConfig {
  switch (env) {
    case 'dev':
      return devConfig;
    case 'staging':
      return stagingConfig;
    case 'production':
      return productionConfig;
    default:
      throw new Error(`Unknown environment: ${env}. Must be one of: dev, staging, production`);
  }
}

/**
 * Development environment configuration
 * Used for feature development and testing
 */
const devConfig: EnvironmentConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT || 'PLACEHOLDER_ACCOUNT_ID',
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  environmentName: 'dev',
  bucketPrefix: process.env.BUCKET_PREFIX || 'classroomio',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  domain: {
    apiDomain: process.env.API_DOMAIN,
    cdnDomain: process.env.CDN_DOMAIN,
    hostedZoneId: process.env.HOSTED_ZONE_ID,
    certificateArn: process.env.CERTIFICATE_ARN
  },
  database: {
    connectionString: process.env.DATABASE_URL || '',
    maxConnections: 1,
    connectionTimeoutMs: 10000
  },
  lambda: {
    defaultMemorySize: 512,
    defaultTimeout: 15,
    architecture: 'ARM_64',
    logLevel: 'debug'
  },
  storage: {
    mediaBucketName: 'classroomio-media-dev',
    enableVersioning: true,
    lifecyclePolicies: {
      uploadsDeletionDays: 7,
      hlsGlacierTransitionDays: 90
    }
  },
  dynamodb: {
    billingMode: 'PAY_PER_REQUEST',
    ttl: {
      rateLimits: 86400, // 24 hours
      jobMetadata: 604800 // 7 days
    }
  },
  monitoring: {
    logRetentionDays: 30,
    enableDetailedMetrics: true,
    alarms: {
      notificationEmail: process.env.ALARM_EMAIL,
      errorRateThreshold: 1.0, // 1%
      latencyThresholdMs: 1000 // 1 second
    }
  },
  tags: {
    Environment: 'dev',
    Project: 'ClassroomIO',
    ManagedBy: 'CDK',
    CostCenter: 'Engineering'
  }
};

/**
 * Staging environment configuration
 * Used for pre-production testing and validation
 */
const stagingConfig: EnvironmentConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT || 'PLACEHOLDER_ACCOUNT_ID',
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  environmentName: 'staging',
  bucketPrefix: process.env.BUCKET_PREFIX || 'classroomio',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  domain: {
    apiDomain: process.env.API_DOMAIN,
    cdnDomain: process.env.CDN_DOMAIN,
    hostedZoneId: process.env.HOSTED_ZONE_ID,
    certificateArn: process.env.CERTIFICATE_ARN
  },
  database: {
    connectionString: process.env.DATABASE_URL || '',
    maxConnections: 1,
    connectionTimeoutMs: 10000
  },
  lambda: {
    defaultMemorySize: 512,
    defaultTimeout: 15,
    architecture: 'ARM_64',
    logLevel: 'info'
  },
  storage: {
    mediaBucketName: 'classroomio-media-staging',
    enableVersioning: true,
    lifecyclePolicies: {
      uploadsDeletionDays: 7,
      hlsGlacierTransitionDays: 90
    }
  },
  dynamodb: {
    billingMode: 'PAY_PER_REQUEST',
    ttl: {
      rateLimits: 86400, // 24 hours
      jobMetadata: 604800 // 7 days
    }
  },
  monitoring: {
    logRetentionDays: 30,
    enableDetailedMetrics: true,
    alarms: {
      notificationEmail: process.env.ALARM_EMAIL,
      errorRateThreshold: 1.0, // 1%
      latencyThresholdMs: 1000 // 1 second
    }
  },
  tags: {
    Environment: 'staging',
    Project: 'ClassroomIO',
    ManagedBy: 'CDK',
    CostCenter: 'Engineering'
  }
};

/**
 * Production environment configuration
 * Optimized for performance, reliability, and cost efficiency
 */
const productionConfig: EnvironmentConfig = {
  account: process.env.CDK_DEFAULT_ACCOUNT || 'PLACEHOLDER_ACCOUNT_ID',
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  environmentName: 'production',
  bucketPrefix: process.env.BUCKET_PREFIX || 'classroomio',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  domain: {
    apiDomain: process.env.API_DOMAIN,
    cdnDomain: process.env.CDN_DOMAIN,
    hostedZoneId: process.env.HOSTED_ZONE_ID,
    certificateArn: process.env.CERTIFICATE_ARN
  },
  database: {
    connectionString: process.env.DATABASE_URL || '',
    maxConnections: 1,
    connectionTimeoutMs: 10000
  },
  lambda: {
    defaultMemorySize: 512,
    defaultTimeout: 15,
    architecture: 'ARM_64',
    logLevel: 'info'
  },
  storage: {
    mediaBucketName: 'classroomio-media-production',
    enableVersioning: true,
    lifecyclePolicies: {
      uploadsDeletionDays: 7,
      hlsGlacierTransitionDays: 90
    }
  },
  dynamodb: {
    billingMode: 'PAY_PER_REQUEST',
    ttl: {
      rateLimits: 86400, // 24 hours
      jobMetadata: 604800 // 7 days
    }
  },
  monitoring: {
    logRetentionDays: 90, // Longer retention for production
    enableDetailedMetrics: true,
    alarms: {
      notificationEmail: process.env.ALARM_EMAIL,
      errorRateThreshold: 1.0, // 1%
      latencyThresholdMs: 1000 // 1 second
    }
  },
  tags: {
    Environment: 'production',
    Project: 'ClassroomIO',
    ManagedBy: 'CDK',
    CostCenter: 'Engineering'
  }
};
