import { z } from 'zod';
import type { AlertResponse } from '../mappers/alert.mapper.js';
import type { CurrencyRateResponse } from '../mappers/currency.mapper.js';
import type { UserResponse } from '../mappers/user.mapper.js';
import { currencyCode, directionSchema } from '../schemas/alert.schema.js';
import type { AuthResult, Session } from '../services/auth.service.js';
import { registry } from './json-schema.js';

/**
 * Zod mirrors of the hand-written response types, which are plain TypeScript and
 * so have nothing to convert. The `satisfies` guards are what keep them from
 * lying: `yarn typecheck` catches a missing or mistyped field (TS1360). An
 * *extra* field it does not catch — structural assignability permits it — but
 * the mapper is what builds the body, so that is a wrong document rather than a
 * leaked value.
 *
 * The refresh token is deliberately absent from the session mirrors: it travels
 * as an httpOnly cookie and never appears in a body.
 */

type SessionResponse = Omit<Session, 'refreshToken'>;
type AuthResponse = Omit<AuthResult, 'refreshToken'>;

export const userResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  phoneNumber: z.string().nullable(),
  createdAt: z.iso.datetime(),
}) satisfies z.ZodType<UserResponse>;

export const alertResponseSchema = z.object({
  id: z.uuid(),
  baseCurrency: currencyCode,
  quoteCurrency: currencyCode,
  // Not `decimalString`: the response side is already a string and has no
  // transform to convert.
  targetRate: z.string().meta({ examples: ['5.1204'] }),
  direction: directionSchema,
  isActive: z.boolean(),
  triggeredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}) satisfies z.ZodType<AlertResponse>;

export const alertPageSchema = z.object({
  data: z.array(alertResponseSchema),
  // The id to pass back as `cursor`; `null` on the last page.
  nextCursor: z.string().nullable(),
}) satisfies z.ZodType<{ data: AlertResponse[]; nextCursor: string | null }>;

export const currencyRateResponseSchema = z.object({
  baseCurrency: currencyCode,
  quoteCurrency: currencyCode,
  rate: z.string().meta({ examples: ['5.4321'] }),
  lastUpdatedAt: z.iso.datetime(),
  nextUpdateAt: z.iso.datetime(),
}) satisfies z.ZodType<CurrencyRateResponse>;

export const sessionResponseSchema = z.object({
  accessToken: z.string(),
  // Seconds until `accessToken` expires, so the SPA knows when to refresh.
  expiresIn: z.number().int(),
}) satisfies z.ZodType<SessionResponse>;

export const authResponseSchema = z.object({
  user: userResponseSchema,
  accessToken: z.string(),
  expiresIn: z.number().int(),
}) satisfies z.ZodType<AuthResponse>;

export const meResponseSchema = z.object({
  user: userResponseSchema,
}) satisfies z.ZodType<{ user: UserResponse }>;

export const errorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    // Present on a 422, carrying Zod's `formErrors` / `fieldErrors`, and absent
    // on almost everything else. The SPA must not depend on it.
    details: z.unknown().optional(),
  }),
});

registry.add(userResponseSchema, { id: 'UserResponse' });
registry.add(alertResponseSchema, { id: 'AlertResponse' });
registry.add(alertPageSchema, { id: 'AlertPage' });
registry.add(currencyRateResponseSchema, { id: 'CurrencyRateResponse' });
registry.add(sessionResponseSchema, { id: 'SessionResponse' });
registry.add(authResponseSchema, { id: 'AuthResponse' });
registry.add(meResponseSchema, { id: 'MeResponse' });
registry.add(errorResponseSchema, { id: 'ErrorResponse' });
