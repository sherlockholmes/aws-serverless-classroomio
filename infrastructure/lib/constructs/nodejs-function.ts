import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../config/environment';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Reusable Lambda Function Construct with ESBuild Bundling
 *
 * Task 5.2: Configure ESBuild bundler for Lambda functions
 * Requirements: 12.2, 12.6
 * Design: Components § Lambda Configuration
 *
 * This construct provides:
 * - Automatic ESBuild bundling with tree-shaking and minification
 * - ARM64 architecture for 20% cost savings
 * - Consistent environment variables and configuration
 * - Automatic CloudWatch log group with KMS encryption
 * - Reserved concurrency configuration
 * - Source maps for debugging
 * - External AWS SDK modules to reduce bundle size
 *
 * Target bundle size: <5MB zipped, <20MB unzipped
 */

export interface NodejsFunctionProps {
  /** Function name (will be prefixed with environment) */
  functionName: string;
  /** Entry point file path (relative to infrastructure/src/lambda/) */
  entry: string;
  /** Handler function name (default: 'handler') */
  handler?: string;
  /** Memory size in MB (default: from config) */
  memorySize?: number;
  /** Timeout in seconds (default: from config) */
  timeout?: number;
  /** Reserved concurrency (default: undefined = unreserved) */
  reservedConcurrentExecutions?: number;
  /** Environment variables (merged with defaults) */
  environment?: Record<string, string>;
  /** CloudWatch log group (if not provided, creates default) */
  logGroup?: logs.ILogGroup;
  /** Description */
  description?: string;
  /** Additional IAM policy statements */
  initialPolicy?: cdk.aws_iam.PolicyStatement[];
  /**
   * Bundle from the monorepo root instead of the Lambda's own folder.
   * Required for handlers that import workspace packages (e.g. @cio/db,
   * better-auth). esbuild resolves workspace + npm deps from the repo's
   * pnpm node_modules and emits a single self-contained index.js.
   * Uses OUTPUT asset hashing to avoid fingerprinting the whole repo.
   */
  bundleFromMonorepoRoot?: boolean;
  /**
   * npm package names that must be excluded from the esbuild bundle
   * (`--external:<pkg>`) and instead installed as real, unflattened
   * `node_modules` packages next to the emitted `index.js` via
   * `npm install` inside the bundling container.
   *
   * Needed for packages whose internals resolve on-disk assets relative
   * to their own `__dirname` at *module load time* (e.g. jsdom's
   * `default-stylesheet.css`, pulled in transitively by
   * `isomorphic-dompurify`). esbuild's single-file bundling flattens
   * every module into `index.js`, so at runtime `__dirname` resolves to
   * the Lambda's own root (`/var/task`) instead of the package's real
   * install location, breaking any `path.resolve(__dirname, '../../x')`
   * walk-up baked into that dependency. Installing the package for real
   * (rather than bundling it) preserves its on-disk layout so those
   * lookups keep working.
   *
   * Only applies when `bundleFromMonorepoRoot` is true. Versions are
   * pinned to whatever's resolved in the repo's pnpm lockfile so the
   * installed copy matches what the rest of the repo runs against.
   */
  externalNodeModules?: string[];
}

/**
 * Resolve the exact version of `pkgName` that pnpm has resolved in the
 * repo's lockfile, so an `npm install <pkg>@<version>` step installs the
 * same code the rest of the repo builds/tests against instead of
 * whatever `npm install <pkg>` would resolve to independently (which can
 * drift, especially for packages with wide semver ranges).
 *
 * Looks for a top-level lockfile entry like `  <pkg>@3.7.1:` or
 * `  <pkg>@3.7.1(peer@1.0.0):` and returns the first version found.
 */
function resolvePinnedVersion(monorepoRoot: string, pkgName: string): string {
  const lockfilePath = path.join(monorepoRoot, 'pnpm-lock.yaml');
  const lockfileContents = fs.readFileSync(lockfilePath, 'utf-8');

  const escapedPkgName = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionPattern = new RegExp(`^  ${escapedPkgName}@([^\\s(:]+)`, 'm');
  const match = versionPattern.exec(lockfileContents);

  if (!match) {
    throw new Error(`resolvePinnedVersion: could not find a resolved version for "${pkgName}" in ${lockfilePath}`);
  }

  return match[1];
}

export class NodejsFunction extends Construct {
  public readonly function: lambda.Function;
  public readonly logGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, config: EnvironmentConfig, props: NodejsFunctionProps) {
    super(scope, id);

    const functionName = `${props.functionName}-${config.environmentName}`;
    const handler = props.handler || 'handler';

    // Resolve entry point path
    // Entry should be relative to infrastructure/src/lambda/
    const lambdaSrcDir = path.join(__dirname, '../../src/lambda');
    const entryPath = path.join(lambdaSrcDir, props.entry);

    // Monorepo bundling: resolve the repo root and the entry path relative to
    // it, so esbuild (run inside Docker with the repo mounted) can follow pnpm
    // workspace symlinks (@cio/db) and bundle every dependency into one file.
    const monorepoRoot = path.join(__dirname, '../../..');
    const entryRelativeToRoot = path.relative(monorepoRoot, entryPath);

    // Create or use provided log group
    this.logGroup =
      props.logGroup ||
      new logs.LogGroup(this, 'LogGroup', {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY
      });

    // Build default environment variables
    const defaultEnvironment: Record<string, string> = {
      NODE_ENV: 'production',
      LOG_LEVEL: config.lambda.logLevel,
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1', // Enable HTTP keep-alive
      DATABASE_URL: config.database.connectionString,
      REGION: config.region
    };

    // externalNodeModules installs real, unflattened npm packages next to
    // index.js (see NodejsFunctionProps.externalNodeModules doc). Those
    // packages are loaded via plain CommonJS `require()` at runtime, and
    // some (e.g. jsdom's `html-encoding-sniffer` -> `@exodus/bytes`, pulled
    // in transitively by isomorphic-dompurify) `require()` an ESM-only
    // file. Node 20.19+ supports require()-ing ES modules, but Lambda's
    // Node 20 runtime disables that experimental feature by default
    // (`--no-experimental-require-module`), which crashes with
    // ERR_REQUIRE_ESM on cold start. AWS's documented fix is to re-enable
    // it via NODE_OPTIONS — see
    // https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html#nodejs-experimental-features.
    // Only applied automatically when externalNodeModules is set (i.e.
    // real on-disk node_modules exist to trigger this); callers can still
    // override NODE_OPTIONS explicitly via `environment`.
    const externalNodeModulesEnvironment: Record<string, string> =
      props.externalNodeModules && props.externalNodeModules.length > 0
        ? { NODE_OPTIONS: '--experimental-require-module' }
        : {};

    // Merge with custom environment variables
    const environment = {
      ...defaultEnvironment,
      ...externalNodeModulesEnvironment,
      ...(props.environment || {})
    };

    // Create Lambda function with NodejsFunction-like bundling
    // We use Function with custom Code instead of NodejsFunction because
    // NodejsFunction requires a local esbuild binary which may not be available
    // Instead, we'll use the standard bundling approach

    this.function = new lambda.Function(this, 'Function', {
      functionName,
      description: props.description || `${props.functionName} Lambda function`,
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: config.lambda.architecture === 'ARM_64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,

      // Code bundling with Docker-based esbuild.
      // Two modes:
      //  - Default: bundle the Lambda's own folder (isolated npm install).
      //  - Monorepo: mount the repo root so esbuild can resolve workspace
      //    packages (@cio/db → better-auth, drizzle) into one self-contained
      //    file. OUTPUT hashing avoids fingerprinting the entire repo.
      code: props.bundleFromMonorepoRoot
        ? lambda.Code.fromAsset(monorepoRoot, {
            assetHashType: cdk.AssetHashType.OUTPUT,
            bundling: {
              image: lambda.Runtime.NODEJS_20_X.bundlingImage,
              command: [
                'bash',
                '-c',
                [
                  'npm install -g esbuild@0.23.0',
                  [
                    `esbuild ${entryRelativeToRoot}`,
                    '--bundle --minify --sourcemap --platform=node --target=node20',
                    '--external:@aws-sdk/*',
                    ...(props.externalNodeModules || []).map((pkgName) => `--external:${pkgName}`),
                    '--alias:bcrypt=bcryptjs',
                    '--outfile=/asset-output/index.js'
                  ].join(' '),
                  // externalNodeModules packages resolve on-disk assets
                  // relative to their own __dirname at module load time
                  // (e.g. jsdom's default-stylesheet.css, pulled in by
                  // isomorphic-dompurify). esbuild's single-file bundle
                  // flattens __dirname to the Lambda root, breaking those
                  // relative lookups, so these packages are installed for
                  // real (unflattened, on-disk node_modules) instead of
                  // bundled. Versions are pinned to the repo's pnpm lockfile
                  // resolution to match what the rest of the repo runs.
                  // This runs after esbuild and does not touch index.js/map.
                  ...(props.externalNodeModules && props.externalNodeModules.length > 0
                    ? [
                        'cd /asset-output',
                        'npm init -y',
                        `npm install ${props.externalNodeModules
                          .map((pkgName) => `${pkgName}@${resolvePinnedVersion(monorepoRoot, pkgName)}`)
                          .join(' ')}`
                      ]
                    : [])
                ].join(' && ')
              ],
              user: 'root',
              environment: {
                NODE_ENV: 'production'
              }
            }
          })
        : lambda.Code.fromAsset(path.dirname(entryPath), {
            bundling: {
              image: lambda.Runtime.NODEJS_20_X.bundlingImage,
              command: [
                'bash',
                '-c',
                [
                  'npm install',
                  'npm install -g esbuild@0.19.12',
                  `esbuild ${path.basename(entryPath)} --bundle --minify --sourcemap --platform=node --target=node20 --external:@aws-sdk/* --outfile=/asset-output/index.js`
                ].join(' && ')
              ],
              user: 'root',
              environment: {
                NODE_ENV: 'production'
              }
            }
          }),
      handler: `index.${handler}`,

      memorySize: props.memorySize || config.lambda.defaultMemorySize,
      timeout: cdk.Duration.seconds(props.timeout || config.lambda.defaultTimeout),
      reservedConcurrentExecutions: props.reservedConcurrentExecutions,

      environment,

      logGroup: this.logGroup,

      // Tracing for X-Ray (optional, can be enabled later)
      tracing: lambda.Tracing.DISABLED,

      // Initial IAM policy statements
      initialPolicy: props.initialPolicy || []
    });

    // Apply tags
    Object.entries(config.tags).forEach(([key, value]) => {
      cdk.Tags.of(this.function).add(key, value);
    });

    // Add Lambda function name tag
    cdk.Tags.of(this.function).add('FunctionName', functionName);

    // Outputs
    new cdk.CfnOutput(this, 'FunctionArn', {
      value: this.function.functionArn,
      description: `ARN for ${functionName}`,
      exportName: `${config.environmentName}-${props.functionName}-arn`
    });

    new cdk.CfnOutput(this, 'FunctionName', {
      value: this.function.functionName,
      description: `Function name for ${functionName}`,
      exportName: `${config.environmentName}-${props.functionName}-name`
    });
  }

  /**
   * Grant the Lambda function permissions to read from a DynamoDB table
   */
  public grantDynamoDBRead(table: cdk.aws_dynamodb.ITable): void {
    table.grantReadData(this.function);
  }

  /**
   * Grant the Lambda function permissions to write to a DynamoDB table
   */
  public grantDynamoDBWrite(table: cdk.aws_dynamodb.ITable): void {
    table.grantWriteData(this.function);
  }

  /**
   * Grant the Lambda function full permissions to a DynamoDB table
   */
  public grantDynamoDBReadWrite(table: cdk.aws_dynamodb.ITable): void {
    table.grantReadWriteData(this.function);
  }

  /**
   * Grant the Lambda function permissions to read from an S3 bucket
   */
  public grantS3Read(bucket: cdk.aws_s3.IBucket): void {
    bucket.grantRead(this.function);
  }

  /**
   * Grant the Lambda function permissions to write to an S3 bucket
   */
  public grantS3Write(bucket: cdk.aws_s3.IBucket): void {
    bucket.grantWrite(this.function);
  }

  /**
   * Grant the Lambda function full permissions to an S3 bucket
   */
  public grantS3ReadWrite(bucket: cdk.aws_s3.IBucket): void {
    bucket.grantReadWrite(this.function);
  }

  /**
   * Add environment variable to the function
   */
  public addEnvironment(key: string, value: string): void {
    this.function.addEnvironment(key, value);
  }

  /**
   * Add IAM policy statement to the function
   */
  public addToRolePolicy(statement: cdk.aws_iam.PolicyStatement): void {
    this.function.addToRolePolicy(statement);
  }
}
