import { z } from 'zod';

/**
 * Validated, immutable view of the process environment.
 *
 * Secrets live ONLY in env (never /tmp, never logs). We validate at first access so a
 * misconfigured deployment fails loudly at the edge instead of midway through an import.
 */
const EnvSchema = z.object({
  ACTUAL_SERVER_URL: z.string().url(),
  ACTUAL_PASSWORD: z.string().min(1),
  ACTUAL_SYNC_ID: z.string().min(1),
  // Vercel functions are read-only except /tmp — this MUST live under /tmp in production.
  ACTUAL_DATA_DIR: z.string().min(1).default('/tmp/actual-data'),

  CRON_SECRET: z.string().min(1),

  // Investec reference plugin. Optional so the engine still boots without it configured.
  INVESTEC_CLIENT_ID: z.string().optional(),
  INVESTEC_CLIENT_SECRET: z.string().optional(),
  INVESTEC_API_KEY: z.string().optional(),
  INVESTEC_ACCOUNT_MAP: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw) return {} as Record<string, string>;
      try {
        const parsed = JSON.parse(raw) as unknown;
        return z.record(z.string(), z.string().uuid()).parse(parsed);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `INVESTEC_ACCOUNT_MAP is not valid JSON map of {accountId: uuid}: ${String(err)}`,
        });
        return z.NEVER;
      }
    }),
});

export type EngineConfig = Readonly<z.infer<typeof EnvSchema>>;

let cached: EngineConfig | undefined;

/** Parse + cache the environment. Throws a readable error on misconfiguration. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  if (cached) return cached;
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = Object.freeze(result.data);
  return cached;
}

/** Test-only: clear the memoized config. */
export function resetConfigCache(): void {
  cached = undefined;
}
