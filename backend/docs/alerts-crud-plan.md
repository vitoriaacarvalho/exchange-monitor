# Plan — Alerts CRUD

Implementation plan for the alert endpoints, using a
routes → controllers → services layering on top of the existing
Express 5 + Prisma 7 setup.

Rewritten 2026-09-14, after [prisma-7-migration-plan.md](prisma-7-migration-plan.md)
and [auth-plan.md](auth-plan.md) both landed. Two things that this plan used to
treat as open are now settled: the data layer is Prisma 7 with plain `Date`s and
`P2xxx` error codes, and **auth is done** — there is no `x-user-id` stopgap to
build, because `requireAuth` already exists and the stopgap has been deleted.

Decisions revisited the same day: `direction` became a native Postgres enum
(decision 1, which reverses decision 6 of the migration plan), and decisions 2–4
are locked as written. **Built and verified the same day — see
[Applied](#applied-2026-09-14).**

**Scope**

- [x] `Alert` model
- [x] Shared infrastructure (Phase 1 — landed with the auth work)
- [x] `POST /alerts`
- [x] `GET /alerts`
- [x] `GET /alerts/:id`
- [x] `PATCH /alerts/:id`
- [x] `DELETE /alerts/:id`
- [x] Zod schemas for the above

---

## Applied 2026-09-14

Five files, mounted at `/alerts` in [`app.ts`](../src/app.ts):
[`schemas/alert.schema.ts`](../src/schemas/alert.schema.ts),
[`services/alert.service.ts`](../src/services/alert.service.ts),
[`mappers/alert.mapper.ts`](../src/mappers/alert.mapper.ts),
[`controllers/alert.controller.ts`](../src/controllers/alert.controller.ts),
[`routes/alert.routes.ts`](../src/routes/alert.routes.ts). `yarn typecheck`
passes and 34 request-level checks pass with no 500 in the log. Four things the
plan did not predict:

**`req.params.id` is `string | string[]` in Express 5.** Reading it against the
default `RequestHandler` does not compile. The fix is to hand the handler the
schema's own inferred type — `RequestHandler<AlertIdParam, unknown,
UpdateAlertInput>` — which also removes the body casts, and is sound exactly
because the matching `validate(...)` runs on every route. Handlers with no route
params take `never`, since `unknown` is not assignable to Express's
`ParamsDictionary` and breaks `requireUserId(req)`.

**Step 9's "coerced boolean" would have been a bug.** `z.coerce.boolean()` is
`Boolean(value)`, so the string `"false"` — the only way a query string can
spell it — parses as `true`. `?isActive=false` would have returned active
alerts. `z.enum(['true', 'false']).transform(v => v === 'true')` is what the
schema uses.

**Cursor pagination needs a tiebreaker.** `orderBy: { createdAt: 'desc' }` alone
is not a total order; two alerts created in the same millisecond can swap places
between requests, and a cursor into an unstable order skips or repeats rows. The
service orders by `[{ createdAt: 'desc' }, { id: 'desc' }]`.

**A JSON number cannot always carry the rate.** `decimalString` accepts
`number | string`, but a number small enough to need exponent notation
(`1e-8`) stringifies as `"1e-8"` and is rejected with a message telling the
client to send a string — the alternative was storing an exchange rate in
exponential form, which is the bug decision 3 exists to prevent. Sent as
`"0.00000001"`, it round-trips exactly.

Two smaller notes. The mapper runs in the controller, as step 13 says, so the
service returns rows — that differs from `auth.service.ts`, which maps inside
the service because it composes tokens into the same result. And `migrate dev`
refuses to run non-interactively, so the rename migration was written by hand
and applied with `migrate deploy`; `--create-only` is no escape hatch, it needs
a TTY too.

---

## Decisions

**1. `direction` is a native Postgres enum.** Changed 2026-09-14, reversing
decision 6 of the migration plan, which had kept the text column. The schema now
declares

```prisma
enum Direction {
  ABOVE
  BELOW
  EQUAL
}
```

created by [`20260914174147_create_direction_enum`](../prisma/migrations/20260914174147_create_direction_enum/migration.sql)
and widened with `EQUAL` by [`20260914174328_update_direction_enum`](../prisma/migrations/20260914174328_update_direction_enum/migration.sql).
The label first shipped as `BELLOW` and was corrected in place by
[`20260914184013_rename_direction_bellow_to_below`](../prisma/migrations/20260914184013_rename_direction_bellow_to_below/migration.sql).
Three consequences, all verified against the dev database:

- **`alert_direction_check_134ec2b3` is gone.** No cast exists from `text` to a
  new enum type, so the migration dropped and recreated the column — and the
  CHECK constraint went with it (as did `alert_user_alert_active_5b2336d6`,
  which the same migration recreates). `\d alert` now lists two check
  constraints, not three. The enum type itself is the database-level backstop.

- **The union has one source of truth, and it is the generated client.** Feed it
  to Zod instead of retyping the values:

  ```ts
  import { Direction } from '../generated/prisma/enums.ts';

  export const directionSchema = z.enum(Direction);
  export type Direction = z.infer<typeof directionSchema>;
  ```

  Zod 4's `z.enum()` takes the generated const object directly — `z.nativeEnum`
  is its deprecated predecessor, don't reach for it. Verified: `.options` comes
  back as `['ABOVE', 'BELOW', 'EQUAL']`, so a fourth value costs a migration
  and a `prisma generate`, and nothing in `src/` changes.

- **An unknown value is now a 500, not a 422, unless Zod stops it first.** With
  the old text column a bad direction reached Postgres and came back as `P2039`
  → 422. Now the client rejects it before any SQL runs, and it throws
  `PrismaClientValidationError` — which carries no `code` and is _not_ a
  `PrismaClientKnownRequestError`, so `translatePrismaError` never sees it and
  the error handler's final branch logs it as a 500. That is the right outcome:
  since `directionSchema` is derived from the same generated enum, the two
  cannot drift, and a 500 here means step 9 is wired wrong — a louder signal
  than a 422. **Zod is load-bearing now, not a nicety.**

**2. Ownership goes in the `where`, and a miss is a 404.** Two claims, both
re-verified on 2026-09-14 by writing two users and one alert to the dev database
and trying each other's ids.

_The mechanism._ `update` and `delete` used to accept only unique fields in
`where`. They now accept extra non-unique filters alongside the unique one, so
`where: { id, userId }` is legal, **returns the updated row**, and throws `P2025`
when that pair matches nothing. Without it, enforcing ownership takes three
statements:

```ts
// what you'd otherwise write
const { count } = await prisma.alert.updateMany({ where: { id, userId }, data });
if (count === 0) throw notFound();
return prisma.alert.findFirst({ where: { id, userId } }); // updateMany returns no rows
```

```ts
// what the scoped where buys you
return prisma.alert.update({ where: { id, userId }, data });
```

The saving is not brevity, it is atomicity: the three-statement version has a gap
between the check and the re-read in which the row can be deleted, and then it
either 404s something it just updated or returns a row that no longer exists.
`findUnique` accepts the same extra filter and returns `null` rather than
throwing — but `findFirst` is what step 10 uses, because a non-unique predicate
is what it is actually expressing.

_Why 404 and not 403._ Prisma cannot tell "no such id" from "not yours" — both
are `P2025` — and that ambiguity is the behaviour this plan wants. A 403 would
answer a question the caller has no right to ask: it confirms the uuid names a
real alert, which turns `GET /alerts/:id` into an oracle for enumerating other
people's rows. A 404 leaks nothing. The cost is that a user who genuinely owns
the alert but sends a stale id sees "not found" rather than something more
precise; that is the right trade.

The error handler already maps `P2025` → 404, so none of this needs code in the
alert module — only the discipline of never omitting `userId`.

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

**Locked** (re-confirmed 2026-09-14 on the enum-migrated schema: a stored
`0.00000001` still comes back as `Decimal`, `.toString()` still yields `"1e-8"`).

**4. PATCH scope.** Allow `targetRate`, `direction`, `isActive` only. Changing
`baseCurrency`/`quoteCurrency` turns an alert into a different alert and
re-opens the partial-unique-index question — make that a POST + DELETE instead.

**Locked.**

---

## Phase 0 — Groundwork

1. Nothing to install. `zod` is already a dependency, and so is everything else
   this plan needs.

2. Confirm nothing has drifted: `yarn prisma migrate status`.

   Then **`yarn prisma generate`**. `src/generated/` is gitignored and only
   rebuilt on `postinstall`, so after the `Direction` migrations it can still be
   carrying `direction: string | null` and no `Direction` export — in which case
   every type decision 1 relies on silently isn't there yet.

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

- `directionSchema` — `z.enum(Direction)` over the generated enum, **not** a
  hand-written list of strings (decision 1). This is the only guard between a bad
  `direction` and a 500.
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
this module. Note the asymmetry decision 2 describes: `update` and `delete`
_throw_ `P2025` on a miss and so become a 404 with no code of yours, while
`findFirst` _returns `null`_ — `getAlertById` is the one place that has to throw
`notFound()` itself.

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

| Violation                                                      | Prisma code                          | Current handling                                       |
| -------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| duplicate active alert (`alert_user_alert_active_5b2336d6`)    | `P2002`                              | **409**, with a message naming the pair/direction/rate |
| `alert_rate_positive_71f5f09d`, `alert_pair_distinct_e7f2bcc4` | `P2039`                              | **422**, deliberately generic                          |
| unknown `userId`                                               | `P2003`                              | 422                                                    |
| row not found / not yours                                      | `P2025`                              | 404                                                    |
| `direction` outside the enum                                   | none — `PrismaClientValidationError` | **500** (see decision 1)                               |

Two things to know:

**`P2039` does not expose which check constraint fired** — verified, the name is
in the driver's message text only. Both remaining check violations collapse into
one generic 422, and the specific wording has to come from Zod (step 9). A
`P2039` in the logs is a bug signal: a schema failed to mirror a constraint.

**The last row is new, and it is the enum's doing.** `direction` is no longer a
text column with a CHECK, so a bad value never reaches Postgres and never gets a
`P2xxx` code; it is a `PrismaClientValidationError`, which `translatePrismaError`
does not handle and the final branch logs as a 500. Leave it that way — it is
unreachable while step 9 holds, and a 500 is the signal you want if it ever
isn't.

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
    | `direction: "SIDEWAYS"`          | 422 from Zod (a **500** here means step 9 is wrong)          |
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

All three are closed.

1. **Soft vs hard delete** — **hard**. `DELETE /alerts/:id` removes the row and
   answers 204. The argument for soft delete was that the partial unique index
   is scoped `WHERE isActive = true`, so deactivating frees the slot — but
   `PATCH { isActive: false }` already does exactly that, and having DELETE mean
   the same thing leaves the API with two spellings of one operation and no way
   to say "remove this". Verified both halves: deactivating frees the slot for an
   identical new alert, and DELETE is followed by a 404.

2. **`BELLOW` typo** — **fixed** 2026-09-14, before any client saw it. One
   migration, `ALTER TYPE "Direction" RENAME VALUE 'BELLOW' TO 'BELOW'`, which
   rewrites the label without touching rows. `POST` with `"BELLOW"` is now a 422.

3. **`triggered` filter** — **shipped**. It maps to `triggeredAt: { not: null }`
   / `null` and costs three lines, so the API keeps its shape when a
   price-watching job eventually populates the column. Until then
   `?triggered=true` correctly returns nothing.
