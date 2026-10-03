/**
 * Unit tests for `resolveEmailProvider()` (Task 5.1).
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Design: Decision 4 "Provider selection is deployment-target based, not
 * just env-var presence"
 *
 * Each test mutates `process.env` directly and re-imports the module fresh
 * (vitest's `vi.resetModules()`) since `env` is parsed once at module load
 * time via `envSchema.parse(process.env)`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['EMAIL_PROVIDER', 'AWS_LAMBDA_FUNCTION_NAME', 'ZOHO_TOKEN'] as const;
const originalEnv: Record<string, string | undefined> = {};

for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  vi.resetModules();
});

async function loadResolver() {
  vi.resetModules();
  const mod = await import('../src/config/env');
  return mod.resolveEmailProvider;
}

describe('resolveEmailProvider', () => {
  it('returns the explicit EMAIL_PROVIDER value when set, even inside a Lambda', async () => {
    process.env.EMAIL_PROVIDER = 'smtp';
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'email-worker-dev';
    delete process.env.ZOHO_TOKEN;

    const resolveEmailProvider = await loadResolver();

    expect(resolveEmailProvider()).toBe('smtp');
  });

  it('returns "ses" when running inside AWS Lambda and EMAIL_PROVIDER is unset', async () => {
    delete process.env.EMAIL_PROVIDER;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'email-worker-dev';
    delete process.env.ZOHO_TOKEN;

    const resolveEmailProvider = await loadResolver();

    expect(resolveEmailProvider()).toBe('ses');
  });

  it('ignores an accidentally-set ZOHO_TOKEN inside a Lambda (still resolves to ses)', async () => {
    delete process.env.EMAIL_PROVIDER;
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'email-worker-dev';
    process.env.ZOHO_TOKEN = 'accidental-leftover-token';

    const resolveEmailProvider = await loadResolver();

    expect(resolveEmailProvider()).toBe('ses');
  });

  it('falls back to "zeptomail" locally when ZOHO_TOKEN is set and not in a Lambda', async () => {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    process.env.ZOHO_TOKEN = 'local-dev-token';

    const resolveEmailProvider = await loadResolver();

    expect(resolveEmailProvider()).toBe('zeptomail');
  });

  it('falls back to "smtp" locally when neither ZOHO_TOKEN nor a Lambda context is present', async () => {
    delete process.env.EMAIL_PROVIDER;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.ZOHO_TOKEN;

    const resolveEmailProvider = await loadResolver();

    expect(resolveEmailProvider()).toBe('smtp');
  });
});
