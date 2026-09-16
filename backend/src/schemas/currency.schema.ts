import { z } from 'zod';
import { currencyCode } from './alert.schema.js';

/**
 * `usd-brl` is one path segment, not two: the pair is a single identity — it is
 * what an alert is _about_ — and it leaves room for `/currency/usd-brl/history`
 * without the halves drifting apart in the route tree.
 *
 * The split happens here so the controller never sees a string to parse. Both
 * output values are strings, so the result still satisfies Express's
 * `ParamsDictionary` when `validate` writes it back over `req.params`.
 */
const pairSegment = z
  .string()
  .transform((value, ctx) => {
    // The first `-` only: a third part lands in `quoteCurrency`, where
    // `currencyCode`'s `[A-Z0-9]` check rejects the hyphen it still carries.
    const separator = value.indexOf('-');

    if (separator === -1) {
      ctx.addIssue({
        code: 'custom',
        message: "must be two currency codes joined by '-', e.g. 'usd-brl'",
      });

      return z.NEVER;
    }

    return {
      baseCurrency: value.slice(0, separator),
      quoteCurrency: value.slice(separator + 1),
    };
  })
  // Shape, never membership: the upstream owns the list of supported codes and
  // already answers `unsupported-code`, which the service maps to a 404. A local
  // allowlist would be a second source of truth that silently rots.
  .pipe(z.object({ baseCurrency: currencyCode, quoteCurrency: currencyCode }));

export const currencyPairParamSchema = z
  .object({ pair: pairSegment })
  .transform(({ pair }) => pair)
  // `path: ['pair']` so the 422 points at the segment the caller actually sent.
  // Matches `createAlertSchema`'s refine: the upstream answers `usd-usd` with a
  // rate of 1, so rejecting it is our decision, not theirs.
  .refine((pair) => pair.baseCurrency !== pair.quoteCurrency, {
    error: 'baseCurrency and quoteCurrency must differ',
    path: ['pair'],
  });

/**
 * The upstream body, which is remote input — typing it with `as` is a lie that
 * surfaces as `undefined.toFixed is not a function`.
 *
 * A discriminated union on `result` so an error body cannot be mistaken for a
 * rate. Only the fields we read: `documentation`, `terms_of_use` and the `_utc`
 * strings are ignored — the error body even spells it `terms-of-use`, which is
 * another reason not to model the full shape.
 */
export const exchangeRatePairSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('success'),
    base_code: z.string(),
    target_code: z.string(),
    conversion_rate: z.number().positive(),
    time_last_update_unix: z.number().int(),
    time_next_update_unix: z.number().int(),
  }),
  z.object({
    result: z.literal('error'),
    'error-type': z.string(),
  }),
]);

export type CurrencyPairParam = z.infer<typeof currencyPairParamSchema>;
export type ExchangeRatePairResponse = z.infer<typeof exchangeRatePairSchema>;
