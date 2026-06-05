# Actual Bank Engine — Design Specification

> An open-source, extensible banking → [Actual Budget](https://actualbudget.org) integration
> engine. Runs as a **pure Vercel Serverless API** (`/api`), supporting both **real-time
> webhooks** and **Vercel Cron scheduled syncs**. A modular, plugin-based architecture lets
> developers contribute modules for any bank.

**Status:** Living document. This is the contract that all code in this repository must honour.
**Audience:** Contributors writing new bank plugins, and operators deploying the engine.

---

## 0. Goals & Non-Goals

### Goals
- **Zero-server hosting.** Everything runs on Vercel Serverless Functions. No long-lived
  process, no persistent disk, no managed database required for the baseline.
- **Two ingestion paths, one engine.** Webhooks (push) and Cron polling (pull) both funnel into
  the *same* normalization + ledger pipeline.
- **Plugin-first.** Adding a new bank means implementing a small, well-typed interface and
  registering it. No core changes.
- **Exactly-once semantics into Actual.** A transaction seen by both a webhook and a cron sweep
  must never be double-booked.
- **Type-safe and validated end to end.** TypeScript + `zod` runtime validation at every trust
  boundary (webhook payloads, bank API responses, env config).

### Non-Goals
- Not a budgeting UI. Actual Budget is the system of record for the budget itself.
- Not a multi-tenant SaaS (though the plugin model does not preclude it).
- Not a categorization/ML engine. We import raw, normalized transactions; categorization rules
  live in Actual.

---

## 1. Vercel Serverless Architecture

### 1.1 Topology

```
                        ┌──────────────────────────────────────────┐
   Bank (push)  ───────▶│  /api/webhooks/[bank].ts                  │
                        │  • verify signature                       │
                        │  • plugin.parseWebhook(payload)           │──┐
                        └──────────────────────────────────────────┘  │
                                                                       │   NormalizedTransaction[]
                        ┌──────────────────────────────────────────┐  │
   Vercel Cron  ───────▶│  /api/cron/sync.ts                        │  │
                        │  • for each plugin:                       │  │
                        │    plugin.fetchTransactions(start,end)    │──┤
                        └──────────────────────────────────────────┘  │
                                                                       ▼
                        ┌──────────────────────────────────────────────────────┐
                        │  Core Ledger Engine  (src/core/ledger.ts)             │
                        │  • dedupe via deterministic imported_id               │
                        │  • map → Actual transaction shape                     │
                        │  • ActualClient.withSession(...) → importTransactions  │
                        │  • guaranteed actual.shutdown() in finally            │
                        └──────────────────────────────────────────────────────┘
                                                   │
                                                   ▼
                        ┌──────────────────────────────────────────────────────┐
                        │  Actual Budget Server (self-hosted / Actual Cloud)     │
                        │  via @actual-app/api  (dataDir = /tmp)                 │
                        └──────────────────────────────────────────────────────┘
```

### 1.2 Components

| Component | Path | Responsibility |
|---|---|---|
| Webhook endpoint | `api/webhooks/[bank].ts` | Authenticate + verify a single bank's push payload, parse → normalize, hand to engine. |
| Cron endpoint | `api/cron/sync.ts` | Authenticated by Vercel Cron; sweeps every enabled polling plugin over a date window. |
| Core Ledger Engine | `src/core/ledger.ts` | The single funnel: dedupe, map to Actual shape, import, teardown. |
| Actual client wrapper | `src/core/actual-client.ts` | Owns the `@actual-app/api` lifecycle, `/tmp` config, budget download, session guard. |
| Transaction schema | `src/core/schema.ts` | Immutable `zod` schema + branded types for the normalized transaction. |
| Plugin contracts | `src/core/plugin.ts` | `BankPlugin` / `WebhookPlugin` interfaces + registry. |
| Config | `src/core/config.ts` | `zod`-validated environment access. |
| Bank plugins | `src/plugins/<bank>/` | Concrete implementations (reference: Investec). |

### 1.3 The `/tmp` constraint (CRITICAL)

Vercel function filesystems are **read-only except `/tmp`** (an ephemeral, ~512 MB tmpfs that
lives only for the duration of a warm instance). `@actual-app/api` writes a local SQLite copy of
the budget and sync files to disk, so it **must** be pointed at `/tmp`:

```ts
await actual.init({
  dataDir: '/tmp/actual-data',     // local budget cache — MUST be under /tmp
  serverURL: config.ACTUAL_SERVER_URL,
  password: config.ACTUAL_PASSWORD,
});
```

Implications baked into the design:
- `ActualClient` `mkdir -p /tmp/actual-data` on every cold start (idempotent).
- We **cannot assume** the budget cache survives between invocations (cold start = empty `/tmp`).
  Therefore every session calls `downloadBudget(syncId, { password })` to (re)hydrate. On a warm
  instance this is cheap (delta sync); on cold start it does a full pull.
- We never store secrets or state in `/tmp` expecting durability. `/tmp` is a *scratch cache only*.

### 1.4 Execution model & limits

- **Stateless.** No module-level mutable state is relied upon across requests. A warm instance
  *may* reuse `/tmp`, but correctness never depends on it.
- **Time budget.** Default Vercel function `maxDuration` is raised (see `vercel.json`) for the
  cron sweep, which may download a budget + import. Webhooks stay fast and lean.
- **Concurrency.** Two invocations can run against the same Actual budget concurrently. We rely on
  Actual's `imported_id` dedupe (§3) for correctness, not on locking.

---

## 2. Extensibility & Plugin System

### 2.1 Design principles

- A plugin is a **self-contained folder** under `src/plugins/<bank>/` exporting a default object
  that satisfies `BankPlugin` and/or `WebhookPlugin`.
- Plugins are **pure translators**: bank-shaped data in → `NormalizedTransaction[]` out. They do
  **not** talk to Actual, do **not** dedupe, and do **not** decide what gets imported. That is the
  engine's job. This keeps plugins small and testable.
- Capabilities are **opt-in via interface implementation**. A bank with only a polling API
  implements `BankPlugin`. A bank with only webhooks implements `WebhookPlugin`. Most implement
  both.

### 2.2 Core interfaces

```ts
/** Stable identity + which Actual account this bank's data lands in. */
interface PluginMeta {
  /** URL-safe slug, e.g. "investec". Used in /api/webhooks/[bank] and the registry key. */
  readonly id: string;
  /** Human label for logs. */
  readonly displayName: string;
}

/** Polling capability: pulled by the cron sweep. */
interface BankPlugin extends PluginMeta {
  /**
   * Acquire credentials / tokens. Called once per invocation before fetch.
   * Must be idempotent and safe to call on a cold start.
   */
  init(ctx: PluginContext): Promise<void>;

  /**
   * Fetch transactions in [startDate, endDate] (inclusive, ISO-8601 dates).
   * MUST return fully normalized, immutable transactions. MUST NOT dedupe.
   */
  fetchTransactions(startDate: string, endDate: string): Promise<NormalizedTransaction[]>;
}

/** Webhook capability: pushed in real time. */
interface WebhookPlugin extends PluginMeta {
  /**
   * Verify authenticity of a raw request (HMAC signature, shared secret, mTLS hint, etc.).
   * Throws WebhookVerificationError on failure. Receives the RAW body for signature checks.
   */
  verify(req: RawWebhookRequest, ctx: PluginContext): Promise<void>;

  /**
   * Translate a verified webhook payload into zero or more normalized transactions.
   * Returning [] is valid (e.g. non-transaction events like card-status changes).
   */
  parseWebhook(payload: unknown, ctx: PluginContext): Promise<NormalizedTransaction[]>;
}

/** Injected services available to every plugin. */
interface PluginContext {
  readonly config: EngineConfig;          // validated env
  readonly logger: Logger;                 // structured, request-scoped
  readonly now: () => Date;                // injectable clock for tests
}
```

A plugin module's default export:

```ts
export default {
  ...meta,
  init, fetchTransactions,   // BankPlugin parts
  verify, parseWebhook,      // WebhookPlugin parts
} satisfies BankPlugin & WebhookPlugin;
```

### 2.3 Registry

`src/plugins/registry.ts` maps `id → plugin`. Lookups:
- Webhook route resolves `req.query.bank` → registry entry, 404 on miss.
- Cron sweep iterates all entries that implement `fetchTransactions` and whose env is configured.

Registration is **explicit** (an import + map entry), not filesystem magic — this keeps Vercel's
bundler happy (it traces static imports) and makes the enabled set obvious.

### 2.4 Data Normalization Layer — the Transaction Schema

The single most important contract. Defined once in `src/core/schema.ts` with `zod`, exported as
both a runtime validator and an inferred immutable TypeScript type. Every plugin output is parsed
through it before the engine touches it — a malformed plugin fails loud, at its own boundary.

```ts
const NormalizedTransactionSchema = z.object({
  /** Plugin id that produced this row, e.g. "investec". */
  source: z.string().min(1),

  /**
   * The bank's own stable identifier for this transaction, if any.
   * Preferred basis for the dedupe key. Optional because some banks don't expose one.
   */
  sourceTransactionId: z.string().min(1).optional(),

  /** Which Actual account this belongs to (Actual account UUID). */
  accountId: z.string().uuid(),

  /** Posting/transaction date, ISO-8601 calendar date "YYYY-MM-DD" (Actual stores dates, not times). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  /**
   * Signed integer amount in MINOR units (cents). Negative = outflow, positive = inflow.
   * Integer-only to avoid floating point drift. Matches Actual's integer-cents model.
   */
  amount: z.number().int(),

  /** ISO-4217 currency, e.g. "ZAR". Used for validation/visibility; Actual budget has one currency. */
  currency: z.string().length(3),

  /** Cleaned counterparty / merchant name. */
  payee: z.string().default(''),

  /** Free-text description / reference from the bank. */
  notes: z.string().default(''),

  /** true once the bank considers it settled (not pending/authorization-only). */
  cleared: z.boolean().default(true),

  /** Opaque original record for debugging/audit. Never read by the engine logic. */
  raw: z.unknown().optional(),
}).strict();

type NormalizedTransaction = Readonly<z.infer<typeof NormalizedTransactionSchema>>;
```

**Rules:**
- `amount` is **always integer minor units**. Plugins convert (`Math.round(major * 100)`), never
  pass floats downstream.
- Immutability: the engine treats inputs as `Readonly`. Plugins should `Object.freeze` or simply
  never mutate after construction.
- Unknown fields are rejected (`.strict()`) so a typo in a plugin is a test failure, not silent
  data loss.

---

## 3. Traceability & System Edge Cases

### 3.1 Idempotency & De-duplication — the core invariant

> The same economic event, observed via a webhook **and** via a cron sweep, must result in
> **exactly one** transaction in Actual.

We delegate dedupe to **Actual's built-in `imported_id` mechanism**: when importing, Actual
skips any transaction whose `imported_id` already exists on that account. Our job is to compute a
**deterministic, stable `imported_id`** that is identical no matter which path produced the row.

**`imported_id` derivation (`src/core/dedupe.ts`):**

1. **If the bank gives a stable transaction id** (`sourceTransactionId`): 
   `imported_id = "${source}:${sourceTransactionId}"`.
   This is the strongest key — same id from webhook or poll → same string → Actual dedupes.

2. **Fallback (no bank id):** deterministic hash of the *invariant economic fields*:
   ```
   imported_id = `${source}:${sha256(`${accountId}|${date}|${amount}|${currency}|${payee}|${notes}`)}`
   ```
   We hash only fields that are identical across both ingestion paths. We deliberately **exclude**
   `cleared`, `raw`, and anything time-of-fetch dependent, because a pending→posted transition or
   a richer poll payload must not change the key.

**Why this works across paths:** both `parseWebhook` and `fetchTransactions` for the same bank are
written to populate `sourceTransactionId` from the same bank field, so path 1 yields identical
keys. Where only path-2 hashing applies, the hashed fields are the bank's settled values, equal in
both feeds.

**Edge — pending vs posted:** if a webhook delivers a *pending authorization* and the cron later
sees the *posted* version with a different bank id, these are genuinely two ids. To avoid a
duplicate, plugins SHOULD prefer the **posted/settled id** and SHOULD set `cleared:false` on
pending rows; operators who don't want pending noise can configure the plugin to drop
`cleared:false` rows. This is documented per-plugin; the engine itself imports what it's given.

### 3.2 Rate limiting

- **Outbound (bank APIs).** Each `BankPlugin.fetchTransactions` is responsible for respecting its
  bank's limits. The engine provides a shared `withRetry()` helper (exponential backoff + jitter,
  honouring `Retry-After`) in `src/core/http.ts` that plugins use for HTTP calls.
- **Inbound (webhooks).** The webhook route does the minimum work synchronously (verify + parse +
  one import) and returns `2xx` fast so the bank doesn't retry-storm. Signature verification
  happens *before* any expensive work, so unauthenticated floods are cheap to reject.
- **Cron cadence** is set conservatively in `vercel.json` (default: every 4 hours) — frequent
  enough for freshness, infrequent enough to stay well under bank quotas. Webhooks cover real-time.

### 3.3 Cold-start handling

- A cold start means empty `/tmp`. `ActualClient.init()` recreates `/tmp/actual-data` and
  re-downloads the budget. This is the expected, correct path — never an error.
- Plugin `init()` must assume nothing is cached: re-acquire OAuth tokens each invocation. Tokens
  may be cached in module scope as a *warm-instance optimization only*, always with expiry checks
  and a cold-start fallback.

### 3.4 Connection teardown (memory-leak prevention) — MANDATORY

`@actual-app/api` starts background workers and holds the SQLite handle open. If a Vercel function
returns without `actual.shutdown()`, the instance can leak memory and hang sockets across warm
reuse, eventually OOM-ing or timing out.

**The engine enforces teardown via a single guarded entry point** — no caller ever talks to
`@actual-app/api` directly:

```ts
// src/core/actual-client.ts
async function withSession<T>(fn: (s: ActualSession) => Promise<T>): Promise<T> {
  await init();                    // /tmp dataDir, downloadBudget
  try {
    return await fn(session);
  } finally {
    await actual.shutdown();       // ALWAYS — success, throw, or timeout-unwind
  }
}
```

Every endpoint uses `withSession`. There is no code path that opens a session without the
`finally { shutdown() }`. The cron sweep wraps *all* plugins in **one** session (download once,
import many, shut down once) to amortize the budget download.

### 3.5 Failure isolation

- One plugin throwing in the cron sweep must not abort the others. The sweep collects per-plugin
  results (`Promise.allSettled`-style), imports the successes, and returns a summary with per-plugin
  status. The HTTP response is `200` with a body describing partial failures (so Vercel Cron
  doesn't mark the whole run failed and retry-storm), while errors are logged at `error` level.
- A webhook that fails verification → `401`. A payload that fails schema parse → `400` (the bank
  sent something we don't understand; retrying won't help). Transient Actual/import failure → `503`
  so the bank retries.

### 3.6 Observability

- Structured JSON logs (`src/core/logger.ts`), request-scoped with `source`, `path`, and a counts
  summary (`fetched`, `imported`, `skippedDuplicate`).
- Every import returns Actual's `{ added, updated }` ids; we log `added.length` as `imported` and
  infer duplicates skipped.

---

## 4. Security

- **Webhook authenticity** is per-plugin (`verify()`): HMAC-SHA256 over the raw body with a shared
  secret is the baseline; the raw, unparsed body is preserved for signature computation.
- **Cron authenticity**: `/api/cron/sync` requires the `Authorization: Bearer ${CRON_SECRET}`
  header that Vercel Cron injects, rejecting anything else with `401`.
- **Secrets** live only in Vercel Environment Variables, validated at boot by `config.ts`. Never in
  `/tmp`, never logged.

---

## 5. Repository Layout

```
.
├── SPECIFICATION.md
├── package.json
├── tsconfig.json
├── vercel.json
├── .eslintrc.cjs
├── .prettierrc
├── .env.example
├── api/
│   ├── webhooks/
│   │   └── [bank].ts          # real-time ingestion, resolves plugin by slug
│   └── cron/
│       └── sync.ts            # scheduled polling sweep
└── src/
    ├── core/
    │   ├── config.ts          # zod-validated env
    │   ├── logger.ts
    │   ├── http.ts            # withRetry, rate-limit aware fetch
    │   ├── schema.ts          # NormalizedTransaction (zod, immutable)
    │   ├── dedupe.ts          # deterministic imported_id
    │   ├── plugin.ts          # BankPlugin / WebhookPlugin / context types
    │   ├── actual-client.ts   # /tmp dataDir, withSession + guaranteed shutdown
    │   └── ledger.ts          # the funnel: normalize → dedupe → import
    └── plugins/
        ├── registry.ts
        └── investec/          # reference implementation (poll-only)
            ├── index.ts       # BankPlugin
            ├── auth.ts        # OAuth2 client-credentials
            ├── api.ts         # transaction fetch
            └── map.ts         # Investec record → NormalizedTransaction
```

### 5.1 `vercel.json` cron

```json
{
  "crons": [{ "path": "/api/cron/sync", "schedule": "0 */4 * * *" }]
}
```

> On the Vercel **Hobby** plan, cron runs at most once/day and functions cap at 60s, so the shipped
> `vercel.json` uses a daily schedule (`0 6 * * *`) and `maxDuration: 60`. The cron's multi-day
> lookback window means a once-daily run still loses nothing.

---

## 6. Reference Implementation — Investec

Investec exposes the **Private Bank Account Information API**:
- **OAuth2 client-credentials** (`POST /identity/v2/oauth2/token`) using `client_id` /
  `client_secret` + an `x-api-key` header → short-lived bearer token (valid 30 min).
- **Accounts** (`GET /za/pb/v1/accounts`) and **Transactions**
  (`GET /za/pb/v1/accounts/{accountId}/transactions?fromDate=&toDate=`).
- **No webhooks.** This API is poll-only, so the Investec plugin implements `BankPlugin` only and
  is driven entirely by the cron sweep. (The engine's generic `WebhookPlugin` interface remains
  available for future plugins targeting push-capable banks.)

**Mapping → `NormalizedTransaction`:**

| Investec field | Normalized field | Notes |
|---|---|---|
| `transactionId` / `uuid` | `sourceTransactionId` | basis for `imported_id` |
| `amount` (major, ZAR) + `type` | `amount` | `Math.round(amount*100)`, sign from `type` (`DEBIT`→negative) |
| `transactionDate` / `postingDate` | `date` | normalized to `YYYY-MM-DD` |
| `description` | `payee` + `notes` | merchant cleanup heuristic |
| account mapping (env) | `accountId` | Investec account → Actual account UUID via config map |
| — | `currency` | `"ZAR"` |
| `status` | `cleared` | posted → true, pending → false |

Investec specifics (token caching with expiry, `x-api-key` header, date windowing, ZAR currency)
are contained entirely within `src/plugins/investec/` and never leak into core.

---

## 7. Testing Strategy

- **Unit:** schema parsing (valid/invalid), dedupe key determinism (same event via both paths →
  identical `imported_id`), Investec mapping with recorded fixtures.
- **Boundary:** `verify()` rejects bad signatures; cron rejects missing bearer.
- **No network in tests:** bank HTTP and `@actual-app/api` are injected/mocked.

---

## 8. Configuration (`.env`)

| Var | Purpose |
|---|---|
| `ACTUAL_SERVER_URL` | Actual sync server URL |
| `ACTUAL_PASSWORD` | Actual server password |
| `ACTUAL_SYNC_ID` | Budget sync id to download |
| `ACTUAL_DATA_DIR` | defaults to `/tmp/actual-data` |
| `CRON_SECRET` | shared secret Vercel Cron presents |
| `INVESTEC_CLIENT_ID` / `INVESTEC_CLIENT_SECRET` / `INVESTEC_API_KEY` | Investec OAuth |
| `INVESTEC_ACCOUNT_MAP` | JSON map `{ investecAccountId: actualAccountUuid }` |

---

*End of specification.*
