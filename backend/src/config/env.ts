import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the app reads, parsed exactly once at import time.
 *
 * Importing this module is what validates the environment, so a missing or
 * malformed variable crashes the process on boot with a readable message
 * instead of, say, signing tokens with an `undefined` secret at 3am.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3333),
  DATABASE_URL: z.string().min(1, 'required: the PostgreSQL connection string'),

  // At least 32 chars so HS256 is keyed with something worth signing with.
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters (openssl rand -base64 48)'),

  // A `jose` duration: a number plus s/m/h/d. Validated here so a typo fails on
  // boot rather than on the first login.
  ACCESS_TOKEN_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, "must look like '15m', '1h' or '7d'")
    .default('15m'),

  // Arithmetic, not a string — it becomes the refresh cookie's maxAge.
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Credentialed CORS forbids a wildcard, so the SPA origin must be explicit.
  // The trailing slash is trimmed because browsers send `Origin` without one.
  CORS_ORIGIN: z.url().transform((origin) => origin.replace(/\/$/, '')),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');

  throw new Error(`Invalid environment variables:\n${details}`);
}

export const env = parsed.data;

export type Env = typeof env;
