# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` for Cloudflare Workers documentation pointers and the rule that current Cloudflare docs should be retrieved before any Workers/KV/R2/D1/DO/Queues/Vectorize/AI/Agents work — pre-trained knowledge is likely stale.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local dev server (wrangler dev) on http://localhost:8787 |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` — **run after any change to bindings/vars/secrets in `wrangler.jsonc`** |

**Always pass `--env` when deploying.** Because `wrangler.jsonc` defines an `env.staging` block, wrangler warns on any `deploy`/`dev` call without an explicit target. Use `--env=""` for production (the top-level config) and `--env staging` for staging — this matches what `wrangler dev`, `wrangler secret put`, and `wrangler kv key put` already require to target the right environment.

No test or lint scripts are configured.

## Architecture

Single-file Cloudflare Worker (`src/index.ts`) that bridges Kick livestream webhooks → Discord channel messages.

Flow:
1. Worker accepts `POST` only; non-POST returns 404.
2. Body is parsed as `LivestreamStatusUpdated` (see `src/types.d.ts`) before any branching.
3. Reads the `Kick-Event-Type` header. Only `livestream.status.updated` events with `is_live: true` are processed; everything else is silently acknowledged with a 200 (including `is_live: false` stream-end events, which Kick fires under the same event type).
4. `broadcaster.user_id` is matched against the `subscriptions` JSON array fetched fresh from the `SUBSCRIPTIONS` KV namespace on every request (`env.SUBSCRIPTIONS.get("subscriptions", { type: "json" })`). Each subscription can optionally override the target Discord `channel`, attach a `links` map (platform → URL) appended as a description footer, and a `mentions` array of Discord user IDs prepended to the message content as `<@id>`.
5. A formatted "Stream has gone live" embed is POSTed to `https://discord.com/api/v10/channels/{channel}/messages` using `env.DISCORD_TOKEN` (secret) as the bot token.
6. The Discord call is wrapped in `ctx.waitUntil(processWebhook(...))` so the response returns immediately while the side effect runs to completion.

Important details when editing:
- **Subscriptions live in KV**, not in source. Edit the `subscriptions` key in the `SUBSCRIPTIONS` namespace via `wrangler kv key put subscriptions --path <file.json> --binding SUBSCRIPTIONS [--remote|--local] [--env staging]`. Production and staging have separate namespaces (`kv_namespaces` at top level vs. under `env.staging`). Local dev uses a local KV simulation in `.wrangler/state/` — seed it with `--local`.
- Fallback channel for subscriptions without `channel` set comes from `env.DISCORD_DEFAULT_CHANNEL` (defined in `vars` in `wrangler.jsonc`, with a staging override).
- `DISCORD_TOKEN` is provided via `.dev.vars` locally (see `.dev.vars.example`) and must be set as a secret in production (`wrangler secret put DISCORD_TOKEN` — and `--env staging` for staging). It is not declared in `wrangler.jsonc`.
- Webhook signature verification is an explicit `TODO` in `fetch()` — payloads are currently trusted unconditionally.
- `env` is imported from `cloudflare:workers` at module scope in addition to the per-request `env` param.
- `placement.mode: "smart"` and `nodejs_compat` are enabled in `wrangler.jsonc`.
- `worker-configuration.d.ts` is generated — do not edit by hand; rerun `npm run cf-typegen` instead.
