# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` for Cloudflare Workers documentation pointers and the rule that current Cloudflare docs should be retrieved before any Workers/KV/R2/D1/DO/Queues/Vectorize/AI/Agents work — pre-trained knowledge is likely stale.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Local dev server (wrangler dev) on http://localhost:8787 |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` — **run after any change to bindings/vars/secrets in `wrangler.jsonc`** |
| `npm run admin -- <cmd>` | KV/test CLI (`scripts/admin.ts`). Lookup and writes are stubs. |

**Always pass `--env` when deploying.** Because `wrangler.jsonc` defines an `env.staging` block, wrangler warns on any `deploy`/`dev` call without an explicit target. Use `--env=""` for production (the top-level config) and `--env staging` for staging — this matches what `wrangler dev`, `wrangler secret put`, and `wrangler kv key put` already require to target the right environment.

No test or lint scripts are configured.

## Architecture

Cloudflare Worker (`src/index.ts`) that posts Discord messages for Kick go-live webhooks and YouTube WebSub upload pings.

Subscriptions are **one KV key per channel** in `SUBSCRIPTIONS`:

- Kick: `kick:{user_id}` → `{ id, slug, active, channel?, links?, mentions? }`
- YouTube: `youtube:{channelId}` → `{ id, name, url, active, icon?, channel? }`
- Dedup: `youtube_video_sent:{videoId}` (unchanged)

`active: false` skips Discord. The daily cron in `src/scheduled.ts` lists `youtube:` keys and only re-subscribes to the hub when `active` is true.

Flow:
1. Worker accepts `POST` (and `GET` for YouTube WebSub verification); other methods return 404.
2. Kick: `Kick-Event-Type: livestream.status.updated` with `is_live: true` loads `kick:{broadcaster.user_id}`. Inactive or missing keys are skipped; the webhook still gets 200.
3. YouTube: Atom/XML body is parsed; each video loads `youtube:{channelId}`. Notify only if the sub is active, the video is recent, and `youtube_video_sent:{videoId}` is unset.
4. Discord destination: Kick uses `sub.channel ?? DISCORD_DEFAULT_CHANNEL`; YouTube uses `sub.channel ?? DISCORD_DEFAULT_YOUTUBE_CHANNEL`. Kick `links`/`mentions` behave as before. YouTube embed author uses `sub.name` / `sub.icon` when set.
5. Discord POSTs run in `ctx.waitUntil(...)`.

Important details when editing:
- **Subscriptions live in KV**, not in source. Prefix keys (`kick:`, `youtube:`); do not use the old blob keys `subscriptions` / `youtube_subscriptions`. Production and staging have separate namespaces (`kv_namespaces` at top level vs. under `env.staging`). Local dev uses `.wrangler/state/` — seed with `--local`.
- Fallback channels come from `env.DISCORD_DEFAULT_CHANNEL` and `env.DISCORD_DEFAULT_YOUTUBE_CHANNEL` (`vars` in `wrangler.jsonc`, with staging overrides).
- `DISCORD_TOKEN` is provided via `.dev.vars` locally (see `.dev.vars.example`) and must be set as a secret (`wrangler secret put DISCORD_TOKEN` — and `--env staging` for staging). It is not declared in `wrangler.jsonc`.
- Webhook signature verification is an explicit `TODO` in `fetch()` — payloads are currently trusted unconditionally.
- `env` is imported from `cloudflare:workers` at module scope in addition to the per-request `env` param.
- `placement.mode: "smart"` and `nodejs_compat` are enabled in `wrangler.jsonc`.
- `worker-configuration.d.ts` is generated — do not edit by hand; rerun `npm run cf-typegen` instead.
- Admin CLI (`commander` + `tsx`) is a **devDependency** under `scripts/`. Do not import it from Worker code or it will be bundled.
