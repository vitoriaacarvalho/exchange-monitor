import { z } from 'zod';

/**
 * Defined once and reused by register and login. Postgres `@unique` is
 * case-sensitive, so the two must normalize identically — otherwise
 * `Ana@x.com` registers a second account that can never be logged into.
 *
 * The normalization has to run *before* the format check: `z.email().trim()`
 * validates first and rejects `" ana@x.com "` outright.
 */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

/**
 * The maximum is the point: argon2's cost scales with input length, so an
 * unbounded password field is a cheap denial of service. Length is the only
 * rule worth enforcing — composition rules push people toward `Passw0rd!`.
 */
export const passwordSchema = z.string().min(8).max(128);

export const registerSchema = z.object({
  name: z.string().trim().min(1),
  email: emailSchema,
  password: passwordSchema,
  phoneNumber: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{8,15}$/, 'must be 8-15 digits, optionally prefixed with +')
    .optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  // Only presence and the denial-of-service cap. A password that is too short
  // is a *wrong* password (401), not a malformed request (422) — applying
  // `passwordSchema` here would answer some bad credentials with a different
  // status than others.
  password: z.string().min(1).max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
