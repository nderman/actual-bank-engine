# PostHog.md — actual-bank-engine

Context + implementation spec for adding PostHog to this repo. Written so a coding
agent (or human) can pick it up cold. Read `SPECIFICATION.md` for the pipeline and
`src/core/` for the seams referenced below before writing code.

## Why PostHog here (the angle)
This is a **pure backend** integration — no frontend, no `posthog-js`. The point is to
demonstrate server-side product analytics on a real serverless pipeline:
- **Funnel / product analytics** over the daily sync pipeline (fetch → ingest → reconcile).
- **Error tracking** for the failure mode that has actually bitten this project: silent
  Vercel "UNKNOWN" states where a deploy/cron quietly stops working.
- **Feature flags** to toggle a bank plugin without a redeploy.
- **HogQL** to answer "txns synced/day, reconcile drift over time, which plugin fails most."

**The one gotcha that matters (and is a good interview point):** Vercel functions *freeze*
the moment the handler returns. The PostHog Node SDK batches events in memory, so you
**must `await posthog.shutdown()` before returning** or events are silently dropped.
Mirror the existing "one Actual session per sweep, shut down once" discipline in
`api/cron/sync.ts`.

## Tools / products to use
| Product | Use | SDK surface |
|---|---|---|
| Product analytics | pipeline funnel events | `posthog.capture({ distinctId, event, properties })` |
| Error tracking | catch blocks in sync/reconcile | `posthog.captureException(err, distinctId, props)` |
| Feature flags | gate a plugin / lookback widening | `await posthog.isFeatureEnabled(key, distinctId)` |
| HogQL / Data warehouse | dashboards after data lands | (UI / query API, no code) |

Package: `posthog-node` (NOT `posthog-js`). Docs: https://posthog.com/docs/libraries/node

## Config
Add to `src/core/config.ts` (zod-validated, all optional so the engine still runs with
analytics off):
- `POSTHOG_KEY` — project API key (`phc_...`)
- `POSTHOG_HOST` — default `https://us.i.posthog.com` (use `eu.` if the project is EU)
- `POSTHOG_ENABLED` — derived: `Boolean(POSTHOG_KEY)`; lets local runs no-op cleanly.

`distinctId` convention: there are no end-users. Use the **Actual budget id** (or
`"actual-bank-engine"` as a fallback singleton) as the distinct id, and put `plugin`,
`env`, and `window` in event properties.

## Architecture — mirror the Logger pattern
The codebase already has a clean, dependency-light `Logger` (`src/core/logger.ts`) that
is bound into `PluginContext` via `buildContext()` (`src/core/context.ts`). Do the same
for analytics so call sites stay tidy and testable:

1. **`src/core/analytics.ts`** — a thin `Analytics` interface + factory, matching the
   shape/feel of `logger.ts`:
   ```ts
   export interface Analytics {
     capture(event: string, props?: Record<string, unknown>): void;
     captureException(err: unknown, props?: Record<string, unknown>): void;
     isEnabled(flag: string): Promise<boolean>;
     flush(): Promise<void>;   // MUST be awaited before the lambda returns
   }
   ```
   - Real impl wraps a singleton `PostHog` client (construct with `{ flushAt: 1,
     flushInterval: 0 }` so serverless doesn't rely on the timer).
   - When `POSTHOG_ENABLED` is false, return a **no-op Analytics** (every method resolves
     to nothing / `false`). Keeps tests offline and local runs clean — same way the
     project treats optional integrations elsewhere.
2. **Bind it into `PluginContext`** in `buildContext()` next to `logger` and `now`, so
   plugins and handlers get `ctx.analytics` for free.
3. **Flush at the edges only.** Handlers (`api/cron/*.ts`, `api/webhooks/[bank].ts`) own
   the `await ctx.analytics.flush()` in a `finally`, exactly like the session teardown.

## Event taxonomy (the funnel)
Instrument `api/cron/sync.ts` — it already computes everything; we're just emitting it.

| Event | Where | Properties |
|---|---|---|
| `sync_started` | top of handler, after auth | `window {startDate,endDate}`, `plugins[]`, `env` |
| `plugin_fetched` | per plugin success (Phase 1) | `plugin`, `fetched` (count) |
| `plugin_fetch_failed` | per plugin catch (Phase 1) | `plugin`, `error` → also `captureException` |
| `transactions_ingested` | after `ingest()` (Phase 2) | `fetched`, `imported`, `skippedDuplicate` |
| `ingest_failed` | Phase 2 catch | `error` → also `captureException` |
| `sync_completed` | before `res.json(...)` | `summary`, `outcomes` rollup, `durationMs` |

For `api/cron/reconcile.ts` add the parallel pair:
| `reconcile_completed` | success | `accounts[]`, per-account `drift`, `matched` |
| `reconcile_mismatch` | when computed balance ≠ bank balance | `account`, `expected`, `actual`, `drift` |
| `reconcile_failed` | catch | `error` → `captureException` |

This gives a clean PostHog funnel: `sync_started → plugin_fetched → transactions_ingested
→ reconcile_completed`, with drop-offs surfacing exactly where the pipeline breaks.

## Feature flag (one, to prove the concept)
- `plugin-investec-enabled` — checked in the plugin loop in `sync.ts` (skip a poller when
  the flag is off). Lets you disable a flaky bank from the PostHog UI without a deploy —
  directly addresses the "silent Vercel state" pain by giving a kill switch.

## Implementation steps
1. `npm i posthog-node`
2. Add the three env vars to `src/core/config.ts` (zod, optional) + `.env.example` + README.
3. Create `src/core/analytics.ts` (real + no-op) with a unit test like
   `src/core/dedupe.test.ts` (assert no-op when disabled; assert capture payloads when on).
4. Bind `analytics` into `PluginContext` in `context.ts`.
5. Emit the events above in `sync.ts` / `reconcile.ts`; wrap the existing `catch` blocks
   with `captureException`.
6. Add `await ctx.analytics.flush()` in a `finally` in each handler **before returning**.
7. Gate the investec poller behind `plugin-investec-enabled`.
8. Verify: run `npm run discover` / hit `/api/cron/sync` locally with a real key and
   confirm events land in PostHog Activity. Then build a funnel + a "reconcile drift"
   HogQL insight in the UI.

## Don't
- Don't add `posthog-js` or any browser SDK — there is no frontend.
- Don't capture PII: no account numbers, no payee names, no amounts on individual txns.
  Counts and aggregates only. (Bank data — keep event properties boring.)
- Don't let analytics throw into the pipeline — the no-op fallback and try/catch inside
  `analytics.ts` must guarantee a PostHog outage never fails a sync.
- Don't rely on `flushInterval` in serverless — always explicit `flush()`/`shutdown()`.

## Interview talking points this unlocks
- Server-side event capture + funnels on a real cron pipeline (not a snippet on a page).
- The serverless flush-before-freeze gotcha and how you solved it.
- Error tracking as the fix for a concrete production failure you'd actually hit.
- Feature flag as a remote kill-switch for a third-party dependency.
- PII-conscious event design on financial data.
