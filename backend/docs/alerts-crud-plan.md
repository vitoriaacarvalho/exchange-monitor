# Plan — Alerts CRUD (Notification)

Implementation plan for the notification-handling endpoints, using a
routes → controllers → services layering on top of the existing
Express 5 + Prisma Next (Prisma 8 RC) setup.

**Scope**

- [x] `Notification` model
- [ ] `POST /alerts`
- [ ] `GET /alerts`
- [ ] `GET /alerts/:id`
- [ ] `PATCH /alerts/:id`
- [ ] `DELETE /alerts/:id`
- [ ] Zod validation

---

## Decisions to lock before coding

**1. `Notification` model ↔ `/alerts` route.** The model is `Notification`, the
resource is `alerts`. Keep the DB name as-is and treat "alert" as the API-layer
name. Everything from the controller outward says *alert*; only the service
touches `prisma.alert`. The mapper is the seam where the rename happens.

**2. `userId` is required and there is no auth yet.** `prisma/schema.prisma`
makes `userId` non-nullable, so every endpoint needs a user. Don't inline
`req.headers['x-user-id']` into controllers — build a tiny `currentUser`
middleware that sets `req.userId`, backed by a header for now. When JWT lands
you swap the middleware body and nothing else changes.

**3. `targetRate` is a Postgres `numeric`.** Prisma 7 reads it as a `Decimal`
*object*. Accept number-or-string on input, normalize to string, return string.
Never round-trip through `parseFloat` — exchange rates are exactly why the
column is `Decimal`.

The mapper must call **`.toFixed()`**, never `.toString()`: verified, a
`targetRate` of `0.00000001` stringifies to `"1e-8"` via `.toString()` and
`"0.00000001"` via `.toFixed()`. An exchange rate rendered in exponential
notation is a bug that reaches the frontend intact.

**4. PATCH scope.** Allow `targetRate`, `direction`, `isActive` only. Changing
`baseCurrency`/`quoteCurrency` turns an alert into a different alert and
re-opens the partial-unique-index question — make that a POST + DELETE instead.

---

## Phase 0 — Groundwork

1. `yarn add zod` (not currently a dependency).
2. Confirm tables exist and nothing has drifted: `yarn prisma migrate status`.
3. Both read types this plan assumes are already settled — verified by probing
   during the Prisma 7 migration, so there is no smoke test left to run here:
   `targetRate` is a `Decimal` object the mapper renders with `.toFixed()`
   (decision 3), and `createdAt`/`updatedAt` are plain `Date`s, so the mapper
   calls `.toISOString()`.

## Phase 1 — Shared infrastructure

These exist before any alert code, because all five endpoints lean on them.

4. **`src/shared/http-error.ts`** — an `HttpError` class (`statusCode`,
   `message`, optional `details`) plus named helpers (`notFound`, `conflict`,
   `badRequest`). Services throw these; they never touch `res`.

5. **`src/middlewares/error-handler.ts`** — the terminal 4-arg middleware:
   - `HttpError` → its own status + `{ error: { message, details } }`
   - `ZodError` → 422 with flattened field issues
   - Prisma constraint violations → mapped (see step 12)
   - anything else → 500, log the real error, return a generic body

   Express 5 auto-forwards rejected promises from async handlers, so no
   `asyncHandler` wrapper is needed — but verify this holds for your handler
   signatures during Phase 3.

6. **`src/middlewares/validate.ts`** — a factory
   `validate({ body?, params?, query? })` returning a middleware that parses each
   present schema and **writes the parsed result back** (`req.body = parsed`), so
   controllers receive coerced/trimmed data rather than raw strings. Note: in
   Express 5 `req.query` is a getter — assign parsed query to `res.locals.query`
   (or `req.validatedQuery`) instead of reassigning `req.query`.

7. **`src/middlewares/current-user.ts`** — reads `x-user-id`, 401s if absent,
   attaches `req.userId`. Add an `Express.Request` type augmentation in
   `src/types/express.d.ts` for `userId`.

8. **`src/app.ts`** — mount `express.json()`, then `/health`, then
   `app.use('/alerts', alertRoutes)`, then a catch-all 404, then the error
   handler **last**. Order matters.

## Phase 2 — Alert module

Recommended layout — layered folders, matching the routes/controllers/services
vocabulary:

```
src/
  routes/alert.routes.ts
  controllers/alert.controller.ts
  services/alert.service.ts
  schemas/alert.schema.ts
  mappers/alert.mapper.ts
```

(The alternative is a `src/modules/alerts/` folder holding all five files. Pick
that instead if you expect several more resources; for one entity plus a future
`users`, flat is fine.)

### 9. `schemas/alert.schema.ts` — all Zod, no Express imports

- `currencyCode` — `z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,10}$/)`.
  Not `length(3)`: `USDT` and `SHIB` are 4.
- `decimalString` — accepts `number | string`, rejects `NaN`/`Infinity`,
  validates against a decimal regex, **outputs a string**, and enforces `> 0` to
  mirror the `notification_rate_positive` DB check.
- `createAlertSchema` — `{ baseCurrency, quoteCurrency, targetRate, direction }`
  with a `.refine()` that `baseCurrency !== quoteCurrency`, mirroring
  `notification_pair_distinct`. Client-side duplication of DB checks is
  deliberate: it turns a 500-shaped DB error into a clean 422.
- `updateAlertSchema` — `{ targetRate?, direction?, isActive? }` plus
  `.refine(o => Object.keys(o).length > 0, 'no fields to update')`.
- `alertIdParamSchema` — `{ id: z.uuid() }`, so a malformed id is a 422 and never
  reaches the DB.
- `listAlertsQuerySchema` — optional `isActive` (coerced boolean),
  `baseCurrency`, `quoteCurrency`, `direction`, `triggered`; plus `limit`
  (coerced int, default 20, max 100) and `cursor`.
- Export inferred types (`CreateAlertInput`, etc.) for the service signatures.

### 10. `services/alert.service.ts` — the only file importing `prisma`

Five functions, each taking `userId` as its first argument so scoping can't be
forgotten:

| Function | Query |
| --- | --- |
| `createAlert(userId, input)` | `prisma.alert.create({ data: { ...input, userId } })` |
| `listAlerts(userId, filters)` | `prisma.alert.findMany({ where: { userId, ...filters }, orderBy: { createdAt: 'desc' }, take: limit + 1 })` — one extra row to detect a next page |
| `getAlertById(userId, id)` | `prisma.alert.findFirst({ where: { id, userId } })`, throws `notFound` on null |
| `updateAlert(userId, id, input)` | `prisma.alert.updateMany({ where: { id, userId }, data: input })`; `count === 0` means 404 |
| `deleteAlert(userId, id)` | `prisma.alert.deleteMany({ where: { id, userId } })`; `count === 0` means 404 |

**Always include `userId` in the predicate** — a bare `.first({ id })` would let
one user read another's alert.

Decide here whether DELETE is hard or soft. Given `isActive` already exists and
`triggeredAt` is history you'll likely want, **soft delete via `isActive: false`
is the better default** — but then `DELETE /alerts/:id` and
`PATCH { isActive: false }` do the same thing, so pick one and document it. If
you want true removal, `.delete()` is fine and the `onDelete: Cascade` on the
user relation stays consistent.

### 11. `mappers/alert.mapper.ts`

`toAlertResponse(notification)` producing the public JSON shape: `id`,
`baseCurrency`, `quoteCurrency`, `targetRate` (string), `direction`, `isActive`,
`triggeredAt` (ISO or null), `createdAt`, `updatedAt`. Never leak `userId` back
to the client — it's implied by the token. This is also where the Phase 0 step 3
finding about date types gets applied.

### 12. DB-constraint → HTTP mapping

The partial unique index `notification_user_alert_active` means creating a
duplicate *active* alert for the same `(user, pair, direction, rate)` throws.
Deliberately trigger it once, log the raw error, and record its shape (error code
/ constraint name). Then add a translator in the error handler: that constraint →
**409 Conflict** with a clear message; the two `@@check` constraints → 422 (they
should be unreachable if Zod does its job, so treat a hit as a bug signal).
Don't guess the error shape — read it.

### 13. `controllers/alert.controller.ts` — thin

Read `req.userId` and validated input, call the service, map, set status. No
`try/catch` (the error handler owns that), no Zod, no `db`.

| Endpoint | Response |
| --- | --- |
| `POST /alerts` | `201` + `Location: /alerts/:id` |
| `GET /alerts` | `200` `{ data: [...], nextCursor }` |
| `GET /alerts/:id` | `200` |
| `PATCH /alerts/:id` | `200` with the updated alert |
| `DELETE /alerts/:id` | `204`, empty body |

### 14. `routes/alert.routes.ts`

An `express.Router()`, `router.use(currentUser)` at the top, then one line per
endpoint wiring `validate(...)` → controller. Reading this file should tell you
the whole API surface at a glance.

## Phase 3 — Verify

15. `yarn typecheck` and `yarn lint`.

16. Walk the full lifecycle by hand (`.http` file or curl): create a user row
    directly, then POST an alert → GET list → GET by id → PATCH → DELETE → GET by
    id expecting 404.

17. Exercise the failure paths explicitly, since they're where this kind of code
    usually leaks:

    | Case | Expected |
    | --- | --- |
    | missing `x-user-id` | 401 |
    | `baseCurrency === quoteCurrency` | 422 |
    | `targetRate: -1` | 422 |
    | `targetRate: "0.00000001"` | survives the round-trip as an exact string |
    | duplicate active alert | 409 |
    | another user's alert id | 404 (**not** 403 — don't confirm the id exists) |
    | malformed uuid | 422 |
    | empty PATCH body | 422 |

---

## Suggested commit boundaries

| # | Commit |
| --- | --- |
| 1 | `chore: add zod` |
| 2 | `feat: add http error type and error handler middleware` |
| 3 | `feat: add zod validation middleware and current user middleware` |
| 4 | `feat: add alert zod schemas` |
| 5 | `feat: add alert service and response mapper` |
| 6 | `feat: add alert controller and routes` |
| 7 | `feat: map db constraint violations to http status codes` |

---

## Open questions

Two things that are genuinely open rather than mechanical:

1. **Soft vs hard delete** (step 10).
2. Whether `x-user-id` is acceptable as a stopgap, or auth should come first.
   Everything here works either way, but the second changes what Phase 1 step 7
   contains.
