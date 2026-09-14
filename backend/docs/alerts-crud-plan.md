# Plan — Alerts CRUD

Implementation plan for the alert endpoints, using a
routes → controllers → services layering on top of the existing
Express 5 + Prisma 7 setup.

Rewritten 2026-09-14, after [prisma-7-migration-plan.md](prisma-7-migration-plan.md)
and [auth-plan.md](auth-plan.md) both landed. Two things that this plan used to
treat as open are now settled: the data layer is Prisma 7 with plain `Date`s and
`P2xxx` error codes, and **auth is done** — there is no `x-user-id` stopgap to
build, because `requireAuth` already exists and the stopgap has been deleted.

**Scope**

- [x] `Alert` model
- [x] Shared infrastructure (Phase 1 — landed with the auth work)
- [ ] `POST /alerts`
- [ ] `GET /alerts`
- [ ] `GET /alerts/:id`
- [ ] `PATCH /alerts/:id`
- [ ] `DELETE /alerts/:id`
- [ ] Zod schemas for the above

---

## Decisions

**1. `direction` is a `String` column, not a Prisma enum.** Prisma Next modelled
it as text plus a CHECK constraint, and the Prisma 7 migration kept that rather
than doing a `USING` cast to a native Postgres enum (decision 6 of the migration
plan). Consequence for this plan: **the Zod schema is the only place the union
exists**, so derive the TypeScript type from it rather than importing one from
the generated client:

```ts
export const directionSchema = z.enum(['ABOVE', 'BELOW']);
export type Direction = z.infer<typeof directionSchema>;
```

`alert_direction_check_134ec2b3` is the database-level backstop. If it ever
fires, Zod let something through.

**2. Ownership goes in the `where`, and a miss is a 404.** Verified against
Prisma 7: `update({ where: { id, userId } })` accepts the non-unique filter
alongside the unique `id`, **returns the updated row**, and throws `P2025` when
the id belongs to someone else. `delete` behaves the same way.

That is worth knowing because it collapses what would otherwise be three steps
(`updateMany` → check `count` → re-read to return the row) into one query, and
because the error handler already maps `P2025` to 404 — which is the answer this
plan wants anyway, since a 403 would confirm the id exists.

**Locked:** every query names `userId`, and no endpoint ever distinguishes
"someone else's alert" from "no such alert".

**3. `targetRate` is a Postgres `numeric`.** Prisma 7 reads it as a `Decimal`
_object_ and accepts a string on write. Accept number-or-string on input,
normalize to string, return string. Never round-trip through `parseFloat` —
exchange rates are exactly why the column is `Decimal`.

The mapper must call **`.toFixed()`**, never `.toString()`: verified, a
`targetRate` of `0.00000001` stringifies to `"1e-8"` via `.toString()` and
`"0.00000001"` via `.toFixed()`. An exchange rate rendered in exponential
notation is a bug that reaches the frontend intact.

**4. PATCH scope.** Allow `targetRate`, `direction`, `isActive` only. Changing
`baseCurrency`/`quoteCurrency` turns an alert into a different alert and
re-opens the partial-unique-index question — make that a POST + DELETE instead.

---

## Phase 0 — Groundwork

1. Nothing to install. `zod` is already a dependency, and so is everything else
   this plan needs.

2. Confirm nothing has drifted: `yarn prisma migrate status`.

3. Both read types this plan assumes are already settled — verified by probing
   during the Prisma 7 migration, so there is no smoke test left to run here:
   `targetRate` is a `Decimal` object the mapper renders with `.toFixed()`
   (decision 3), and `triggeredAt` / `createdAt` / `updatedAt` are plain `Date`s,
   so the mapper calls `.toISOString()`.

## Phase 1 — Shared infrastructure ✅ done

All of this landed with the auth work. Listed so you can see there is nothing to
build, not as a checklist:

| Step | File                                                                      | State                                                                                                 |
| ---- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 4    | [`src/shared/http-error.ts`](../src/shared/http-error.ts)                 | `HttpError` + `badRequest` / `unauthorized` / `notFound` / `conflict` / `unprocessable`               |
| 5    | [`src/middlewares/error-handler.ts`](../src/middlewares/error-handler.ts) | `HttpError`, `ZodError` → 422, Prisma `P2xxx` → mapped, else 500                                      |
| 6    | [`src/middlewares/validate.ts`](../src/middlewares/validate.ts)           | `validate({ body, params, query })`, with `validatedQuery(res)` for Express 5's read-only `req.query` |
| 7    | [`src/middlewares/require-auth.ts`](../src/middlewares/require-auth.ts)   | **replaces the planned `currentUser`.** Same `req.userId` contract, read through `requireUserId(req)` |
| 8    | [`src/app.ts`](../src/app.ts)                                             | cors → json → cookieParser → /health → /auth → _(alerts goes here)_ → 404 → error handler             |

Express 5 auto-forwards rejected promises from async handlers — confirmed in
practice by the auth controllers, which have no `try/catch` anywhere and still
never produced a 500 across the full verification run. No `asyncHandler` wrapper
is needed.

## Phase 2 — Alert module

Layout, matching the folders the auth work already created:

```
src/
  routes/alert.routes.ts
  controllers/alert.controller.ts
  services/alert.service.ts
  schemas/alert.schema.ts
  mappers/alert.mapper.ts
```

### 9. `schemas/alert.schema.ts` — all Zod, no Express imports

- `currencyCode` — `z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/)`.
  Not `length(3)`: `USDT` and `SHIB` are 4.

  Mind the ordering trap the auth schemas hit: a normalizing method chained
  _after_ a format check runs too late. Put `.trim()` / `.toUpperCase()` before
  the `.regex()`, or pipe into it — `z.email().trim()` silently rejects padded
  input, and the same shape of bug is available here.

- `directionSchema` — `z.enum(['ABOVE', 'BELOW'])` (decision 1).
- `decimalString` — accepts `number | string`, rejects `NaN`/`Infinity`,
  validates against a decimal regex, **outputs a string**, and enforces `> 0` to
  mirror the `alert_rate_positive_71f5f09d` DB check.
- `createAlertSchema` — `{ baseCurrency, quoteCurrency, targetRate, direction }`
  with a `.refine()` that `baseCurrency !== quoteCurrency`, mirroring
  `alert_pair_distinct_e7f2bcc4`. Client-side duplication of DB checks is
  deliberate: it turns a generic 422 into a specific one (see step 12).
- `updateAlertSchema` — `{ targetRate?, direction?, isActive? }` plus
  `.refine(o => Object.keys(o).length > 0, 'no fields to update')`.
- `alertIdParamSchema` — `{ id: z.uuid() }`, so a malformed id is a 422 and never
  reaches the DB.
- `listAlertsQuerySchema` — optional `isActive` (coerced boolean),
  `baseCurrency`, `quoteCurrency`, `direction`, `triggered`; plus `limit`
  (coerced int, default 20, max 100) and `cursor`.
- Export inferred types (`CreateAlertInput`, etc.) for the service signatures.

### 10. `services/alert.service.ts` — the only alert file importing `prisma`

Five functions, each taking `userId` as its first argument so scoping can't be
forgotten:

| Function                         | Query                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAlert(userId, input)`     | `prisma.alert.create({ data: { ...input, userId } })`                                                                                             |
| `listAlerts(userId, filters)`    | `prisma.alert.findMany({ where: { userId, ...filters }, orderBy: { createdAt: 'desc' }, take: limit + 1 })` — one extra row to detect a next page |
| `getAlertById(userId, id)`       | `prisma.alert.findFirst({ where: { id, userId } })`, throws `notFound()` on null                                                                  |
| `updateAlert(userId, id, input)` | `prisma.alert.update({ where: { id, userId }, data: input })` — returns the row; `P2025` becomes a 404 on its own                                 |
| `deleteAlert(userId, id)`        | `prisma.alert.delete({ where: { id, userId } })` — same                                                                                           |

**Always include `userId` in the predicate.** A bare `findUnique({ where: { id } })`
would let one user read another's alert, and it is the single most likely bug in
this module.

For cursor pagination, Prisma 7's idiom is
`{ cursor: { id: cursor }, skip: 1, take: limit + 1 }` — `skip: 1` because the
cursor row itself was already returned on the previous page.

Decide here whether DELETE is hard or soft (open question 1). Given `isActive`
already exists and `triggeredAt` is history you'll likely want, **soft delete via
`isActive: false` is the better default** — but then `DELETE /alerts/:id` and
`PATCH { isActive: false }` do the same thing, so pick one and document it.

Note that soft delete interacts with the partial unique index: it is scoped
`WHERE isActive = true`, so deactivating an alert deliberately frees the slot for
an identical new one. That is the behaviour you want, and it is an argument for
soft delete rather than against it.

### 11. `mappers/alert.mapper.ts`

`toAlertResponse(alert)` producing the public JSON shape: `id`, `baseCurrency`,
`quoteCurrency`, `targetRate` (string, via `.toFixed()`), `direction`,
`isActive`, `triggeredAt` (ISO or null), `createdAt`, `updatedAt`.

Never leak `userId` back to the client — it's implied by the token. Build the
object field by field rather than spreading the row, for the same reason
`toUserResponse` does: a spread leaks every column added later, by default.

### 12. DB-constraint → HTTP mapping ✅ mostly done

The error shapes were read, not guessed, during the Prisma 7 migration, and
[`error-handler.ts`](../src/middlewares/error-handler.ts) already carries them:

| Violation                                                                                        | Prisma code | Current handling                                       |
| ------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------ |
| duplicate active alert (`alert_user_alert_active_5b2336d6`)                                      | `P2002`     | **409**, with a message naming the pair/direction/rate |
| `alert_rate_positive_71f5f09d`, `alert_pair_distinct_e7f2bcc4`, `alert_direction_check_134ec2b3` | `P2039`     | **422**, deliberately generic                          |
| unknown `userId`                                                                                 | `P2003`     | 422                                                    |
| row not found / not yours                                                                        | `P2025`     | 404                                                    |

The one thing to know: **`P2039` does not expose which check constraint fired**
— verified, the name appears only in the driver's message text. So all three
check violations collapse into one generic 422, and the specific wording has to
come from Zod (step 9). A `P2039` in the logs is a bug signal: it means a schema
failed to mirror a constraint.

Nothing to add here unless you want a friendlier message for the 409.

### 13. `controllers/alert.controller.ts` — thin

Read `req.userId` via `requireUserId(req)` and validated input, call the service,
map, set status. No `try/catch` (the error handler owns that), no Zod, no
`prisma`.

| Endpoint             | Response                            |
| -------------------- | ----------------------------------- |
| `POST /alerts`       | `201` + `Location: /alerts/:id`     |
| `GET /alerts`        | `200` `{ data: [...], nextCursor }` |
| `GET /alerts/:id`    | `200`                               |
| `PATCH /alerts/:id`  | `200` with the updated alert        |
| `DELETE /alerts/:id` | `204`, empty body                   |

Query filters arrive through `validatedQuery(res)`, not `req.query` — Express 5
defines `req.query` as a getter with no setter, which is why `validate` writes
the parsed result to `res.locals` instead.

### 14. `routes/alert.routes.ts`

An `express.Router()` with `router.use(requireAuth)` at the top, then one line
per endpoint wiring `validate(...)` → controller. Reading this file should tell
you the whole API surface at a glance.

Then mount it in [`app.ts`](../src/app.ts), where the placeholder comment already
marks the spot — after `/auth`, before the 404.

## Phase 3 — Verify

15. `yarn typecheck`. **Not `yarn lint`** — it cannot run in this repo at all
    (typescript-eslint does not support TS 7.0), so it is not a signal either
    way.

16. Walk the full lifecycle by hand (`.http` file or curl). Unlike the old
    version of this plan, you no longer create a user row directly: register
    through `POST /auth/register`, keep the `accessToken`, and send it as
    `Authorization: Bearer <token>` on every alerts call.

    POST an alert → GET list → GET by id → PATCH → DELETE → GET by id expecting 404.

17. Exercise the failure paths explicitly, since they're where this kind of code
    usually leaks:

    | Case                             | Expected                                                     |
    | -------------------------------- | ------------------------------------------------------------ |
    | no `Authorization` header        | 401                                                          |
    | `Bearer garbage`                 | 401, not 500                                                 |
    | expired access token             | 401                                                          |
    | `baseCurrency === quoteCurrency` | 422                                                          |
    | `targetRate: -1`                 | 422                                                          |
    | `targetRate: "0.00000001"`       | survives the round-trip as an exact string, **not** `"1e-8"` |
    | `direction: "SIDEWAYS"`          | 422 from Zod (a `P2039` here means step 9 is wrong)          |
    | duplicate active alert           | 409                                                          |
    | another user's alert id          | 404 (**not** 403 — don't confirm the id exists)              |
    | malformed uuid                   | 422                                                          |
    | empty PATCH body                 | 422                                                          |

    Two users are needed for the ownership row: register a second account and
    try its token against the first one's alert id.

---

## Suggested commit boundaries

Phase 1's commits already landed with the auth work, so the list starts at the
schemas.

| #   | Commit                                        |
| --- | --------------------------------------------- |
| 1   | `feat: add alert zod schemas`                 |
| 2   | `feat: add alert service and response mapper` |
| 3   | `feat: add alert controller and routes`       |

Each should typecheck on its own — the auth work had to be rewritten once
because a commit imported a module that arrived in the next one.

---

## Open questions

1. **Soft vs hard delete** (step 10). Still genuinely open. The partial unique
   index argues for soft.

2. **Does `GET /alerts` need `triggered` as a filter at all?** It is in the
   query schema above, but nothing sets `triggeredAt` yet — no price-watching
   job exists. Consider shipping the filter only once something can populate the
   column, rather than a parameter that is always a no-op.
