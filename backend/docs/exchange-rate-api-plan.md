# Plan — ExchangeRate-API integration

Implementation plan for `GET /currency/:pair`, reading live rates from
[ExchangeRate-API](https://www.exchangerate-api.com/docs/overview) through a new
`ExchangeRateService`. Same routes → controllers → services layering as
[alerts-crud-plan.md](alerts-crud-plan.md), which is assumed landed (it is).

Written 2026-09-14. **Out of scope by instruction:** no job, no scheduler, no
alert evaluation. This plan builds one read endpoint a human can call, and the
service the evaluator will later reuse — nothing that runs on its own.

**Scope**

- [ ] `EXCHANGE_RATE_API_KEY` wired through `config/env.ts`
- [ ] `GET /currency/usd-brl` — pair as a single path segment
- [ ] `services/exchange-rate.service.ts` — the only file that talks to the upstream
- [ ] In-process cache, expiring at the upstream's own next-update time
- [ ] Upstream `error-type` → HTTP status mapping
- [ ] Zod schemas for the path param **and** the upstream response

---

## Verified against the live API, 2026-09-14

Probed with the key already in `.env`, before writing any of this. Four results
the plan is built on:

**The key works and the account is on the free plan.** `pair/USD/BRL` returned
`conversion_rate: 5.1204`, `time_last_update_utc: "Mon, 14 Sep 2026 00:00:02
+0000"`, `time_next_update_utc: "Tue, 15 Sep 2026 00:00:02 +0000"`. **The gap is
24 hours, not the hourly cadence the docs' examples imply.** Every request
inside that window is quota spent on a number that cannot have changed — which
is decision 4.

**Errors arrive with a non-2xx HTTP status, not a 200 carrying `result:
"error"`.** `pair/USD/XYZ` → **404** with `{"result":"error","error-type":
"unsupported-code"}`; a bad key → **403** with `error-type: "invalid-key"`. This
is the trap in the whole integration: the reflex `if (!response.ok) throw
badGateway()` turns _every_ upstream error into a 502, so a caller asking for a
currency that does not exist gets "bad gateway" instead of "unsupported
currency". **Read and parse the body first; branch on `error-type`; use the HTTP
status only as a fallback when the body will not parse.** See step 6.

**`pair/USD/USD` is a 200 with `conversion_rate: 1`.** The upstream does not
mind a degenerate pair, so rejecting `usd-usd` is our decision, not theirs —
decision 2 makes it a 422, matching `createAlertSchema`'s
`baseCurrency !== quoteCurrency` refine.

**A malformed path gets nginx's HTML 404, not JSON.** We build the URL
ourselves so it should be unreachable, but it is the proof that an unparseable
body is a real response shape and has to land somewhere sane (502).

---

## Decisions

**1. The pair is one path segment, split by a Zod transform.**
`GET /currency/usd-brl`, not `/currency/usd/brl`. The pair reads as one identity
— it is what an alert is _about_ — and it keeps the door open for
`/currency/usd-brl/history` later without the base and quote drifting apart in
the route tree.

The split happens in the schema, so the controller never sees a string to
parse:

```ts
export const currencyPairParamSchema = z.object({ pair: z.string() }).transform(...)
// { pair: 'usd-brl' }  ->  { baseCurrency: 'USD', quoteCurrency: 'BRL' }
```

`validate({ params })` already writes the parsed result back over `req.params`,
and the controller is typed `RequestHandler<CurrencyPairParam>` — exactly the
pattern `alert.controller.ts` uses for `AlertIdParam`, and the reason
`req.params` is not Express 5's `string | string[]`. Both output values are
strings, so the result still satisfies Express's `ParamsDictionary`.

**Locked.**

**2. The path param is validated for _shape_, not for _membership_.** Reuse
`currencyCode` from [`alert.schema.ts`](../src/schemas/alert.schema.ts) on each
half — it already trims, uppercases, and enforces `[A-Z0-9]{2,10}`, in that
order, which is what makes `/currency/usd-brl` work at all. Add the same
`baseCurrency !== quoteCurrency` refine, as a 422.

Do **not** hardcode a list of supported ISO codes. The upstream owns that list,
it changes, and it already answers `unsupported-code` (decision 5 maps it to a
404). A local allowlist would be a second source of truth that silently rots.

The cost: `currencyCode` accepts `USDT`, which ExchangeRate-API does not
support, so that request spends one upstream call to learn it is a 404. That is
the right trade — the alternative rejects a code the day the upstream starts
supporting it.

**Locked.**

**3. `rate` leaves as a string, rendered through `Prisma.Decimal`.**
`conversion_rate` arrives as a JSON number, so there is no hidden precision to
preserve — but `String(1e-7)` is `"1e-7"`, and an exchange rate in exponential
notation reaching the SPA is precisely the bug decision 3 of the alerts plan
exists to prevent. Hyperinflated currencies (IRR, LBP, VES) live in that range.

Probed on this codebase:

| value       | `String(v)` | `new Prisma.Decimal(v).toFixed()` |
| ----------- | ----------- | --------------------------------- |
| `5.3721`    | `5.3721`    | `5.3721`                          |
| `0.0000238` | `0.0000238` | `0.0000238`                       |
| `1e-7`      | **`1e-7`**  | `0.0000001`                       |

So the mapper calls `new Prisma.Decimal(rate).toFixed()`, the same `.toFixed()`
discipline as `toAlertResponse`. The bonus is that `rate` and `targetRate` then
have one shared representation, which is what the comparison will need the day
the evaluator lands.

Wrapping does not invent precision — it only controls how the double is
written.

**Locked.**

**4. Cache in-process, expiring at `time_next_update_unix`.** A `Map` keyed by
`"USD-BRL"`, holding the already-mapped response plus its expiry. Populated
lazily on a miss; nothing runs on a timer, so this is not the job the brief
excludes.

The upstream hands us the exact moment its answer goes stale, which beats any
TTL we could invent — and on the free plan that is 24 hours out (see the probe
above), so without this, one user refreshing a page drains the monthly quota.

Three guards:

- **Clamp the TTL** to `[60s, 24h]`. A missing, past, or absurd
  `time_next_update_unix` must not pin a stale rate forever, nor collapse to
  re-fetching on every request.
- **Cache successes only.** Never store an error — a `quota-reached` cached for
  a day outlives the quota reset.
- **Cache the mapped value**, not the raw body, so a cache hit and a cache miss
  cannot answer with different shapes.

Per-process and lost on restart, which is fine and deliberate — the same
in-process pragmatism as the refresh-token sweep in
[`server.ts`](../src/server.ts). Multiple instances would each keep their own;
see [Open questions](#open-questions).

**Locked.**

**5. Upstream failures map to HTTP by whose fault they are.** The caller's
fault is a 4xx; our misconfiguration is a 500 — it is not the caller's problem
that the key is wrong, and a 4xx would invite a retry that cannot succeed.

| upstream                | ours    | why                                                                                                    |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `unsupported-code`      | **404** | The pair does not exist. Message names the pair, never which half was bad — the upstream does not say. |
| `quota-reached`         | **503** | Genuinely retry-later. The SPA can say so honestly.                                                    |
| `invalid-key`           | **500** | We are misconfigured.                                                                                  |
| `inactive-account`      | **500** | Same — the account email was never confirmed.                                                          |
| `malformed-request`     | **500** | We built the URL; this is our bug.                                                                     |
| body will not parse     | **502** | Includes the nginx HTML 404 from the probe.                                                            |
| network error / timeout | **502** | `AbortSignal.timeout` — see step 6.                                                                    |

**The API key must never reach a log line or a response body.** It sits in the
request URL, so the rule is concrete: never log the URL, never attach the
upstream `Error` (whose message can carry it) to an `HttpError`'s `details`. Log
the `error-type` and the pair.

`http-error.ts` has no 502 or 503 helper yet — step 4 adds them.

**Locked.**

**6. The upstream response is parsed by Zod, and its failure is a 502.** The
body is remote input; typing it with `as` is a lie that surfaces as
`undefined.toFixed is not a function`.

The subtle part: **`errorHandler` renders any `ZodError` as a 422.** If the
service lets its own parse failure propagate, an upstream that changes its JSON
shape is reported to our caller as _their_ validation error. So the service
catches the parse failure at the boundary and rethrows `badGateway()`. A
`ZodError` escaping this module is always a bug.

**Locked.**

---

## Phase 0 — Environment

1. Add to the schema in [`config/env.ts`](../src/config/env.ts), beside the
   other secrets:

   ```ts
   EXCHANGE_RATE_API_KEY: z.string().min(1, 'required: your exchangerate-api.com key'),
   ```

   Import-time validation is the whole point — a missing key fails on boot with
   a readable message instead of on the first `/currency` call.

   The **base URL is a module constant in the service, not an env var**. It is
   not per-environment; there is no staging ExchangeRate-API.

2. Tidy [`.env.example`](../.env.example): the line is currently
   `EXCHANGE_RATE_API_KEY=123` with no comment and no trailing newline. Give it
   the same treatment as the block above it —

   ```
   # ExchangeRate-API — free key from https://app.exchangerate-api.com/sign-up
   EXCHANGE_RATE_API_KEY=
   ```

   — and end the file with a newline.

3. Nothing to install. Node 24 ships global `fetch` and `AbortSignal.timeout`;
   `zod` is already a dependency. No `axios`, no `node-fetch`.

## Phase 1 — Shared infrastructure

4. [`shared/http-error.ts`](../src/shared/http-error.ts) — two helpers,
   matching the existing ones exactly:

   ```ts
   export const badGateway = (message = 'bad gateway', details?: unknown): HttpError =>
     new HttpError(502, message, details);

   /** Retry-later: the upstream is fine, it is rate or quota that ran out. */
   export const serviceUnavailable = (
     message = 'service unavailable',
     details?: unknown,
   ): HttpError => new HttpError(503, message, details);
   ```

   `errorHandler` already renders any `HttpError` as `{ error: { message } }`,
   so nothing there changes.

## Phase 2 — Currency module

Five files, mirroring the alert module's layout:

```
src/
  routes/currency.routes.ts
  controllers/currency.controller.ts
  services/exchange-rate.service.ts
  schemas/currency.schema.ts
  mappers/currency.mapper.ts
```

Relative imports carry the `.js` extension (`../shared/http-error.js`); only the
generated Prisma files are imported with `.ts`. Match the neighbours.

### 5. `schemas/currency.schema.ts` — all Zod, no Express, no fetch

- `currencyPairParamSchema` — `{ pair: string }` in, `{ baseCurrency,
quoteCurrency }` out (decision 1). Split on the **first** `-`, run each half
  through `currencyCode` imported from `alert.schema.js`, then `.refine()` that
  the two differ with `path: ['pair']` so the 422 points at the segment the
  caller actually sent. A pair with no `-`, or with three parts, fails here and
  never reaches the network.
- `exchangeRatePairSchema` — the upstream success body, as a **discriminated
  union on `result`** so an error body cannot be mistaken for a rate:

  ```ts
  z.discriminatedUnion('result', [
    z.object({
      result: z.literal('success'),
      base_code: z.string(),
      target_code: z.string(),
      conversion_rate: z.number().positive(),
      time_last_update_unix: z.number().int(),
      time_next_update_unix: z.number().int(),
    }),
    z.object({ result: z.literal('error'), 'error-type': z.string() }),
  ]);
  ```

  Only the fields we use — `documentation`, `terms_of_use` and the `_utc`
  strings are ignored, and the unix timestamps are what the mapper and the cache
  read. Note the error body spells it `terms-of-use` with hyphens where the
  success body uses `terms_of_use`; another reason not to model the full shape.

- Export `CurrencyPairParam` and `ExchangeRatePairResponse` as inferred types.

### 6. `services/exchange-rate.service.ts` — the only file that calls the upstream

The module the user asked for as `ExchangeRateService`, written the way this
codebase writes services: exported functions, imported as
`import * as exchangeRateService`. One public function —

```ts
export async function getRate(baseCurrency: string, quoteCurrency: string): Promise<CurrencyRate>;
```

— reading, in order:

1. **Cache lookup** (decision 4). Key the `Map` on `` `${baseCurrency}-${quoteCurrency}` ``;
   return it if `expiresAt > Date.now()`, otherwise fall through and let the
   entry be overwritten.
2. **Fetch**, with `signal: AbortSignal.timeout(5000)` — no timeout means a
   hung upstream holds a connection until the client gives up. Wrap the `fetch`
   in `try/catch`: a network failure or an abort is `badGateway('exchange rate
provider is unreachable')`, and **the caught error is logged but never
   attached as `details`** (decision 5 — it can carry the URL, and the URL
   carries the key).
3. **`await response.json()`, before looking at `response.status`.** This is the
   probe's main finding: errors come back as 403/404 with a JSON body, and
   status-first control flow throws that body away. A `json()` that itself
   throws is the unparseable case → `badGateway()`.
4. **Parse** with `exchangeRatePairSchema.safeParse`. `success: false` →
   `badGateway('unexpected response from the exchange rate provider')`, never a
   rethrown `ZodError` (decision 6).
5. **Branch on `result`.** `'error'` → a lookup table from `error-type` to the
   helper in decision 5's table, defaulting to `badGateway()` for an
   `error-type` that is not in the table (the upstream can add one). Log
   `{ errorType, baseCurrency, quoteCurrency }` — never the URL.
6. **Map and cache.** Build the domain value via the mapper, store it with
   `expiresAt` = clamped `time_next_update_unix * 1000`, return it.

Keep the cache a module-level `const cache = new Map<string, CacheEntry>()` with
a short comment saying it is per-process and deliberate. `getRate` is the only
export the rest of the app touches.

### 7. `mappers/currency.mapper.ts`

```ts
export type CurrencyRateResponse = {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  lastUpdatedAt: string;
  nextUpdateAt: string;
};
```

Field by field, like `toAlertResponse` — never a spread of the upstream body,
which would leak `documentation` and `terms_of_use` into our API and make their
JSON shape our contract.

- `rate`: `new Prisma.Decimal(conversion_rate).toFixed()` (decision 3).
- `lastUpdatedAt` / `nextUpdateAt`: `new Date(unix * 1000).toISOString()` — ISO
  strings, matching every other response in this API. **`* 1000`**: the upstream
  sends seconds, `Date` takes milliseconds, and forgetting it dates the rate to 1970.

Currency codes come from **our** parsed param, not from `base_code` /
`target_code`, so the response always echoes what was asked for.

### 8. `controllers/currency.controller.ts` — thin

```ts
export const getPair: RequestHandler<CurrencyPairParam> = async (req, res) => {
  const { baseCurrency, quoteCurrency } = req.params;
  const rate = await exchangeRateService.getRate(baseCurrency, quoteCurrency);

  res.status(200).json(rate);
};
```

No `try/catch`: Express 5 forwards a rejected promise to `errorHandler`, which
the auth and alert controllers already prove in practice.

### 9. `routes/currency.routes.ts`

```ts
const router = Router();

router.use(requireAuth);
router.get('/:pair', validate({ params: currencyPairParamSchema }), currencyController.getPair);
```

`requireAuth` because every call spends quota that belongs to this account — an
open route is a free drain for anyone who finds the host. No extra rate limiter:
the cache is the quota's real defence, and a logged-in user hammering one pair
costs one upstream call a day.

### 10. Mount in [`app.ts`](../src/app.ts)

`app.use('/currency', currencyRoutes);` immediately after the `/alerts` line —
before the 404 forwarder and the error handler, which must stay last.

## Phase 3 — Verify

`yarn typecheck` is the gate. **Do not bother with `yarn lint`** — ESLint cannot
run under TypeScript 7 in this repo.

Then, with a token in `$TOKEN`:

| #   | request                                            | expect                                                          |
| --- | -------------------------------------------------- | --------------------------------------------------------------- |
| 1   | `GET /currency/usd-brl`                            | 200, `rate` a plain decimal string, both timestamps ISO         |
| 2   | `GET /currency/USD-BRL`                            | 200, identical body — normalization works                       |
| 3   | `GET /currency/  usd - brl  ` (url-encoded spaces) | 200 — `currencyCode` trims before it validates                  |
| 4   | repeat #1 immediately                              | 200, **same `lastUpdatedAt`**, and no upstream call in the log  |
| 5   | `GET /currency/usd-usd`                            | 422, `details.fieldErrors.pair`                                 |
| 6   | `GET /currency/usdbrl`                             | 422 — no `-`, rejected before the network                       |
| 7   | `GET /currency/usd-xyz`                            | **404**, not 502 — the finding this plan is built around        |
| 8   | `GET /currency/usd-brl` with no `Authorization`    | 401                                                             |
| 9   | temporarily break `EXCHANGE_RATE_API_KEY`, restart | **500**, body says nothing about the key; log has `invalid-key` |

For #4, a one-line `console.log` in the fetch path makes the cache hit visible;
delete it before committing. #9 is the one worth doing by hand — it is the
decision-5 behaviour that no amount of typechecking proves.

Finally: `grep -r "EXCHANGE_RATE_API_KEY\|v6.exchangerate-api.com" src/` should
match `config/env.ts` and `services/exchange-rate.service.ts`, and nothing else.

## Suggested commit boundaries

1. `chore: add EXCHANGE_RATE_API_KEY to env schema and example` — phase 0
2. `feat: add badGateway and serviceUnavailable http errors` — step 4
3. `feat: add ExchangeRateService with in-process rate cache` — steps 5–7
4. `feat: add GET /currency/:pair` — steps 8–10

## Open questions

**Concurrent misses hit the upstream twice.** Two requests for `usd-brl`
arriving before the first resolves both fetch. The fix is to cache the
_promise_ rather than the value, which coalesces them into one call. Left out
of v1 because it complicates the entry type for a race that costs one wasted
request; worth doing if the quota gets tight.

**The cache does not survive a restart or a second instance.** Redis is the
answer if this ever runs on more than one process. Not now.

**The evaluator will want `/latest/{base}` instead.** One call returns every
rate for a base currency, so checking 200 alerts against USD is one request
rather than 200. That is a second function on this same service
(`getRatesForBase`) sharing the same cache — deliberately not built here, since
jobs are out of scope, but it is why the service owns the cache rather than the
controller.

**Should `nextUpdateAt` be in the response at all?** It is in as a
`Cache-Control` hint the SPA can use to avoid polling. If the frontend ends up
ignoring it, drop it — an unused field is still a contract.
