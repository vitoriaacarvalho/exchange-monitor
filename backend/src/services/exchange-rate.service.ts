import { env } from '../config/env.js';
import { toCurrencyRateResponse, type CurrencyRateResponse } from '../mappers/currency.mapper.js';
import { exchangeRatePairSchema } from '../schemas/currency.schema.js';
import { badGateway, HttpError, notFound, serviceUnavailable } from '../shared/http-error.js';

/**
 * The only module that talks to ExchangeRate-API.
 *
 * The base URL is a constant rather than an env var: there is no staging
 * ExchangeRate-API. The key is not — it comes from `env`, is validated at boot,
 * and **must never reach a log line or a response body**. It sits in the request
 * URL, so the rule is concrete: never log the URL, and never attach the caught
 * upstream `Error` (whose message can carry it) to an `HttpError`'s `details`.
 */
const BASE_URL = 'https://v6.exchangerate-api.com/v6';

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * The upstream hands us the exact moment its answer goes stale, which beats any
 * TTL we could invent — on the free plan that is 24 hours out, so without this
 * one user refreshing a page drains the monthly quota.
 *
 * Clamped all the same: a missing, past or absurd `time_next_update_unix` must
 * not pin a stale rate forever, nor collapse to re-fetching on every request.
 */
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

type CacheEntry = {
  rate: CurrencyRateResponse;
  expiresAt: number;
};

/**
 * Per-process and lost on restart, deliberately — the same in-process
 * pragmatism as the refresh-token sweep in `server.ts`. Nothing runs on a
 * timer: entries are populated lazily on a miss. The *mapped* value is stored,
 * not the raw body, so a hit and a miss cannot answer with different shapes.
 */
const cache = new Map<string, CacheEntry>();

/**
 * Whose fault the failure is decides the status. The caller's fault is a 4xx;
 * our misconfiguration is a 500 — it is not the caller's problem that the key is
 * wrong, and a 4xx would invite a retry that cannot succeed.
 *
 * All three 500s share one wording deliberately: the caller can do nothing with
 * the difference, and the `error-type` that distinguishes them is in the log.
 */
const misconfigured = (): HttpError =>
  new HttpError(500, 'exchange rate provider is misconfigured');

/**
 * A `Map`, not an object literal: the lookup key is remote input, and an
 * `error-type` of `constructor` would find `Object.prototype`'s and throw
 * something that is not an `Error` at all.
 */
const ERROR_TYPE_STATUS = new Map<string, (pair: string) => HttpError>([
  // Never says which half was bad, because the upstream does not say.
  ['unsupported-code', (pair) => notFound(`no exchange rate available for ${pair}`)],
  ['quota-reached', () => serviceUnavailable('exchange rate quota exhausted, try again later')],
  ['invalid-key', misconfigured],
  // The account email was never confirmed.
  ['inactive-account', misconfigured],
  // We build the URL, so this is our bug, not theirs.
  ['malformed-request', misconfigured],
]);

function cacheKey(baseCurrency: string, quoteCurrency: string): string {
  return `${baseCurrency}-${quoteCurrency}`;
}

function expiryFrom(nextUpdateUnix: number, now: number): number {
  const ttl = nextUpdateUnix * 1000 - now;

  return now + Math.min(Math.max(ttl, MIN_TTL_MS), MAX_TTL_MS);
}

export async function getRate(
  baseCurrency: string,
  quoteCurrency: string,
): Promise<CurrencyRateResponse> {
  const key = cacheKey(baseCurrency, quoteCurrency);
  const cached = cache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.rate;
  }

  let response: Response;

  try {
    // No timeout means a hung upstream holds a connection until the client
    // gives up.
    response = await fetch(
      `${BASE_URL}/${env.EXCHANGE_RATE_API_KEY}/pair/${baseCurrency}/${quoteCurrency}`,
      {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    // Name and message only — never the error object and never the URL, which
    // carries the key. For the same reason it is not passed as `details`, where
    // it would be rendered into the response body.
    console.error('[exchange-rate] upstream request failed', {
      key,
      ...(error instanceof Error && { name: error.name, message: error.message }),
    });

    throw badGateway('exchange rate provider is unreachable');
  }

  // Read the body *before* looking at `response.status`. Errors arrive as
  // 403/404 carrying `{"result":"error","error-type":...}`, so the reflex
  // `if (!response.ok) throw badGateway()` turns a currency that does not exist
  // into a "bad gateway". The status is only a fallback, below, for a body that
  // will not parse.
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    console.error('[exchange-rate] upstream response was not JSON', {
      key,
      status: response.status,
    });

    throw badGateway('exchange rate provider returned an unreadable response');
  }

  const parsed = exchangeRatePairSchema.safeParse(body);

  // Caught at the boundary and rethrown: `errorHandler` renders any `ZodError`
  // as a 422, so letting this one propagate would report an upstream shape
  // change as *our caller's* validation error. A `ZodError` escaping this module
  // is always a bug.
  if (!parsed.success) {
    console.error('[exchange-rate] unexpected upstream response shape', {
      key,
      status: response.status,
      issues: parsed.error.issues,
    });

    throw badGateway('unexpected response from the exchange rate provider');
  }

  if (parsed.data.result === 'error') {
    const errorType = parsed.data['error-type'];

    console.error('[exchange-rate] upstream returned an error', {
      key,
      status: response.status,
      errorType,
    });

    // An `error-type` the upstream added since this was written is a 502: we do
    // not know whose fault it is.
    throw ERROR_TYPE_STATUS.get(errorType)?.(key) ?? badGateway();
  }

  const rate = toCurrencyRateResponse(baseCurrency, quoteCurrency, parsed.data);

  // Successes only. A `quota-reached` cached for a day outlives the quota reset.
  cache.set(key, {
    rate,
    expiresAt: expiryFrom(parsed.data.time_next_update_unix, Date.now()),
  });

  return rate;
}
