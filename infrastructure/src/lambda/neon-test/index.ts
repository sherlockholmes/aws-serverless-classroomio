/**
 * Neon PostgreSQL Connection Test Lambda
 *
 * Task 4.1: Test Neon connection pooling from Lambda
 * Requirements: 2.1, 2.2, 2.3, 2.6, 16.4
 * Design: Components § Neon PostgreSQL Integration
 *
 * This Lambda function tests:
 * 1. Connection establishment with Neon pooler endpoint
 * 2. Connection reuse across invocations (warm start performance)
 * 3. SSL/TLS connection with certificate verification
 * 4. Query execution performance
 * 5. Connection timeout and retry behavior
 *
 * Performance targets:
 * - Cold start connection: <500ms
 * - Warm start query: <10ms overhead
 */

import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

// Configure WebSocket for Neon in Lambda environment
neonConfig.webSocketConstructor = ws;

// Connection pool is created outside the handler
// This allows connection reuse across Lambda invocations
let pool: Pool | null = null;
let connectionCount = 0;
let lastConnectionTime: number | null = null;

/**
 * Initialize connection pool (lazy initialization)
 */
function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    console.log('Creating new Neon connection pool');
    console.log('Connection string format:', connectionString.split('@')[1]?.split('?')[0] || 'invalid');

    pool = new Pool({
      connectionString,
      max: 1, // Lambda = 1 concurrent execution per container
      idleTimeoutMillis: 0, // Never close idle connections (reuse across invocations)
      connectionTimeoutMillis: 10000 // 10 second timeout for connection establishment
    });

    // Log pool events
    pool.on('connect', () => {
      connectionCount++;
      lastConnectionTime = Date.now();
      console.log(`Pool connected (total connections: ${connectionCount})`);
    });

    pool.on('error', (err) => {
      console.error('Pool error:', err);
    });

    pool.on('remove', () => {
      console.log('Client removed from pool');
    });
  }

  return pool;
}

/**
 * Test connection with retry logic for scale-to-zero wake-up
 *
 * Task 4.2: Implement connection retry logic for scale-to-zero
 * Requirements: 2.5, 15.1
 */
async function queryWithRetry<T>(
  queryFn: () => Promise<T>,
  maxRetries: number = 2
): Promise<{ result: T; attempts: number; totalDuration: number }> {
  const startTime = Date.now();

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      console.log(`Query attempt ${attempt}/${maxRetries + 1}`);
      const attemptStart = Date.now();

      const result = await queryFn();

      const attemptDuration = Date.now() - attemptStart;
      const totalDuration = Date.now() - startTime;

      console.log(
        `Query succeeded on attempt ${attempt} (${attemptDuration}ms this attempt, ${totalDuration}ms total)`
      );

      return {
        result,
        attempts: attempt,
        totalDuration
      };
    } catch (error) {
      const isLastAttempt = attempt === maxRetries + 1;

      if (isConnectionError(error)) {
        console.warn(`Connection error on attempt ${attempt}:`, getErrorMessage(error));

        if (!isLastAttempt) {
          // Exponential backoff: 500ms, 1000ms, 2000ms
          const backoffMs = 500 * Math.pow(2, attempt - 1);
          console.log(`Retrying after ${backoffMs}ms backoff...`);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
      }

      // Non-connection error or last attempt failed
      console.error(`Query failed on attempt ${attempt}:`, error);
      throw error;
    }
  }

  throw new Error('Unreachable code');
}

/**
 * Check if error is a connection error (Neon wake-up, timeout, etc.)
 */
function isConnectionError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    message.includes('Connection terminated') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ETIMEDOUT') ||
    message.includes('timeout') ||
    message.includes('connect') ||
    message.includes('ENOTFOUND')
  );
}

/**
 * Extract error message from unknown error type
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Lambda handler
 */
export async function handler(event: any) {
  const startTime = Date.now();

  console.log('Neon connection test Lambda invoked');
  console.log('Event:', JSON.stringify(event, null, 2));
  console.log('Environment:', {
    NODE_ENV: process.env.NODE_ENV,
    AWS_REGION: process.env.AWS_REGION,
    AWS_EXECUTION_ENV: process.env.AWS_EXECUTION_ENV,
    DATABASE_URL_SET: !!process.env.DATABASE_URL
  });

  try {
    const pool = getPool();
    const isWarmStart = connectionCount > 0;

    console.log(`Lambda container state: ${isWarmStart ? 'WARM' : 'COLD'} start`);

    if (lastConnectionTime) {
      const timeSinceLastConnection = Date.now() - lastConnectionTime;
      console.log(`Time since last connection: ${timeSinceLastConnection}ms`);
    }

    // Test 1: Simple query to verify connection
    console.log('\n--- Test 1: Simple SELECT query ---');
    const simpleQueryResult = await queryWithRetry(async () => {
      const result = await pool.query('SELECT NOW() as current_time, version() as pg_version');
      return result.rows[0];
    });

    console.log('Database time:', simpleQueryResult.result.current_time);
    console.log('PostgreSQL version:', simpleQueryResult.result.pg_version);

    // Test 2: Check SSL connection
    console.log('\n--- Test 2: SSL Connection Check ---');
    const sslCheckResult = await queryWithRetry(async () => {
      const result = await pool.query(`
        SELECT 
          ssl.ssl as is_ssl,
          ssl.version as ssl_version,
          ssl.cipher as ssl_cipher
        FROM pg_stat_ssl ssl
        JOIN pg_stat_activity act ON ssl.pid = act.pid
        WHERE act.pid = pg_backend_pid()
      `);
      return result.rows[0];
    });

    console.log('SSL enabled:', sslCheckResult.result.is_ssl);
    console.log('SSL version:', sslCheckResult.result.ssl_version);
    console.log('SSL cipher:', sslCheckResult.result.ssl_cipher);

    // Test 3: Database info
    console.log('\n--- Test 3: Database Information ---');
    const dbInfoResult = await queryWithRetry(async () => {
      const result = await pool.query(`
        SELECT 
          current_database() as database_name,
          current_user as user_name,
          inet_server_addr() as server_address,
          inet_server_port() as server_port
      `);
      return result.rows[0];
    });

    console.log('Database:', dbInfoResult.result.database_name);
    console.log('User:', dbInfoResult.result.user_name);
    console.log('Server:', `${dbInfoResult.result.server_address}:${dbInfoResult.result.server_port}`);

    // Test 4: Performance benchmark
    console.log('\n--- Test 4: Performance Benchmark ---');
    const benchmarkStart = Date.now();
    const iterations = 5;
    const queryTimes: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const iterStart = Date.now();
      await pool.query('SELECT 1');
      const iterDuration = Date.now() - iterStart;
      queryTimes.push(iterDuration);
    }

    const benchmarkDuration = Date.now() - benchmarkStart;
    const avgQueryTime = queryTimes.reduce((a, b) => a + b, 0) / queryTimes.length;
    const minQueryTime = Math.min(...queryTimes);
    const maxQueryTime = Math.max(...queryTimes);

    console.log(`Executed ${iterations} queries in ${benchmarkDuration}ms`);
    console.log(`Query times: ${queryTimes.join('ms, ')}ms`);
    console.log(`Average: ${avgQueryTime.toFixed(2)}ms, Min: ${minQueryTime}ms, Max: ${maxQueryTime}ms`);

    // Calculate total duration
    const totalDuration = Date.now() - startTime;

    // Build response
    const response = {
      success: true,
      containerState: isWarmStart ? 'warm' : 'cold',
      connectionCount,
      totalDuration: `${totalDuration}ms`,
      tests: {
        connection: {
          success: true,
          attempts: simpleQueryResult.attempts,
          duration: `${simpleQueryResult.totalDuration}ms`,
          target: '<500ms for cold start',
          passed: isWarmStart || simpleQueryResult.totalDuration < 500
        },
        ssl: {
          enabled: sslCheckResult.result.is_ssl,
          version: sslCheckResult.result.ssl_version,
          cipher: sslCheckResult.result.ssl_cipher
        },
        database: {
          name: dbInfoResult.result.database_name,
          user: dbInfoResult.result.user_name,
          server: `${dbInfoResult.result.server_address}:${dbInfoResult.result.server_port}`,
          version: simpleQueryResult.result.pg_version
        },
        performance: {
          iterations,
          totalTime: `${benchmarkDuration}ms`,
          avgQueryTime: `${avgQueryTime.toFixed(2)}ms`,
          minQueryTime: `${minQueryTime}ms`,
          maxQueryTime: `${maxQueryTime}ms`,
          target: '<10ms average for warm start',
          passed: isWarmStart ? avgQueryTime < 10 : avgQueryTime < 50
        }
      },
      timestamp: new Date().toISOString()
    };

    console.log('\n--- Test Summary ---');
    console.log(JSON.stringify(response, null, 2));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(response, null, 2)
    };
  } catch (error) {
    console.error('Test failed:', error);

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(
        {
          success: false,
          error: getErrorMessage(error),
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: new Date().toISOString()
        },
        null,
        2
      )
    };
  }
}
