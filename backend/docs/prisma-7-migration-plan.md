# Plan — Move from Prisma Next (8 RC) to Prisma ORM 7

Replace the contract-first Prisma Next setup with stable Prisma ORM 7
(`schema.prisma` + a generated client), keeping the existing database and its
data.

Everything below the "Decisions" line was verified on 2026-09-14 by installing
`prisma@7.10.0` in a scratch directory and running it against this project's
live dev database — `migrate diff`, a real `create`/`findUnique` round-trip, and
one failure case per constraint. Every claim that starts "verified" was observed,
not remembered. The probe wrote nothing: each case ran inside a transaction that
was rolled back.

**Why now.** `pg/timestamptz-temporal@1` cannot encode *or* decode a value
without a global `Temporal`, so on stock Node no row containing a `DateTime`
can be written or read. That blocks `issueSession` in
[auth-plan.md](auth-plan.md) Phase 4 before a line of it is written. The
alternatives are a V8 harmony flag in production, a polyfill, or re-authoring
the codecs. Prisma 7 hands back a plain JS `Date` and the question disappears —
**verified**: `expiresAt` written as `new Date(...)` round-tripped to the exact
same millisecond.

The second reason is timing: the only application code touching Prisma today is
[db.ts](../src/prisma/db.ts) (5 lines) and the constraint table in
[error-handler.ts](../src/middlewares/error-handler.ts). No service layer exists
yet. This migration is about as cheap as it will ever be.

**Scope**

- [x] `prisma@7.10.0` + `@prisma/client@7.10.0` + `@prisma/adapter-pg`
- [x] `prisma/schema.prisma` replacing `src/prisma/contract.prisma`
- [x] `prisma.config.ts` rewritten for v7
- [x] Baseline migration against the existing database (no data loss)
- [x] `src/prisma/db.ts` on the driver adapter
- [x] `error-handler.ts` on `PrismaClientKnownRequestError`
- [~] Prisma Next artefacts removed — files and migrations gone; `.claude/skills/`
      and the `prisma_contract` schema still pending (see "Applied" below)

---

## Applied 2026-09-14

Everything above held up, with two exceptions worth recording.

**Step 16 cannot use `migrate dev` here.** The `exchange_watch` role has
neither `CREATEDB` nor superuser, and `migrate dev` builds a shadow database
first — it fails with `P3014` before generating anything. The FK migration was
instead generated with `migrate diff --from-config-datasource --to-schema` and
applied with `migrate deploy`, which needs no shadow database. The resulting
migration is byte-for-byte the four statements step 16 predicted.

This is not specific to the baseline: **`yarn db:migrate` will fail the same
way on the next schema change.** The durable fix is one grant from a superuser:

```sql
ALTER ROLE exchange_watch CREATEDB;
```

Pointing `shadowDatabaseUrl` at an existing database is not an alternative —
Prisma resets whatever it is given.

**Step 20's import does not exist.** `PrismaClientKnownRequestError` is not a
top-level export of the generated `client.ts`; it lives on the `Prisma`
namespace. The working form is:

```ts
import { Prisma } from '../generated/prisma/client.ts';
// Prisma.PrismaClientKnownRequestError
```

Also confirmed while applying: all three tables were **empty**, so decision 3
and step 11's data-loss traps were theoretical on this database — the schema
still had to match, and did. Step 28's probe passed on every row, including
`P2003` carrying `constraint.index` structurally (the plan only promised it for
`P2002`). Step 27's diff showed the two foreign keys and nothing else.

Two cleanup steps are **still outstanding**, both blocked by the sandbox rather
than by anything technical: deleting the gitignored `backend/.claude/skills/`
(step 23's last bullet) and `DROP SCHEMA prisma_contract CASCADE` (step 24).

---

## What you give up

Stated once, so nobody rediscovers it mid-migration and thinks something broke:

- **The typed SQL builder** (`db.sql.<table>`). Prisma 7 has `$queryRaw` with
  tagged templates — typed by you, not by the schema.
- **`@@check` in the schema.** Verified: `Attribute not known: "@check"`. The
  three live check constraints move to a hand-written SQL migration (decision 7).
- **Namespaced accessors** (`db.orm.public.User`). Prisma 7 is `prisma.user`.
- **The contract/migration-graph model** — refs, snapshots, content hashes,
  `migration plan --from`. Prisma 7 migrations are timestamped SQL folders
  applied in order.

You also stop being on a release candidate that has moved four versions
(rc.9 → rc.15) since this project pinned it.

---

## Decisions (locked 2026-09-14)

**1. Pin `7.10.0` exactly, on both packages.** `prisma@latest` is now
`8.0.0-rc.15` — the stable 7 line sits under the `prev` dist-tag. `yarn add
prisma@latest` would silently put you back on the RC you are leaving. Pin
without a caret.

**2. Plain `Date` everywhere; no Temporal anything.** Verified end to end
against the live database. Delete the `--harmony-temporal` / `temporal-polyfill`
/ `pg/timestamptz-string@1` question from the auth plan — it does not survive
this migration.

**3. `@@map` on every model. Non-negotiable.** Prisma Next named the tables
`alert`, `user`, `refreshToken`; Prisma 7 derives table names from model names
and would look for `Alert`, `User`, `RefreshToken`. **Verified**: without
`@@map`, `migrate diff` against the live database emits `DROP TABLE "alert"`,
`DROP TABLE "user"`, `DROP TABLE "refreshToken"` and recreates all three. That
is total data loss, and it is the single mistake most likely to be made here.

**4. `@db.Timestamptz(6)` on every `DateTime`.** Prisma 7's default mapping is
`TIMESTAMP(3)` — no time zone, millisecond precision. The live columns are all
`timestamptz` at microsecond precision. Omitting this is a silent semantic
change to every timestamp you own, not a cosmetic one.

**5. `@db.Decimal` with no arguments** keeps `targetRate` as an unconstrained
`numeric`. Prisma 7's default is `DECIMAL(65,30)`.

**Consequence for the mapper:** Prisma 7 returns a `Decimal` *object*, not a
string, and **verified**: `.toString()` on `0.00000001` gives `"1e-8"`, while
`.toFixed()` gives `"0.00000001"`. Decision 3 of
[alerts-crud-plan.md](alerts-crud-plan.md) still holds — return a decimal string
— but the call is **`.toFixed()`**, never `.toString()`. An exchange rate
rendered as `1e-8` in JSON is a bug that will reach the frontend intact.

**6. `direction` stays a `String`, not a Prisma `enum`.** Prisma Next stored the
enum as `text` plus a CHECK constraint. Prisma 7's `enum` is a native Postgres
enum type, so adopting it means a `USING` cast migration on a live column for no
functional gain. Keep the column as it is; derive the TypeScript union from the
Zod schema instead:

```ts
export const directionSchema = z.enum(['ABOVE', 'BELOW']);
export type Direction = z.infer<typeof directionSchema>;
```

The CHECK constraint stays as the database-level backstop. Revisit only if you
want `direction` orderable in SQL.

**7. Check constraints live in the baseline SQL, not in `schema.prisma`.**
`@@check` does not exist in Prisma 7's PSL. The saving grace — **verified** —
is that `migrate diff` does **not** try to drop check constraints it cannot
express: a diff of the live database against the mapped schema left all three
(`alert_rate_positive_71f5f09d`, `alert_pair_distinct_e7f2bcc4`,
`alert_direction_check_134ec2b3`) untouched. So they survive indefinitely as
long as they are written into the baseline migration and never removed.

Re-verify this with `migrate diff` after any future schema change; it is a
property of the diff engine, not a guarantee in writing.

**8. Partial indexes are a preview feature in 7.** Both partial indexes on
`Alert` need `previewFeatures = ["partialIndexes"]` in the generator block, and
the syntax is `where: raw("...")` or `where: { isActive: true }` — a bare string
is rejected. Verified: without the preview flag, validation fails outright.

**9. The connection URL leaves the schema.** Verified: `url` in the `datasource`
block is an error in Prisma 7 (*"no longer supported in schema files"*). It goes
in `prisma.config.ts` for migrations, and `PrismaClient` takes a **driver
adapter** — `@prisma/adapter-pg` — for queries. This is why the adapter is a
required dependency, not an optimization.

**10. The generated client is TypeScript source inside `src/`, and the build
needs two new tsconfig flags.** `prisma generate` writes ~11 `.ts` files
(~280 KB) to the `output` path, and they import each other with explicit `.ts`
extensions. **Verified** against this project's exact tsconfig: `tsc` fails with
`TS5097` unless `allowImportingTsExtensions` is on, and then with `TS5096`
unless `rewriteRelativeImportExtensions` is *also* on. With both, `yarn build`
emits cleanly and rewrites the imports to `.js`.

**Locked:** generated client is **gitignored** and regenerated on install, the
same way `contract.json` was an emitted artefact. It is derived from
`schema.prisma`; committing 280 KB of generated TypeScript adds review noise and
merge conflicts for nothing.

**11. Baseline the existing database; never `migrate dev` into it first.** The
tables already exist and hold data. The correct move is to generate an initial
migration from the schema, then tell Prisma it is already applied
(`migrate resolve --applied`). Running `migrate dev` against a database Prisma 7
has no history for will offer to reset it — that prompt is the data-loss trap of
this phase, and the answer is always no.

---

## Phase 0 — Groundwork

1. Branch. This touches the data layer and is not a change you want half-applied
   on `main`.

2. **Back up the dev database first**, before anything in Phase 3 runs:
   ```bash
   pg_dump "$DATABASE_URL" > backup-pre-prisma7.sql
   ```
   Decisions 3 and 11 both describe ways to lose every row. The backup costs
   ten seconds.

3. Record where the database is now, so you can prove it did not move:
   ```bash
   psql "$DATABASE_URL" -c '\d+ "alert"' -c '\d+ "user"' -c '\d+ "refreshToken"' \
     > schema-before.txt
   psql "$DATABASE_URL" -Atc 'select count(*) from "user"' \
     -c 'select count(*) from "alert"' -c 'select count(*) from "refreshToken"'
   ```

## Phase 1 — Dependencies

4. Out with the RC, in with 7:
   ```bash
   yarn remove @prisma/orm-postgres @prisma/cli-engine prisma
   yarn add @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0
   yarn add -D prisma@7.10.0
   ```
   Exact versions, no caret (decision 1).

5. Drop the `postinstall` hook from `package.json`:
   ```json
   "postinstall": "prisma skills sync || exit 0"
   ```
   There is no `skills` command in Prisma 7 — the hook is a silent no-op kept
   alive only by its `|| exit 0`.

6. Replace the `contract:emit` script with the v7 equivalents:
   ```json
   "postinstall": "prisma generate",
   "db:generate": "prisma generate",
   "db:migrate": "prisma migrate dev",
   "db:studio": "prisma studio"
   ```
   `prisma generate` on install is what keeps the gitignored client (decision 10)
   present for a fresh clone.

## Phase 2 — Schema and config

7. **`prisma/schema.prisma`** — this exact file diffs clean against the live
   database (modulo step 12's foreign keys). The index `map:` names are the
   hash-suffixed names Postgres actually holds today; keeping them is what makes
   the diff empty instead of a drop-and-recreate.

   ```prisma
   generator client {
     provider        = "prisma-client"
     output          = "../src/generated/prisma"
     previewFeatures = ["partialIndexes"]
   }

   datasource db {
     provider = "postgresql"
   }

   model Alert {
     id            String    @id @default(uuid())
     baseCurrency  String
     quoteCurrency String
     targetRate    Decimal   @db.Decimal
     direction     String
     triggeredAt   DateTime? @db.Timestamptz(6)
     isActive      Boolean   @default(true)
     createdAt     DateTime  @default(now()) @db.Timestamptz(6)
     updatedAt     DateTime  @updatedAt @db.Timestamptz(6)

     userId String
     user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

     @@index([userId], map: "alert_userId_idx_a489d58a")
     @@index([baseCurrency, quoteCurrency], where: raw("(\"isActive\" = true)"), map: "alert_pair_active_331cc7d1")
     @@unique([userId, baseCurrency, quoteCurrency, direction, targetRate], where: raw("(\"isActive\" = true)"), map: "alert_user_alert_active_5b2336d6")
     @@map("alert")
   }

   model User {
     id           String   @id @default(uuid())
     email        String   @unique(map: "user_email_key")
     name         String
     passwordHash String
     phoneNumber  String?
     createdAt    DateTime @default(now()) @db.Timestamptz(6)

     alerts        Alert[]
     refreshTokens RefreshToken[]

     @@map("user")
   }

   model RefreshToken {
     id        String    @id @default(uuid())
     tokenHash String    @unique(map: "refreshToken_tokenHash_key")
     expiresAt DateTime  @db.Timestamptz(6)
     revokedAt DateTime? @db.Timestamptz(6)
     createdAt DateTime  @default(now()) @db.Timestamptz(6)

     userId String
     user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

     @@index([userId], map: "refreshToken_userId_idx_a489d58a")
     @@index([expiresAt], map: "refreshToken_expiresAt_idx_6b6b8c10")
     @@map("refreshToken")
   }
   ```

   Note `updatedAt` is `@updatedAt` — set by the client, like Prisma Next's
   `temporal.updatedAt()`. Verified: the live database has **no triggers**, so
   this is not a behaviour change. It does mean a raw `UPDATE` still won't touch
   the column, exactly as today.

   `User` gains `alerts` and `refreshTokens` back-relations. Prisma 7 requires
   both sides of a relation; Prisma Next did not.

8. **`prisma.config.ts`** — replace the Prisma Next config entirely:
   ```ts
   import 'dotenv/config';
   import { defineConfig } from 'prisma/config';

   export default defineConfig({
     schema: './prisma/schema.prisma',
     datasource: {
       url: process.env['DATABASE_URL']!,
     },
   });
   ```
   Keep the `dotenv/config` import: the CLI does not read `.env` for you.

9. Add the two flags to `tsconfig.json` (decision 10) — without both, `yarn
   build` fails:
   ```json
   "allowImportingTsExtensions": true,
   "rewriteRelativeImportExtensions": true
   ```

10. Gitignore the generated client:
    ```
    src/generated/
    ```

11. `yarn prisma validate && yarn prisma generate`. Validate before generate —
    a PSL error here is cheaper to read than a generator stack trace.

## Phase 3 — Baseline the existing database

This phase is where data gets lost if a step is skipped. Read step 13 before
running step 12.

12. **Confirm the schema matches reality before writing any migration:**
    ```bash
    yarn prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
    ```
    Expected output, verified: **only** a drop-and-re-add of the two foreign
    keys, because Prisma 7 writes `ON UPDATE CASCADE` where Prisma Next left the
    default `NO ACTION`.

    If you see `DROP TABLE` anywhere, stop — an `@@map` is missing (decision 3).
    Do not proceed on the theory that it will sort itself out.

13. **Write the baseline migration** describing the database as it already is:
    ```bash
    mkdir -p prisma/migrations/00000000000000_baseline
    yarn prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script \
      > prisma/migrations/00000000000000_baseline/migration.sql
    ```

14. **Hand-append the three check constraints** to that baseline file — Prisma
    cannot generate them (decision 7), and a future `migrate reset` would
    otherwise rebuild your local database without them:
    ```sql
    ALTER TABLE "alert" ADD CONSTRAINT "alert_rate_positive_71f5f09d"
      CHECK ("targetRate" > 0);
    ALTER TABLE "alert" ADD CONSTRAINT "alert_pair_distinct_e7f2bcc4"
      CHECK ("baseCurrency" <> "quoteCurrency");
    ALTER TABLE "alert" ADD CONSTRAINT "alert_direction_check_134ec2b3"
      CHECK ("direction" = ANY (ARRAY['ABOVE'::text, 'BELOW'::text]));
    ```
    The hash suffixes are kept deliberately: they are the names in the live
    database, and step 20's error handler no longer has anything to do with
    constraint names, so there is nothing to gain by renaming and one more
    chance to drift.

15. **Mark it applied** — this is the step that protects the data:
    ```bash
    yarn prisma migrate resolve --applied 00000000000000_baseline
    ```
    Prisma writes `_prisma_migrations` and records the baseline as done without
    executing a single statement of it.

16. **Then** close the foreign-key gap from step 12 as a normal migration:
    ```bash
    yarn prisma migrate dev --name align_foreign_key_on_update
    ```
    This is the first migration Prisma 7 actually runs. It should contain only
    the four FK statements. Read it before it applies.

17. `yarn prisma migrate status` — expect two migrations, both applied, no drift.

## Phase 4 — Runtime wiring

18. **`src/prisma/db.ts`** — the adapter replaces the `contractJson` façade:
    ```ts
    import { PrismaPg } from '@prisma/adapter-pg';
    import { PrismaClient } from '../generated/prisma/client.ts';
    import { env } from '../config/env.js';

    export const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
    });
    ```
    Two changes worth noticing: the import carries a `.ts` extension (decision
    10, rewritten to `.js` at build time), and it now goes through
    [config/env.ts](../src/config/env.ts) rather than reading `process.env`
    directly — `db.ts` was the last module bypassing the validated env.

    The export is renamed `db` → `prisma`. Nothing imports it yet except
    `db.ts` itself, so this costs one line now and gets more expensive after the
    alerts service exists.

19. Accessors change shape everywhere they eventually appear:
    `db.orm.public.User.first({ id })` becomes
    `prisma.user.findUnique({ where: { id } })`. Update the service tables in
    [auth-plan.md](auth-plan.md) step 14 and
    [alerts-crud-plan.md](alerts-crud-plan.md) when you next touch them.

## Phase 5 — Error handling

20. **Rewrite the constraint-translation half of
    [error-handler.ts](../src/middlewares/error-handler.ts).** The structural
    `kind === 'sql_query'` walk and the `CONSTRAINT_HASH_SUFFIX` regex both go
    away — they existed because Prisma Next's driver error was untyped. Prisma 7
    exports a real class:

    ```ts
    import { PrismaClientKnownRequestError } from '../generated/prisma/client.ts';
    ```

    Verified error shapes, one probe per case:

    | Case | `code` | Constraint name available at |
    | --- | --- | --- |
    | unique violation (incl. partial unique) | `P2002` | `meta.driverAdapterError.cause.constraint.index` |
    | foreign key violation | `P2003` | same |
    | **check constraint** | `P2039` | **message text only** |
    | record not found (`update`/`delete`) | `P2025` | n/a |

    So `P2002` keeps its specific messages —
    `alert_user_alert_active_5b2336d6` and `user_email_key` are both readable
    structurally, the latter being the 409 that
    [auth-plan.md](auth-plan.md) decision 6 wants for duplicate registration.

21. **`P2039` cannot name its constraint structurally** — verified: `constraint`
    is `undefined` and only `cause.originalMessage` carries
    `violates check constraint "alert_rate_positive_71f5f09d"`.

    **Locked:** do not regex the message. Map every `P2039` to one generic 422
    and make Zod produce the specific wording, which is where the existing
    comment in that file already says it belongs ("A check constraint reaching
    Postgres means a Zod schema failed to mirror it"). A check constraint firing
    is then a bug signal, not a user-facing message — log it and keep the
    warning that is already there.

22. **`cause.detail` still must never be forwarded.** Verified unchanged from
    Prisma Next: it contains the entire failing row. The existing rule and its
    comment survive the rewrite verbatim.

## Phase 6 — Remove Prisma Next

Do this in its own commit, after Phase 7 passes. A tree containing both data
layers is confusing but harmless; a tree missing the old one *and* broken is not.

23. Delete:
    - `src/prisma/contract.prisma`, `contract.json`, `contract.d.ts`
    - `migrations/` (the whole Prisma Next graph: `app/`, `snapshots/`, `refs/`)
    - `prisma-next.md`
    - `.claude/skills/` — gitignored and regenerated by the removed postinstall
      hook, but the `prisma-8` skill in it actively instructs agents in a data
      layer this project no longer uses. Delete the directory locally too.

24. Drop Prisma Next's bookkeeping schema, which its tables no longer back:
    ```sql
    DROP SCHEMA prisma_contract CASCADE;
    ```
    Verified present: `prisma_contract.marker`, `.ledger`, `.contract`. Do this
    only once Phase 7 is green — while it exists, `prisma db verify` from the old
    CLI is still a way to cross-check the old schema.

25. Update [auth-plan.md](auth-plan.md): decision on the Temporal workaround is
    void (decision 2), step 14's `db.orm.*` table becomes `prisma.*`, and step 5's
    migration commands are now `prisma migrate dev`.

    Also correct the docblock on `generateRefreshToken` in
    [tokens.ts](../src/shared/tokens.ts). Its second paragraph explains that
    `expiresAt` is a `Date` because the column's codec encodes only a
    `Temporal.Instant` — after this migration that codec does not exist and the
    reasoning is simply wrong. The signature does **not** change: `Date` was the
    right answer for a different reason and is now the native one. Delete the
    paragraph; keep the sha256 one above it.

    This is the only application comment the migration falsifies. Grep for
    `Temporal` before calling Phase 6 done.

## Phase 7 — Verify

26. `yarn typecheck && yarn build`. Both must pass — `build` is the one that
    proves decision 10's tsconfig flags are right, and `typecheck` alone will
    not catch `TS5096`.

    `yarn lint` is still broken repo-wide (typescript-eslint does not support
    TS 7.0) and is not a signal either way.

27. **Prove no data moved.** Same counts as step 3, and:
    ```bash
    psql "$DATABASE_URL" -c '\d+ "alert"' -c '\d+ "user"' -c '\d+ "refreshToken"' \
      > schema-after.txt
    diff schema-before.txt schema-after.txt
    ```
    Expected: only the two foreign-key lines from step 16.

28. Round-trip script, then delete it. These are the assertions the probe made,
    and they are the ones worth re-making in your own tree:

    | Check | Expected |
    | --- | --- |
    | `user.createdAt instanceof Date` | `true` — decision 2, the point of the migration |
    | write `expiresAt: new Date(...)`, read it back | same millisecond |
    | `revokedAt` on a fresh token | `null`, not a throw |
    | `alert.targetRate.toFixed()` for `0.00000001` | `"0.00000001"` (`.toString()` gives `"1e-8"`) |
    | duplicate email `create` | `P2002`, `constraint.index === 'user_email_key'` |
    | `targetRate: '-1'` | `P2039` — the check constraint survived Phase 3 |
    | `baseCurrency === quoteCurrency` | `P2039` |
    | same active alert twice | `P2002`, `constraint.index === 'alert_user_alert_active_5b2336d6'` — the partial unique index survived |
    | `refreshToken` with an unknown `userId` | `P2003` |

    Run it inside `prisma.$transaction` and throw at the end to roll back;
    otherwise you are seeding your dev database with probe rows. Note that one
    failed statement aborts the whole Postgres transaction (`25P02`), so give
    each failure case its own transaction.

29. `grep -rn 'db\.orm\|contract\.prisma\|@prisma/orm-postgres\|prisma-next' src/ docs/ *.ts`
    — zero hits outside git history.

---

## Suggested commit boundaries

| # | Commit |
| --- | --- |
| 1 | `chore: swap prisma next for prisma 7 and the pg driver adapter` |
| 2 | `feat: add prisma 7 schema mapped to the existing tables` |
| 3 | `feat: baseline prisma 7 migrations against the live database` |
| 4 | `refactor: wire PrismaClient through the pg adapter` |
| 5 | `refactor: translate prisma 7 error codes in the error handler` |
| 6 | `chore: remove prisma next contract, migrations and docs` |

---

## Open questions

1. **Does `alert_direction_check` earn its keep?** Once `direction` is validated
   by `directionSchema` at the edge (decision 6), the CHECK is a backstop against
   bugs in your own service layer. Cheap to keep, and the only thing stopping a
   raw `UPDATE` from writing `SIDEWAYS`. Recommend keeping it; worth a deliberate
   answer rather than drift.

2. **Is `partialIndexes` preview status acceptable?** Both `Alert` partial
   indexes depend on it (decision 8). Preview features can change shape between
   minors. The fallback is dropping them from the schema and keeping them as
   raw SQL in the baseline, the same treatment the check constraints get —
   slightly more honest, slightly less discoverable.

3. **Where does `expiresIn` cleanup run?** [auth-plan.md](auth-plan.md) step 22's
   `DELETE FROM "RefreshToken" WHERE "expiresAt" < now()` becomes
   `prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })`
   — which, with plain `Date`, is now expressible in the ORM rather than needing
   raw SQL. Worth noting when that step is written.

4. **Revisit Prisma 8 when it ships stable?** This plan is a move to stable, not
   a verdict on Prisma Next. The contract-first model and typed SQL builder are
   genuinely better; the RC's Temporal coupling is what makes it unusable here
   today. Re-evaluate when `8.x` leaves RC and `Temporal` is either standard in
   Node or optional in the codec.
