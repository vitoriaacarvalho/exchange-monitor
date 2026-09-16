import { Prisma } from '../generated/prisma/client.ts';

export type CurrencyRateResponse = {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  lastUpdatedAt: string;
  nextUpdateAt: string;
};

type UpstreamRate = {
  conversion_rate: number;
  time_last_update_unix: number;
  time_next_update_unix: number;
};

/**
 * Built field by field, like `toAlertResponse` — never a spread of the upstream
 * body, which would leak `documentation` and `terms_of_use` into our API and
 * make their JSON shape our contract.
 *
 * The codes come from **our** parsed param rather than `base_code` /
 * `target_code`, so the response always echoes what was asked for.
 *
 * `conversion_rate` is a JSON number, so there is no hidden precision to
 * preserve — but `String(1e-7)` is `"1e-7"`, and an exchange rate in exponential
 * notation reaching the SPA is the bug `toAlertResponse`'s `.toFixed()` exists
 * to prevent. Hyperinflated currencies (IRR, LBP, VES) live in that range.
 * Wrapping does not invent precision; it only controls how the double is written.
 */
export function toCurrencyRateResponse(
  baseCurrency: string,
  quoteCurrency: string,
  upstream: UpstreamRate,
): CurrencyRateResponse {
  return {
    baseCurrency,
    quoteCurrency,
    rate: new Prisma.Decimal(upstream.conversion_rate).toFixed(),
    // `* 1000`: the upstream sends seconds and `Date` takes milliseconds, and
    // forgetting it dates the rate to 1970.
    lastUpdatedAt: new Date(upstream.time_last_update_unix * 1000).toISOString(),
    nextUpdateAt: new Date(upstream.time_next_update_unix * 1000).toISOString(),
  };
}
