# Plan — OpenAPI / Swagger UI

Implementation plan for browsable API documentation at `/docs`, generated from
the Zod schemas that already validate every request rather than from a second
description of them.

Written 2026-09-16, with
[exchange-rate-api-plan.md](exchange-rate-api-plan.md) landed (the `/currency`
files exist and are mounted). Twelve operations across nine paths, listed in
[Inventory](#inventory).

**Scope**

- [ ] `swagger-ui-express` mounted at `/docs`, served by the API itself
- [ ] `GET /openapi.json` — the document, for SPA codegen and for `curl`
- [ ] OpenAPI **3.1**, built at runtime from the existing Zod schemas
- [ ] Zod mirrors of the three mapper response types, drift-guarded by `satisfies`
- [ ] The shared `{ error: { message, details? } }` envelope, documented once
- [ ] `bearerAuth` + the refresh cookie as security schemes
- [ ] `DOCS_ENABLED` so production can turn it off

---

## Verified on this codebase, 2026-09-16

Zod 4.6.4, Express 5.2.1, Node 24.14.1. Everything below was probed against the
real schemas before any of this was written, because the whole plan rests on
`z.toJSONSchema` — Zod 4's built-in converter — behaving well enough to make a
schema library unnecessary. Seven findings.

**`io: 'output'` throws on four of the seven request schemas.**
`Transforms cannot be represented in JSON Schema` — from `createAlertSchema`,
`updateAlertSchema`, `listAlertsQuerySchema` and `currencyPairParamSchema`. All
four earn it honestly: `decimalString`, `booleanParam` and the `pair` split are
transforms. `io: 'input'` converts **all seven** without complaint.

This is not a workaround to apologise for. `io: 'input'` is the *correct*
direction: OpenAPI documents what the caller sends, and the caller sends
`{ "isActive": "true" }`, not the post-transform boolean. Decision 2.

**`io: 'input'` silently drops `format: 'email'`.** The same probe, both
directions, on `registerSchema`:

| direction        | `email` renders as                                |
| ---------------- | ------------------------------------------------- |
| `io: 'output'`   | `{ type: 'string', format: 'email', pattern: … }`  |
| `io: 'input'`    | `{ type: 'string' }`                               |

`emailSchema` is `z.string().trim().toLowerCase().pipe(z.email())`, so its
*input* really is any string — the converter is right and the documentation is
useless. Same story one step worse for `currencyPairParamSchema`, whose input
renders as `{ pair: { type: 'string' } }`: the `usd-brl` shape, the entire point
of that route, vanishes. **This is the one thing that must not be forgotten**,
and decision 3 is how it comes back.

**`.meta()` survives pipes and transforms in input mode, and passes arbitrary
JSON Schema keys through verbatim.** Probed: `format`, `pattern`, `description`
and `examples` all landed in the output for a schema whose input side is a bare
`z.string()`. So the lost information is restorable at the source, on the schema
itself, with no post-processing pass.

**A `z.registry()` emits exactly the `components.schemas` shape** —
`{ schemas: { AlertResponse: {…}, AlertPage: {…} } }`, with real
`$ref: '#/components/schemas/AlertResponse'` cross-references when one registered
schema nests another. Two keys have to be stripped from each entry: `$schema`
and `$id`, which are legal JSON Schema but not legal in an OpenAPI schema object.

**Two Zod outputs are legal in OpenAPI 3.1 and illegal in 3.0.** `targetRate`
converts to `type: ['string', 'number']`, and every `.nullable()` converts to
`anyOf: [X, { type: 'null' }]`. Neither exists in 3.0, whose `nullable: true`
was replaced. Targeting 3.0 would mean a rewriting pass over every schema;
targeting 3.1, whose schema object *is* JSON Schema 2020-12, means the converter
output drops in unmodified. Decision 1.

**`swagger-ui-express@5.0.1` mounts cleanly on Express 5.2.1.** Probed on a
throwaway app with this repo's middleware order, including the catch-all 404
forwarder:

| request                      | result                                    |
| ---------------------------- | ----------------------------------------- |
| `GET /docs/`                 | 200, `<title>Swagger UI</title>`          |
| `GET /docs`                  | 301 → `/docs/`                            |
| `GET /docs/swagger-ui-bundle.js` | 200, `text/javascript`                |
| `GET /nope`                  | still the 404 envelope — forwarder intact |

It bundles `swagger-ui-dist` 5.33.0, which renders 3.1. Worth knowing: its
dependency range is the floating `swagger-ui-dist: '>=5.0.0'`, so the lockfile
is what pins the UI.

**Express 5 will not hand over a mounted router's prefix.** `app.router` is
public now (no more `app._router`), and `app.router.stack` does enumerate every
route — but for a mounted router `layer.path` is `undefined`, and the routes
come back as `GET /:pair`, not `GET /currency/:pair`. The prefix is recoverable
only by *running* `layer.matchers[0]('/currency/usd-brl')`, which returns
`{ path: '/currency' }`. Introspection is data-driven enough to be tempting and
not data-driven enough to be worth it — see [Open questions](#open-questions).

---

## Decisions

**1. OpenAPI 3.1, assembled at runtime, in TypeScript.** Not a hand-written
`openapi.yaml`, and not JSDoc comments scanned out of the route files
(`swagger-jsdoc`): both are a second copy of the request rules that drifts from
the Zod schemas the moment someone edits one and not the other. The schemas are
the source of truth because they are the thing that actually runs.

3.1 rather than 3.0 for the reason in the probe — 3.1's schema object is JSON
Schema 2020-12, so `z.toJSONSchema(…, { target: 'draft-2020-12' })` output is
pasteable as-is. 3.0 would need a rewriting pass whose only purpose is to
satisfy a spec version we have no reason to target.

No new schema library. `zod-openapi@6` and `@asteasolutions/zod-to-openapi`
both do this well, but Zod 4 absorbed the conversion into core and the probe
shows it covers all seven schemas. The same reasoning as *"No `axios`, no
`node-fetch`"* in the currency plan.

**Locked.**

**2. `io: 'input'` everywhere, with no exceptions and a comment saying why.**
The converter wrapper takes no direction argument, so nobody has to choose per
call site and nobody discovers the transform error at runtime on a Tuesday.
Response schemas (decision 4) are written as plain Zod objects with no
transforms, where input and output are the same thing anyway.

**Locked.**

**3. What `io: 'input'` loses comes back through `.meta()`, on the schema
itself.** Not as a patch table in the OpenAPI module — that would be exactly the
second source of truth this plan exists to avoid. Three schemas need it:

```ts
// auth.schema.ts
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  .meta({ format: 'email', examples: ['ana@example.com'] });
```

```ts
// currency.schema.ts — the pair segment
z.string().meta({
  description: "Two currency codes joined by '-'. Case-insensitive.",
  pattern: '^[A-Za-z0-9]{2,10}-[A-Za-z0-9]{2,10}$',
  examples: ['usd-brl'],
});
```

```ts
// alert.schema.ts — decimalString
.meta({
  description: 'A decimal written in full. Send a string; a JSON number is accepted but lossy.',
  examples: ['5.1204', '0.00000001'],
})
```

The `pattern` on the pair is documentation, not enforcement — the real check is
`currencyCode` running on each half after the split, and it stays there.

**Two `.refine()` rules are invisible to JSON Schema** and have to be written
into the operation's `description` by hand, because no converter can express
them: `baseCurrency !== quoteCurrency` on `createAlertSchema` and on
`currencyPairParamSchema`, and `updateAlertSchema`'s "at least one field". Each
is a 422 that the reader would otherwise meet for the first time in production.

**Locked.**

**4. Responses get Zod mirrors, guarded by `satisfies`.** The three mapper types
(`UserResponse`, `AlertResponse`, `CurrencyRateResponse`) are hand-written
TypeScript, so there is nothing to convert. Writing them a second time as Zod is
duplication — the question is only whether the duplicate can lie.

Probed, and mostly it cannot:

```ts
const alertResponseSchema = z.object({ … }) satisfies z.ZodType<AlertResponse>;
```

| the mirror…                          | `yarn typecheck`         |
| ------------------------------------ | ------------------------ |
| omits `updatedAt`                    | **TS1360** — caught      |
| types `targetRate` as `z.number()`   | **TS1360** — caught      |
| adds a field the mapper never sends  | passes — **not caught**  |

The extra-field gap is structural assignability and does not close with
`z.ZodType<AlertResponse, AlertResponse>` either (probed). Accept it: the mapper
is what actually builds the body, field by field, so an extra field in the
mirror is a wrong *document*, not a leaked value. Missing and mistyped fields —
the two that make the docs actively misleading — are caught by the gate this
repo already runs.

`AlertPage` is `{ data: AlertResponse[], nextCursor: string | null }`, and the
registry gives it a real `$ref` to `AlertResponse` rather than an inlined copy.

**Locked.**

**5. The error envelope is one component, referenced by every failure
response.** `errorHandler` writes `{ error: { message, details? } }` for
everything it renders, so documenting it per-operation would be nine copies of
one shape. One `ErrorResponse` component, plus a small
`errorResponse(description)` helper so an operation's failure list reads as a
table rather than as nested boilerplate.

Worth documenting honestly rather than optimistically: `details` is present on a
422 (Zod's `formErrors` / `fieldErrors`) and absent on almost everything else.
It is `details?`, and the SPA must not depend on it.

**Locked.**

**6. `servers: [{ url: '/' }]` — relative, so "Try it out" calls the origin the
docs were served from.** This is what makes the cookie flows testable. The
refresh cookie is `httpOnly`, `sameSite: 'strict'`, `path: '/auth'`; a Swagger
UI served from the API's own origin at `/docs` is same-site with it and the
cookie rides along on `POST /auth/refresh`. A Swagger UI hosted next to the SPA
on `CORS_ORIGIN` would not be, and `/auth/refresh` would answer 401 in the
browser while working perfectly in `curl` — the kind of discrepancy that costs
an afternoon.

Two security schemes, because the API really does have two credentials:

```ts
bearerAuth:    { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
refreshCookie: { type: 'apiKey', in: 'cookie', name: 'refreshToken' }
```

Swagger UI will not let the Authorize dialog set an `httpOnly` cookie — nothing
can, that is the point of the flag — so `refreshCookie` is documentation of how
the endpoint is reached, and the browser supplies the value after a real login
in the same tab. Say so in the `POST /auth/refresh` description.

**Locked.**

**7. `DOCS_ENABLED`, defaulting to on.** An unauthenticated map of every
endpoint and every validation rule is a gift to anyone scanning the host, and
the decision of whether to give it belongs in the environment, not in the code.
Default on, because the cost of forgetting to enable it in development is a
confused developer and the cost of forgetting to disable it in production is a
deliberate choice someone made.

When off, the router is never mounted, so `/docs` falls through to the existing
404 forwarder and answers in the normal envelope — not a 403, which would
confirm the docs exist.

**Locked.**

---

## Inventory

Nine path items, twelve operations. The table is the acceptance criteria for
Phase 3; a `paths` object missing a row is an incomplete plan.

| path                   | method   | auth      | request schema             | success            |
| ---------------------- | -------- | --------- | -------------------------- | ------------------ |
| `/health`              | `GET`    | —         | —                          | 200 `{ status }`   |
| `/auth/register`       | `POST`   | —         | `registerSchema`           | 201 `AuthResponse` |
| `/auth/login`          | `POST`   | —         | `loginSchema`              | 200 `AuthResponse` |
| `/auth/refresh`        | `POST`   | cookie    | — (cookie only)            | 200 `SessionResponse` |
| `/auth/logout`         | `POST`   | cookie    | — (cookie only)            | 204                |
| `/auth/me`             | `GET`    | bearer    | —                          | 200 `{ user }`     |
| `/alerts`              | `POST`   | bearer    | `createAlertSchema`        | 201 `AlertResponse` |
| `/alerts`              | `GET`    | bearer    | `listAlertsQuerySchema`    | 200 `AlertPage`    |
| `/alerts/{id}`         | `GET`    | bearer    | `alertIdParamSchema`       | 200 `AlertResponse` |
| `/alerts/{id}`         | `PATCH`  | bearer    | `alertIdParamSchema` + `updateAlertSchema` | 200 `AlertResponse` |
| `/alerts/{id}`         | `DELETE` | bearer    | `alertIdParamSchema`       | 204                |
| `/currency/{pair}`     | `GET`    | bearer    | `currencyPairParamSchema`  | 200 `CurrencyRateResponse` |

**OpenAPI templates paths with braces, not colons.** `/alerts/{id}`, never
`/alerts/:id` — Swagger UI renders the Express spelling as a literal path
segment and "Try it out" then requests a URL containing `:id`.

Failure responses, from the routes and `errorHandler`:

| operation        | documented failures                                  |
| ---------------- | ---------------------------------------------------- |
| `/auth/register` | 409 (email taken), 422, 429                          |
| `/auth/login`    | 401, 422, 429                                        |
| `/auth/refresh`  | 401 (missing/expired/rotated), 429                   |
| `/auth/logout`   | none — 204 even without a cookie, deliberately       |
| every `bearer` route | 401                                              |
| `/alerts` POST   | 409 (duplicate active alert), 422                    |
| `/alerts/{id}` ×3 | 404, 422 (malformed uuid)                           |
| `/alerts/{id}` PATCH | 409, 422                                         |
| `/currency/{pair}` | 404 (`unsupported-code`), 422, 502, 503            |

`/currency/{pair}`'s 404 and 503 are worth a sentence each in the description —
they are upstream conditions a caller cannot deduce from the path, and the 503
is the one the SPA should retry.

---

## Phase 0 — Dependencies and environment

1. Two packages, one of them types:

   ```
   yarn add swagger-ui-express
   yarn add -D @types/swagger-ui-express
   ```

   The types package is at 4.1.8 against a 5.0.1 runtime. The lag is in the
   registry, not a mistake — the module's surface (`serve`, `setup`) has not
   changed. Nothing else is needed: Zod does the conversion and Express serves
   the assets.

2. [`config/env.ts`](../src/config/env.ts), after `EXCHANGE_RATE_API_KEY`:

   ```ts
   // Not `z.coerce.boolean()`, which is `Boolean(value)` and turns the string
   // "false" into true. Environment variables are only ever strings.
   DOCS_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
   ```

   The same trap `booleanParam` in [`alert.schema.ts`](../src/schemas/alert.schema.ts)
   already documents, in the one other place this repo reads a boolean off a string.

3. [`.env.example`](../.env.example):

   ```
   # Swagger UI at /docs. Turn off in production — it maps every endpoint.
   DOCS_ENABLED=true
   ```

## Phase 1 — Metadata on the existing schemas

Decision 3, applied. Three files, no behaviour change — `.meta()` is inert at
runtime and `z.infer` is unaffected, so `yarn typecheck` passing is the whole
verification.

4. [`auth.schema.ts`](../src/schemas/auth.schema.ts) — `format: 'email'` and an
   example back onto `emailSchema`. Add examples to `passwordSchema` and
   `phoneNumber` while there; the phone regex is unreadable in the UI without one.
5. [`alert.schema.ts`](../src/schemas/alert.schema.ts) — `decimalString` gets the
   description from decision 3, `currencyCode` gets `examples: ['USD']`, and
   `directionSchema` gets a line saying what `ABOVE` and `BELOW` compare.
6. [`currency.schema.ts`](../src/schemas/currency.schema.ts) — the `pair` segment,
   which is the one that currently documents as a bare string.

Keep these short. This repo's [sparse-comments](../.claude/skills/sparse-comments/SKILL.md)
discipline applies to `description` too: a field whose name says it needs no prose.

## Phase 2 — The OpenAPI module

Four new files. `src/openapi/` is a new directory rather than more entries in
`schemas/` and `routes/`, because the document is one cohesive thing and
splitting it across the existing folders would scatter it.

```
src/
  openapi/
    json-schema.ts       # the z.toJSONSchema wrapper
    response.schema.ts   # Zod mirrors of the mapper types + ErrorResponse
    document.ts          # the assembled OpenAPI 3.1 document
  routes/docs.routes.ts  # mounts swagger-ui and GET /openapi.json
```

Relative imports carry `.js`; only generated Prisma files are imported with
`.ts`. Match the neighbours.

### 7. `openapi/json-schema.ts`

The only file that calls the converter, so decision 2 is enforced by there being
nowhere else to pass a different `io`:

```ts
/**
 * Always `io: 'input'`: OpenAPI documents what the caller sends, and the output
 * direction throws outright on any schema carrying a transform — which is four
 * of the seven request schemas.
 *
 * `$schema` and `$id` are stripped because an OpenAPI schema object may not
 * carry them, and `z.toJSONSchema` emits both.
 */
export function toOpenApiSchema(schema: z.ZodType): Record<string, unknown>;

/** The registry's schemas, shaped for `components.schemas`. */
export function toComponentSchemas(): Record<string, unknown>;
```

Plus the registry itself — `export const registry = z.registry<{ id: string }>()`
— which `response.schema.ts` adds to and `document.ts` reads.

### 8. `openapi/response.schema.ts`

Decision 4. One Zod object per mapper type, each with its `satisfies` guard and
each registered:

```ts
export const alertResponseSchema = z.object({
  id: z.uuid(),
  baseCurrency: currencyCode,
  quoteCurrency: currencyCode,
  targetRate: z.string().meta({ examples: ['5.1204'] }),
  direction: directionSchema,
  isActive: z.boolean(),
  triggeredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}) satisfies z.ZodType<AlertResponse>;

registry.add(alertResponseSchema, { id: 'AlertResponse' });
```

Then `userResponseSchema`, `currencyRateResponseSchema`, `alertPageSchema`,
`sessionResponseSchema` (`{ accessToken, expiresIn }`), `authResponseSchema`
(session plus `user`), and:

```ts
export const errorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    // Present on a 422, absent on most other failures. Do not depend on it.
    details: z.unknown().optional(),
  }),
});
```

`targetRate` is `z.string()` and not `decimalString` — the response side is
already a string and has no transform to convert. Reusing `currencyCode` and
`directionSchema` from the request schemas is fine and desirable: those are
plain, transform-free constraints and the shared reference is what keeps the
documented enum honest when `Direction` changes.

### 9. `openapi/document.ts`

Builds the document, exported as a function rather than a top-level constant so
nothing is computed when `DOCS_ENABLED` is false:

```ts
export function buildOpenApiDocument(): OpenAPIV3_1.Document;
```

Contents, in order: `openapi: '3.1.0'`; `info` (title, version — read
`package.json`'s or hardcode `0.1.0`, but not both); `servers: [{ url: '/' }]`
(decision 6); `tags` for **auth**, **alerts**, **currency**, **system**, which
is what gives Swagger UI its four collapsible groups; `components`
(`securitySchemes` from decision 6, `schemas` from `toComponentSchemas()`); a
top-level `security: [{ bearerAuth: [] }]` with the five public and cookie-only
operations overriding it with their own `security` — `security: []` on the
public ones, which is how OpenAPI spells "explicitly none".

Then `paths`, one entry per row of the [inventory](#inventory). Two small
helpers keep it a table rather than a wall:

```ts
const jsonBody = (schema: z.ZodType) => ({
  required: true,
  content: { 'application/json': { schema: toOpenApiSchema(schema) } },
});

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ref('ErrorResponse') } },
});
```

Query and path parameters come from the same converter, split into OpenAPI's
per-parameter form: take `toOpenApiSchema(listAlertsQuerySchema).properties`,
and emit one `{ name, in: 'query', required, schema }` per key, with `required`
read from the converted schema's `required` array. Write that as a
`parametersFrom(schema, 'query' | 'path')` helper — three call sites use it, and
doing it by hand for `listAlertsQuerySchema`'s seven fields is where a typo
lives.

`POST /alerts` also documents its `Location` response header, which the
controller sets and which is currently invisible to anyone reading the code.

### 10. `routes/docs.routes.ts`

```ts
const router = Router();
const document = buildOpenApiDocument();

// The raw document, for SPA codegen and for `curl | jq`. Ahead of the UI mount
// so it is reachable even if the bundled assets fail to load.
router.get('/openapi.json', (_req, res) => {
  res.status(200).json(document);
});

router.use('/docs', swaggerUi.serve, swaggerUi.setup(document, { customSiteTitle: 'Exchange Monitor API' }));
```

Built once at module load, not per request: the document is a pure function of
code that cannot change while the process runs.

### 11. Mount in [`app.ts`](../src/app.ts)

```ts
if (env.DOCS_ENABLED) {
  app.use(docsRoutes);
}
```

Placed after `/currency` and **before the 404 forwarder**, which must keep its
position, as must `errorHandler` last. No prefix on the `app.use` — the router
owns both of its own paths. When the flag is off nothing is mounted and `/docs`
is an ordinary 404 (decision 7).

## Phase 3 — Verify

`yarn typecheck` is the gate. **Do not run `yarn lint`** — ESLint still cannot
run under TypeScript 7 in this repo.

Then, with the server up:

| #   | check                                                              | expect                                                                 |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1   | `curl -s localhost:3333/openapi.json \| jq .openapi`                | `"3.1.0"`                                                              |
| 2   | `… \| jq '.paths \| keys \| length'`                               | `9` — matches the inventory                                            |
| 3   | `… \| jq '[.paths[] \| keys[]] \| length'`                          | `12` operations                                                        |
| 4   | `… \| jq '.. \| .["$schema"]? // empty'`                            | **empty** — the strip in step 7 works                                  |
| 5   | `… \| jq '.components.schemas.AlertPage.properties.data.items'`     | a `$ref`, not an inlined object                                        |
| 6   | `… \| jq '.paths["/auth/register"]…email'`                          | carries `format: "email"` — Phase 1 landed                             |
| 7   | `… \| jq '.paths["/currency/{pair}"]…pair'`                         | has `examples: ["usd-brl"]`, not a bare `{ type: "string" }`           |
| 8   | `npx @redocly/cli lint openapi.json`                                | no errors — an independent reader, worth the one-off download          |
| 9   | `GET /docs/` in a browser                                           | four tag groups, every operation expandable                            |
| 10  | Try it out → `POST /auth/login`                                     | 200; copy `accessToken` into **Authorize**                             |
| 11  | Try it out → `GET /alerts`                                          | 200 — the bearer scheme is wired                                       |
| 12  | Try it out → `POST /auth/refresh`, same tab, after #10              | **200** — decision 6's same-origin cookie, the one worth doing by hand |
| 13  | Try it out → `GET /currency/usd-brl`                                | 200, `rate` a plain decimal string                                     |
| 14  | `DOCS_ENABLED=false`, restart, `GET /docs`                          | 404 in the standard envelope, not a 403                                |

\#12 is the check that cannot be replaced by reading the document: it is the
only proof that mounting the UI on the API's origin, rather than the SPA's, was
the right call.

## Suggested commit boundaries

1. `chore: add swagger-ui-express and DOCS_ENABLED` — phase 0
2. `docs: add openapi metadata to request schemas` — phase 1, steps 4–6
3. `feat: add openapi document built from zod schemas` — steps 7–9
4. `feat: serve swagger ui at /docs` — steps 10–11

## Open questions

**The response mirrors are a second description of the mapper types.** Decision
4 catches the two drift modes that matter and admits the one it does not. The
alternative — deriving `AlertResponse` from the Zod schema with `z.infer` and
deleting the hand-written type — would close the gap entirely and invert the
dependency so that `mappers/` imports from `openapi/`. That is a bigger change
than adding documentation, and it makes the mappers depend on a module that
exists for the docs. Worth revisiting if a fourth response type shows up.

**Deriving `paths` from the router is not available.** The probe is in
[Verified](#verified-on-this-codebase-2026-09-16): Express 5 exposes
`app.router.stack`, but a mounted router's prefix is only recoverable by running
its matcher against a guessed URL. A coverage check is still possible in the
cheap direction — assert that every path in the document is reachable, by
hitting each with a request and expecting anything other than the 404
forwarder's message. Left out of v1; the inventory table is the checklist for
now.

**Should `openapi.json` be committed?** A `yarn openapi:emit` writing
`docs/openapi.json` would give the SPA a file to run a client generator against
in CI without booting the API, and would make spec changes visible in diffs. It
also becomes a generated artifact that can be stale in a way the runtime
endpoint never is. Not now — add it when the SPA actually wants codegen.

**Swagger UI is not the only renderer.** `@scalar/express-api-reference` is a
drop-in over the same document and renders 3.1 more faithfully. The document is
the asset here and the renderer is one line in `docs.routes.ts`, so this is
cheap to change later and not worth deciding now.

**Rate limiting `/docs`.** The UI serves a few hundred KB of static assets per
load and sits outside `requireAuth`. Not a concern on a single-user deployment;
if it ever becomes one, `DOCS_ENABLED=false` in production is the answer already
built.
