# Actual Bank Engine

Extensible banking → [Actual Budget](https://actualbudget.org) integration engine, built as a
pure **Vercel Serverless API**. Supports real-time **webhooks** and scheduled **Vercel Cron**
syncs through one normalization + ledger pipeline. New banks plug in via a small typed interface.

See **[SPECIFICATION.md](./SPECIFICATION.md)** for the full design contract.

## How it works

```
Bank webhook ─▶ /api/webhooks/[bank] ─┐
                                       ├─▶ normalize ─▶ dedupe (imported_id) ─▶ Actual
Vercel Cron  ─▶ /api/cron/sync      ──┘
```

- **Exactly-once:** a transaction seen via both a webhook and a cron sweep is booked once,
  enforced by a deterministic `imported_id` (bank id, else a hash of invariant fields).
- **Serverless-safe:** `@actual-app/api` writes to `/tmp` (the only writable path on Vercel); the
  Actual session is always torn down with `actual.shutdown()` via a `finally` guard.

## Project layout

| Path | Purpose |
|---|---|
| `api/webhooks/[bank].ts` | Real-time ingestion endpoint |
| `api/cron/sync.ts` | Scheduled polling sweep |
| `src/core/` | Schema, plugin contracts, dedupe, Actual client, ledger engine |
| `src/plugins/investec/` | Reference plugin (OAuth poll + HMAC webhook) |
| `vercel.json` | Cron schedule (`0 */4 * * *`) + function durations |

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run test        # node:test via tsx
npm run lint
```

## Add a bank plugin

1. Create `src/plugins/<bank>/` implementing `BankPlugin` and/or `WebhookPlugin`
   (see `src/core/plugin.ts`). Output **only** `NormalizedTransaction` (see `src/core/schema.ts`).
2. Register it in `src/plugins/registry.ts` (one import + array entry).
3. Add its env vars to `src/core/config.ts` and `.env.example`.

Plugins are pure translators — they never talk to Actual or dedupe; the core engine does that.

## Configure

Copy `.env.example` → `.env` and fill in your Actual server + bank credentials. On Vercel, set
these as Environment Variables and add `CRON_SECRET` (presented by Vercel Cron as a bearer token).
