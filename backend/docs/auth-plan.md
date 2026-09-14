# Plan — Registration & Login (Auth)

Implementation plan for the auth flow on top of the existing Express 5 +
Prisma Next (Prisma 8 RC) setup. The `User` model already exists
(`id`, `email @unique`, `name`, `passwordHash`, `phoneNumber?`, `createdAt`),
so this plan is about everything *around* it: hashing, tokens, sessions, and
the `requireAuth` middleware that the alerts endpoints will hang off.

Same layering as [alerts-crud-plan.md](alerts-crud-plan.md):
routes → controllers → services, with Zod at the edge.

**Scope**

- [x] `User` model
- [x] `RefreshToken` model + migration
- [x] `POST /auth/register`
- [x] `POST /auth/login`
- [x] `POST /auth/refresh`
- [x] `POST /auth/logout`
- [x] `GET /auth/me`
- [x] `requireAuth` middleware (replaces the `x-user-id` stopgap)

---

## Decisions (locked 2026-09-13)

**1. Access token + refresh token, not a single long-lived JWT.** A 7-day JWT
is simpler, but it cannot be revoked — logout becomes a lie, and so does
"delete my account". Use a **short-lived access JWT (15 min)** carrying
`sub = userId`, plus an **opaque refresh token** (32 random bytes) whose *hash*
is stored in `RefreshToken`. Logout deletes the row; the access token dies on
its own within 15 minutes.

**Locked:** short-lived access JWT + revocable refresh token. The
`RefreshToken` model and Phase 4 stay in scope; the 7-day-JWT shortcut is off
the table.

**2. `jose`, not `jsonwebtoken`.** The project is ESM (`"type": "module"`) on
TS 7 with `moduleResolution: bundler`. `jose` is native ESM with zero
dependencies and first-class types; `jsonwebtoken` is CJS, callback-shaped, and
needs `@types/jsonwebtoken`.

**Locked:** `jose`.

**3. `argon2id` for password hashing.** `bcrypt` silently truncates input at 72
bytes, which turns a long passphrase into a weaker one. `argon2` (the npm
package) defaults to argon2id with sane parameters. Zero-dependency fallback if
you want no native module: `node:crypto`'s `scrypt` — acceptable, but then you
own the salt/format/verify plumbing yourself.

**Locked:** `argon2`. The `scrypt` fallback is not being taken — if the native
build ever becomes a deployment problem, that is the escape hatch, and it only
touches `src/shared/password.ts`.

**4. The refresh token is stored hashed, the access token is not stored at
all.** A `RefreshToken` row holds `sha256(token)`, never the token. A leaked DB
dump then yields nothing usable. SHA-256 (not argon2) is correct here: the token
is already 256 bits of entropy, so there's nothing to brute-force, and refresh
happens often enough that argon2's cost would be felt.

**5. Email is normalized to lowercase at the Zod layer.** Postgres `@unique` is
case-sensitive, so without normalization `Ana@x.com` and `ana@x.com` are two
accounts. Normalize on **both** register and login — they must agree or login
breaks for anyone who typed a capital. (The alternative, a `citext` column or a
functional unique index, is more robust but is a schema change; lowercasing in
Zod is enough here as long as it is applied in exactly one shared schema.)

**Locked:** one shared `email` schema, reused by `registerSchema` *and*
`loginSchema` (step 12). Not two copies that can drift.

**6. Login never reveals whether an email exists.** Wrong password and unknown
email both return **401 `invalid credentials`**. Registration is the one place
that necessarily leaks existence (409 on duplicate) — accept that; the
alternative (always 201, send a "someone tried to register" email) needs a mail
pipeline you don't have.

**Locked:** 401 with an identical body on both login failures; 409 on duplicate
registration, existence leak accepted.

**7. The refresh token rides in an httpOnly cookie; the access token stays a
Bearer header.** (This was option B of the transport table; option A — refresh
token in the JSON body — is dropped.) The refresh token is never readable by
JavaScript, and the SPA keeps the access token **in memory only** — a module
variable or a React context, never `localStorage`. Writing the access token to
`localStorage` would hand back most of what the cookie just bought.

What this does and doesn't buy: an XSS payload can no longer *exfiltrate* a
30-day credential and replay it from the attacker's own machine. It can still
call `/auth/refresh` from the victim's page while that page is open and act as
the user. The cookie limits the blast radius; it isn't an XSS cure.

Cookie attributes — set in exactly one place (step 18):

```ts
{
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
}
```

- **`path: '/auth'`** so the cookie isn't attached to every `/alerts` request.
  It does still go to `/auth/login` and `/auth/me`, which ignore it — harmless,
  and the alternative (`/auth/refresh` only) breaks logout, which needs the same
  cookie.
- **`secure`** off on `http://localhost` in dev, on in production. Never ship
  `secure: false` to production; that's what the `NODE_ENV` check is for.
- **`sameSite: 'strict'` is the entire CSRF story, and the deployment is
  same-site, so it holds.** `app.example.com` ↔ `api.example.com` is same-site
  (same registrable domain), and so is `localhost:5173` ↔ `localhost:3333` in
  dev — port doesn't affect site. **No CSRF token anywhere in this plan**;
  that's the decision, not an omission.

  The one thing that would invalidate it: moving the frontend to a *different*
  registrable domain (a Vercel frontend against a Render API, say). Then the
  browser stops sending the cookie at all, the fix is `sameSite: 'none'` +
  `secure: true`, and Strict is no longer defending `/auth/refresh` — which is
  when `/auth/refresh` and `/auth/logout` would need a double-submit CSRF
  token. If that move is ever proposed, it is a security change, not a hosting
  change. Leave this paragraph here for whoever proposes it.
- Every other endpoint is Bearer-authenticated, so nothing else is
  CSRF-reachable: a cross-site form can't forge an `Authorization` header.

CORS: `cors({ origin: env.CORS_ORIGIN, credentials: true })` — an explicit
origin, because `*` is illegal alongside credentials. The frontend must send
`credentials: 'include'` on every `/auth/*` call, including login, or it will
get a token and silently drop the cookie.

Same-site does **not** mean same-origin, so CORS is still required:
`localhost:5173` → `localhost:3333` is one site but two origins. Don't drop the
`cors` dependency on the strength of decision 7's SameSite reasoning — they
answer different questions (SameSite: does the browser attach the cookie? CORS:
is the SPA allowed to read the response?).

The service layer stays transport-agnostic: it returns the refresh token as a
string, and only the controller knows it becomes a cookie (step 19).

---

## Phase 0 — Groundwork

1. Dependencies:
   ```bash
   yarn add argon2 jose zod cookie-parser cors
   yarn add -D @types/cookie-parser @types/cors
   ```
   (`zod` is also Phase 0 of the alerts plan — install it once. `cookie-parser`
   and `cors` are decision 7's cost; `express-rate-limit` arrives later, in
   step 21.)

2. Add to `.env.example` **and** `.env`:
   ```
   NODE_ENV=development
   JWT_SECRET=            # openssl rand -base64 48
   ACCESS_TOKEN_TTL=15m
   REFRESH_TOKEN_TTL_DAYS=30
   CORS_ORIGIN=http://localhost:5173
   ```
   `.env` is gitignored; `.env.example` carries the empty key so the next person
   knows it's required. `NODE_ENV` and `CORS_ORIGIN` are both decision 7's:
   the first decides the cookie's `secure` flag, the second is required because
   credentialed CORS forbids a wildcard origin.

3. **`src/config/env.ts`** — parse `process.env` through a Zod schema once, at
   import time, and export a typed `env` object. A missing `JWT_SECRET` should
   crash the process on boot with a clear message, not produce tokens signed
   with `undefined` at 3am. Require `JWT_SECRET` to be at least 32 chars;
   `NODE_ENV` as `z.enum(['development', 'test', 'production'])` defaulting to
   `development`; `CORS_ORIGIN` as a URL; `REFRESH_TOKEN_TTL_DAYS` coerced to a
   positive int (it's arithmetic, not a string).

## Phase 1 — Schema

4. Add to `prisma/schema.prisma`:

   ```prisma
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

   `onDelete: Cascade` matches `Alert` — deleting a user takes their sessions
   with them. The `expiresAt` index is for the cleanup sweep in step 22.
   `@@map`, the `map:` names and `@db.Timestamptz(6)` are all load-bearing; see
   decisions 3 and 4 of [prisma-7-migration-plan.md](prisma-7-migration-plan.md).
   `User` also needs the `refreshTokens` back-relation — Prisma 7 requires both
   sides.

5. Migrate:
   ```bash
   yarn prisma migrate dev --name add_refresh_tokens
   ```
   Read the generated `prisma/migrations/<ts>_add_refresh_tokens/migration.sql`
   before it applies — this one should be a pure additive create.

   Note: `migrate dev` builds a shadow database, and the `exchange_watch` role
   has no `CREATEDB`, so it fails with `P3014` until that is granted. Until
   then the equivalent is `migrate diff --from-config-datasource --to-schema`
   into a hand-made migration folder, applied with `migrate deploy`.

6. **Do not** add `passwordHash`-adjacent fields speculatively. But note for
   later: the moment you add OAuth or magic links, `passwordHash` has to become
   nullable. Leave it required now.

## Phase 2 — Shared infrastructure

Shared with the alerts plan. If you're building auth first, these land here; if
alerts landed first, they already exist and you skip to Phase 3.

7. **`src/shared/http-error.ts`** — `HttpError` (`statusCode`, `message`,
   optional `details`) plus `badRequest` / `unauthorized` / `conflict` /
   `notFound` helpers. Services throw these; they never touch `res`.

8. **`src/middlewares/error-handler.ts`** — terminal 4-arg middleware:
   `HttpError` → its status, `ZodError` → 422 with flattened issues, unique
   constraint violation → 409, anything else → 500 with the real error logged
   and a generic body returned. **Never** let an argon2 or jose error message
   reach the client.

9. **`src/middlewares/validate.ts`** — `validate({ body?, params?, query? })`,
   writing the parsed result back to `req.body` so controllers get normalized
   data (this is what actually applies the email lowercasing).

## Phase 3 — Password & token primitives

Two small, pure-ish modules with no Express and no `db` imports. They are the
pieces most worth unit-testing later.

10. **`src/shared/password.ts`**
    ```ts
    hashPassword(plain: string): Promise<string>
    verifyPassword(hash: string, plain: string): Promise<boolean>
    ```
    Thin wrappers over `argon2.hash` / `argon2.verify`. `verify` must return
    `false` on a malformed hash rather than throwing — a corrupted row should be
    a failed login, not a 500.

    Also export a module-level **dummy hash** (a real argon2 hash of any
    constant string, computed once at import). Step 15 explains why.

11. **`src/shared/tokens.ts`**
    - `signAccessToken(userId)` → `jose.SignJWT` with `sub`, `iat`, `exp` from
      `ACCESS_TOKEN_TTL`, HS256, signed with `JWT_SECRET`.
    - `verifyAccessToken(token)` → returns `{ userId }` or throws; `jose`'s
      `jwtVerify` already checks `exp` and signature.
    - `generateRefreshToken()` → `{ token, tokenHash, expiresAt }` using
      `crypto.randomBytes(32).toString('base64url')` and
      `crypto.createHash('sha256')`.
    - `hashRefreshToken(token)` → the same sha256, so lookup and creation can't
      drift apart.

    Encode the secret once (`new TextEncoder().encode(env.JWT_SECRET)`) at module
    scope, not per call.

## Phase 4 — Auth service

12. **`src/schemas/auth.schema.ts`**
    - `email` — `z.string().trim().toLowerCase().email()`. Defined **once** and
      reused by both register and login (decision 5).
    - `password` — `z.string().min(8).max(128)`. Cap the max: argon2 hashing
      cost scales with input, so an unbounded password field is a cheap DoS.
      Resist adding symbol/uppercase rules; length is what matters.
    - `registerSchema` — `{ name, email, password, phoneNumber? }`, name trimmed
      and `min(1)`, `phoneNumber` optional with a loose E.164-ish regex.
    - `loginSchema` — `{ email, password }`.
    - No `refreshSchema`. The refresh token arrives as a cookie, not a body
      field, and `/auth/refresh` takes no body at all — the controller reads
      `req.cookies.refreshToken` and 401s when it's absent. Don't add a Zod
      schema for symmetry's sake: there is nothing to validate beyond presence,
      and a Zod failure would produce a 422 where the honest answer is 401.

13. **`src/mappers/user.mapper.ts`** — `toUserResponse(user)` returning `id`,
    `name`, `email`, `phoneNumber`, `createdAt`. **`passwordHash` must never
    appear in a response.** Build the object field-by-field; never `...user` and
    then `delete`, because the next schema field you add gets leaked by default.

14. **`src/services/auth.service.ts`** — the only auth file importing `prisma`.

    | Function | Behaviour |
    | --- | --- |
    | `register(input)` | hash password → `prisma.user.create({ data: { ...input, passwordHash } })` → issue token pair |
    | `login(email, password)` | `prisma.user.findUnique({ where: { email } })` → verify → issue token pair |
    | `refresh(token)` | look up by `tokenHash`, validate, **rotate** (revoke old, create new), issue new pair |
    | `logout(token)` | set `revokedAt` on the matching row |
    | `getMe(userId)` | `prisma.user.findUnique({ where: { id: userId } })`, mapped |

    Factor the "issue token pair" tail into a private
    `issueSession(userId)` that signs the access token, generates the refresh
    token, inserts the `RefreshToken` row, and returns
    `{ accessToken, refreshToken, expiresIn }` — `register`, `login`, and
    `refresh` all end the same way and must not drift.

    The service returns the refresh token as a **plain string** and knows
    nothing about cookies — no `res`, no `Set-Cookie`, no `import 'express'`.
    Step 19 is where it becomes a cookie. That seam is what makes a future
    mobile client (which wants the token in the body) a controller change.

15. **`login` must be constant-ish time.** If the email doesn't exist, still run
    `verifyPassword(DUMMY_HASH, password)` before returning 401. Otherwise the
    unknown-email path returns in ~1ms and the wrong-password path in ~100ms,
    and decision 6 is defeated by a stopwatch.

16. **`refresh` — the rules that make rotation worth having:**
    - row missing → 401
    - `revokedAt != null` → 401. Optionally also revoke *every* token for that
      user: a revoked token being replayed means it leaked.
    - `expiresAt < now` → 401
    - otherwise: revoke this row and issue a fresh pair in a
      `db.transaction(...)`, so a failure can't leave the user with the old
      token revoked and no new one.

## Phase 5 — HTTP layer

17. **`src/middlewares/require-auth.ts`** — reads `Authorization: Bearer <t>`,
    401s if the header is absent or malformed, verifies via `verifyAccessToken`,
    sets `req.userId`. Keep the `Express.Request` augmentation in
    `src/types/express.d.ts`.

    **This is the drop-in replacement for `currentUser` in the alerts plan
    (Phase 1, step 7).** Same `req.userId` contract, so `alert.routes.ts` changes
    by exactly one import line. Delete the `x-user-id` middleware in the same
    commit — a header-trusting auth bypass left in the tree is the classic way
    this ends badly.

    Do **not** hit the DB here. The signed `sub` is enough; an extra `SELECT`
    per request buys you almost nothing when access tokens live 15 minutes.

18. **`src/shared/cookies.ts`** — `REFRESH_COOKIE = 'refreshToken'`, plus
    `setRefreshCookie(res, token)` and `clearRefreshCookie(res)` built on one
    shared options object (decision 7's block).

    This module exists for one reason: **`res.clearCookie` only clears a cookie
    when `path`, `sameSite` and `secure` match what was set.** Get them out of
    sync and logout returns 204 while the browser keeps a working refresh
    cookie — a logout that lies, which is the exact failure decision 1 was
    meant to rule out. One options object, two functions, no literals anywhere
    else.

19. **`src/controllers/auth.controller.ts`** — thin, no try/catch, no `db`.
    The only file that knows the refresh token is a cookie.

    | Endpoint | Auth | Refresh cookie | Response |
    | --- | --- | --- | --- |
    | `POST /auth/register` | — | set | `201` `{ user, accessToken, expiresIn }` |
    | `POST /auth/login` | — | set | `200` same shape |
    | `POST /auth/refresh` | the cookie *is* the credential | re-set (rotated) | `200` `{ accessToken, expiresIn }` |
    | `POST /auth/logout` | the cookie | cleared | `204` |
    | `GET /auth/me` | `requireAuth` | — | `200` `{ user }` |

    `refreshToken` never appears in a response body again — that's the whole
    point of decision 7. `expiresIn` stays, because the SPA needs to know when
    to refresh; it describes the *access* token.

    **`logout` is not behind `requireAuth`.** It authenticates with the refresh
    cookie instead: the common case for logging out is an access token that
    already expired while the tab sat open, and `requireAuth` would answer that
    with a 401 and leave the session alive server-side. Make it idempotent —
    revoke the row if the cookie matches one, clear the cookie either way,
    return 204 always. Never 404 a logout.

20. **`src/routes/auth.routes.ts`** + wire into `src/app.ts`:
    ```
    cors({ origin, credentials: true }) → express.json() → cookieParser()
      → /health → /auth → /alerts → 404 → error handler
    ```
    `cookieParser()` must be mounted before the `/auth` router or
    `req.cookies` is `undefined` — and `undefined.refreshToken` throws a 500
    where you wanted a 401. The error handler goes **last**, after the 404.

21. **Rate-limit `/auth/login` and `/auth/register`.** `express-rate-limit`,
    keyed by IP, something like 10 attempts per 15 min on login. Without it,
    decision 3's expensive hash is pointless — an attacker just tries passwords
    online. This is small enough to belong in this plan rather than a "later"
    list. Rate-limit `/auth/refresh` too, but loosely (say 60/15 min): it's a
    cheap sha256 lookup, and a tight limit would log out anyone with several
    tabs open.

22. **Expired-token cleanup.**
    `prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })`
    on a schedule — with plain `Date`s this is expressible in the ORM and needs
    no raw SQL. A `setInterval` in `server.ts` running daily is fine for now;
    note it as a cron candidate when deployment is real.

## Phase 6 — Verify

23. `yarn typecheck` && `yarn lint`.

24. Happy path by hand. Cookies mean curl needs a jar (`-c` writes it, `-b`
    reads it); the VS Code REST Client handles them for you in a `.http` file.

    ```bash
    curl -isc jar.txt -X POST localhost:3333/auth/register \
      -H 'content-type: application/json' \
      -d '{"name":"Ana","email":"ana@x.com","password":"correct horse battery"}'
    # then, with no body at all:
    curl -is -b jar.txt -c jar.txt -X POST localhost:3333/auth/refresh
    ```

    Confirm, in order: the register response has **no** `passwordHash` and **no**
    `refreshToken` → the `Set-Cookie` header carries `HttpOnly`, `SameSite=Strict`
    and `Path=/auth` → `/auth/me` works with the access token → refresh returns a
    new access token *and* a new cookie → the **old** cookie value is now
    rejected → logout returns 204 and a clearing `Set-Cookie` → the cookie is
    rejected afterwards.

25. Then the paths that actually matter:

    | Case | Expected |
    | --- | --- |
    | register with an existing email | 409 |
    | register with `ANA@x.com` then login as `ana@x.com` | 200 — the normalization works |
    | login, wrong password | 401 `invalid credentials` |
    | login, unknown email | 401, **same body and similar latency** as above |
    | password `"1234567"` | 422 |
    | `/auth/me` with no header | 401 |
    | `/auth/me` with `Bearer garbage` | 401, not 500 |
    | access token with a tampered payload | 401 |
    | expired access token (set TTL to `1s` and wait) | 401 |
    | reuse of a rotated refresh token | 401 |
    | refresh token after logout | 401 |
    | `/auth/refresh` with no cookie at all | 401, not 500 |
    | `/auth/refresh` with a garbage cookie value | 401 |
    | logout with no cookie | 204 — idempotent, not 401 |
    | browser: `document.cookie` after login | empty — it's `httpOnly` |
    | SPA fetch without `credentials: 'include'` | 401 on refresh, and that's the frontend's bug |
    | user A's access token on user B's alert | 404 (via the alerts rule) |

26. Grep the repo for `x-user-id` and confirm zero hits outside the git history.

---

## Suggested commit boundaries

| # | Commit |
| --- | --- |
| 1 | `chore: add argon2, jose, zod, cookie-parser and cors` |
| 2 | `feat: add typed env config` |
| 3 | `feat: add RefreshToken model` |
| 4 | `feat: add http error type and error handler middleware` *(skip if alerts landed first)* |
| 5 | `feat: add password hashing and jwt helpers` |
| 6 | `feat: add auth zod schemas and user mapper` |
| 7 | `feat: add auth service with refresh token rotation` |
| 8 | `feat: add auth routes and controller with httpOnly refresh cookie` |
| 9 | `feat: add requireAuth middleware and drop x-user-id stopgap` |
| 10 | `feat: rate limit auth endpoints` |

---

## Open questions

1. ~~**Refresh-token reuse policy (step 16)**~~ — **answered: revoke every
   session for that user.** A replayed token means the old value leaked, so the
   holder of the current one may not be the legitimate user. The cost is real:
   a replay logs the user out of every device with no visible cause. Flip it by
   deleting the `updateMany` in `refresh`'s `revokedAt` branch.
2. **Email verification.** Not in scope here, and it needs a mail provider. But
   it's worth deciding *now* whether `User` will eventually grow an
   `emailVerifiedAt` column, because adding it after you have real users means a
   backfill decision (verify everyone retroactively, or lock them all out).
3. **Password reset** — same dependency on mail, same `RefreshToken`-shaped
   pattern (single-use hashed token with an expiry). Deliberately deferred; the
   primitives in Phase 3 are the ones it will reuse.
