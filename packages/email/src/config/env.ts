import * as z from 'zod';

const envSchema = z.object({
  SMTP_HOST: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_SENDER: z.string().optional(),
  SMTP_USER: z.string().optional(),

  ZOHO_TOKEN: z.string().optional(),

  /**
   * Explicit email transport selector. When set, this always wins over the
   * Lambda-context/credential-presence inference below.
   *
   * Spec: .kiro/specs/ses-email-delivery
   * Requirement 4.2: THE Email_Package SHALL select the SES provider by
   * default in the AWS deployment, with the existing ZeptoMail/SMTP
   * providers either removed or kept only as a documented local-dev
   * fallback.
   */
  EMAIL_PROVIDER: z.enum(['ses', 'zeptomail', 'smtp']).optional(),

  /**
   * SES configuration set name (see infrastructure/lib/stacks/api-stack.ts
   * SesConfigurationSet). Passed on every SES send call so bounce/complaint
   * events flow through the configured CloudWatch event destination
   * (Requirement 5.1).
   */
  SES_CONFIGURATION_SET_NAME: z.string().optional(),

  /** Set by the Lambda runtime itself — used only to detect "are we running
   * inside AWS Lambda" for the default-provider inference below. Never set
   * this manually; it is not a real configuration knob. */
  AWS_LAMBDA_FUNCTION_NAME: z.string().optional()
});

export const env = envSchema.parse(process.env);

export type EmailProvider = 'ses' | 'zeptomail' | 'smtp';

/**
 * Resolves which transport `packages/email` should use to actually deliver
 * mail.
 *
 * Spec: .kiro/specs/ses-email-delivery
 * Task: 5.1 "Add EMAIL_PROVIDER config and Lambda-context detection"
 * Design: Decision 4 "Provider selection is deployment-target based, not
 * just env-var presence"
 *
 * Resolution order:
 *   1. `EMAIL_PROVIDER` env var, if set — always wins, for explicit overrides
 *      (e.g. forcing 'smtp' in a Lambda for a one-off test).
 *   2. Running inside AWS Lambda (`AWS_LAMBDA_FUNCTION_NAME` present) -> 'ses'.
 *      This is deliberately NOT inferred from "does ZOHO_TOKEN happen to be
 *      set" — an accidentally-set ZOHO_TOKEN in a Lambda's environment must
 *      not silently skip SES (see design.md's rejected alternative).
 *   3. Otherwise (local dev, apps/api, apps/jobs) -> fall back to the
 *      existing ZOHO_TOKEN-presence inference for backward compatibility
 *      with the pre-SES local dev setup (Requirement 7).
 */
export function resolveEmailProvider(): EmailProvider {
  if (env.EMAIL_PROVIDER) {
    return env.EMAIL_PROVIDER;
  }

  if (env.AWS_LAMBDA_FUNCTION_NAME) {
    return 'ses';
  }

  return env.ZOHO_TOKEN ? 'zeptomail' : 'smtp';
}
