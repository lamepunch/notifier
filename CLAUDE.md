# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` for Cloudflare Workers documentation pointers and the rule that current Cloudflare docs should be retrieved before any Workers/KV/R2/D1/DO/Queues/Vectorize/AI/Agents work — pre-trained knowledge is likely stale.

## Commands

| Command | Purpose |
|---------|---------|
| `npm start` | Local dev server (wrangler dev) on http://localhost:8787 |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` — **run after any change to bindings/vars/secrets in `wrangler.jsonc`** |
| `npm run admin -- <cmd>` | Thin HTTP client for Worker `/admin` routes. Needs `NOTIFIER_ADMIN_TOKEN` locally (or `NOTIFIER_REMOTE_ADMIN_TOKEN` with `--remote`) and a running Worker (`wrangler dev` or deploy). `list` / `add` / `activate` / `deactivate` / `migrate` are live; `test` is a stub. |

No test or lint scripts are configured.

## Architecture

Cloudflare Worker (`src/index.ts`) that posts Discord messages for Kick go-live webhooks and YouTube WebSub upload pings.

Subscriptions are **one KV key per channel** in `SUBSCRIPTIONS`:

- Kick: `kick:{user_id}` → `{ id, slug, active, channel?, links?, mentions? }`
- YouTube: `youtube:{channelId}` → `{ id, name, url, active, icon?, channel?, lastSubscribedAt? }`
- Dedup: `youtube_video_sent:{videoId}` (unchanged)

`active: false` skips Discord. The daily cron in `src/scheduled.ts` lists `youtube:` keys and enqueues a WebSub refresh per active channel whose `lastSubscribedAt` is missing or older than 10 days. The `queue` handler posts to the hub, records `lastSubscribedAt` on success, and retries on failure (up to 100 queue retries, then a fresh job).

Admin (`src/admin.ts`): authenticated `/admin/subscriptions` routes (Bearer `ADMIN_TOKEN`) for list/add/activate/deactivate/migrate. Lookup + KV + YouTube queue enqueue run in the Worker. The CLI (`scripts/admin.ts`) only `fetch`es those routes. `migrate` copies the old `subscriptions` (Kick records) and `youtube_subscriptions` (channel IDs) blobs into prefix keys.

Flow:
1. Worker accepts admin `/admin/*` (GET/POST), `GET` for YouTube WebSub verification, and `POST` for webhooks; other methods return 404.
2. Kick: `Kick-Event-Type: livestream.status.updated` with `is_live: true` loads `kick:{broadcaster.user_id}`. Inactive or missing keys are skipped; the webhook still gets 200.
3. YouTube: Atom/XML body is parsed; each video loads `youtube:{channelId}`. Notify only if the sub is active, the video is recent, and `youtube_video_sent:{videoId}` is unset.
4. Discord destination: Kick uses `sub.channel ?? DISCORD_DEFAULT_CHANNEL`; YouTube uses `sub.channel ?? DISCORD_DEFAULT_YOUTUBE_CHANNEL`. Kick `links`/`mentions` behave as before. YouTube embed author uses `sub.name` / `sub.icon` when set.
5. Discord POSTs run in `ctx.waitUntil(...)`.
6. Cron does not call the hub directly: it `sendBatch`s `{ channelId }` jobs. Failed hub POSTs `message.retry()` with backoff.

Important details when editing:
- **Subscriptions live in KV**, not in source. Prefix keys (`kick:`, `youtube:`); do not use the old blob keys `subscriptions` / `youtube_subscriptions`. Local admin needs `wrangler dev` running so `/admin` hits the same persist as the Worker.
- Fallback channels come from `env.DISCORD_DEFAULT_CHANNEL` and `env.DISCORD_DEFAULT_YOUTUBE_CHANNEL` (`vars` in `wrangler.jsonc`).
- `DISCORD_TOKEN`, `ADMIN_TOKEN`, and `YOUTUBE_TOKEN` are provided via `.dev.vars` locally (see `.dev.vars.example`) and must be set as secrets (`wrangler secret put …`). They are listed under `secrets.required` in `wrangler.jsonc`. YouTube channel lookup uses Data API v3 (`channels.list`) with `YOUTUBE_TOKEN`.
- Webhook signature verification is an explicit `TODO` in `fetch()` — payloads are currently trusted unconditionally.
- `env` is imported from `cloudflare:workers` at module scope in addition to the per-request `env` param.
- `placement.mode: "smart"` and `nodejs_compat` are enabled in `wrangler.jsonc`.
- `worker-configuration.d.ts` is generated — do not edit by hand; rerun `npm run cf-typegen` instead.
- Admin CLI (`commander` + `tsx`) is a **devDependency** under `scripts/`. Do not import it from Worker code or it will be bundled.
