import { z } from 'zod';
import { Direction } from '../generated/prisma/enums.ts';

/**
 * Built from the generated enum rather than a literal list, so the union cannot
 * drift from the `Direction` type in Postgres. It also has to hold: since
 * `direction` became a native enum, a value Prisma does not recognize is a
 * `PrismaClientValidationError` — no `P2xxx` code, and a 500 rather than a 422.
 */
export const directionSchema = z.enum(Direction);

/**
 * Not `length(3)`: `USDT` and `SHIB` are 4. The normalization has to run before
 * the format check — chained after, it would reject `" usd "` instead of
 * accepting `USD`.
 */
export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,10}$/, 'must be 2-10 letters or digits');

const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * Always a string on the way out, and never through `parseFloat`: `targetRate`
 * is a Postgres `numeric` precisely so exchange rates keep every digit.
 *
 * A JSON number is accepted for convenience but is the lossy path — `1e-8`
 * stringifies to `"1e-8"` and is rejected here rather than stored in exponential
 * notation. The message points at the fix, which is to send a string.
 */
export const decimalString = z
  .union([z.string(), z.number()])
  .transform((value) => (typeof value === 'string' ? value.trim() : String(value)))
  .refine(
    (value) => PLAIN_DECIMAL.test(value),
    'must be a decimal number written in full, e.g. "0.00000001"',
  )
  .refine((value) => Number(value) > 0, 'must be greater than 0');

/**
 * `z.coerce.boolean()` is `Boolean(value)`, which turns the string `"false"`
 * into `true`. Query strings only ever carry strings, so it is never the right
 * tool here.
 */
const booleanParam = z.enum(['true', 'false']).transform((value) => value === 'true');

export const createAlertSchema = z
  .object({
    baseCurrency: currencyCode,
    quoteCurrency: currencyCode,
    targetRate: decimalString,
    direction: directionSchema,
  })
  // Mirrors `alert_pair_distinct_e7f2bcc4`. Duplicating the database check is
  // deliberate: `P2039` does not say which constraint fired, so the specific
  // wording can only come from here.
  .refine((input) => input.baseCurrency !== input.quoteCurrency, {
    error: 'baseCurrency and quoteCurrency must differ',
    path: ['quoteCurrency'],
  });

/**
 * No `baseCurrency` / `quoteCurrency`: changing the pair turns an alert into a
 * different alert. That is a POST plus a DELETE.
 */
export const updateAlertSchema = z
  .object({
    targetRate: decimalString.optional(),
    direction: directionSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((input) => Object.keys(input).length > 0, 'no fields to update');

/** A malformed id is a 422 from here and never reaches the database. */
export const alertIdParamSchema = z.object({ id: z.uuid() });

export const listAlertsQuerySchema = z.object({
  isActive: booleanParam.optional(),
  baseCurrency: currencyCode.optional(),
  quoteCurrency: currencyCode.optional(),
  direction: directionSchema.optional(),
  triggered: booleanParam.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.uuid().optional(),
});

export type CreateAlertInput = z.infer<typeof createAlertSchema>;
export type UpdateAlertInput = z.infer<typeof updateAlertSchema>;
export type AlertIdParam = z.infer<typeof alertIdParamSchema>;
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;
