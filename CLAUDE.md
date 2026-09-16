# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See `AGENTS.md` for Cloudflare Workers documentation pointers and the rule that current Cloudflare docs should be retrieved before any Workers/KV/R2/D1/DO/Queues/Vectorize/AI/Agents work — pre-trained knowledge is likely stale.

## Commands

| Command | Purpose |
|---------|---------|
| `npm start` | Local dev server (wrangler dev) on http://localhost:8787 |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` — **run after any change to bindings/vars/secrets in `wrangler.jsonc`** |
| `npx admin <cmd>` | Thin HTTP client for Worker `/admin` routes. Needs `NOTIFIER_ADMIN_TOKEN` locally (or `NOTIFIER_REMOTE_ADMIN_TOKEN` with `--remote`) and a running Worker (`wrangler dev` or deploy). `list` / `add` / `activate` / `deactivate` / `resync` / `poll` are live; `test` is a stub. |

No test or lint scripts are configured.

## Architecture

Cloudflare Worker (`src/index.ts`) that posts Discord messages for Kick go-live webhooks and YouTube WebSub upload pings.

Subscriptions are **one KV key per channel** in `SUBSCRIPTIONS`:

- Kick: `kick:{user_id}` → `{ id, slug, active, channel?, links?, mentions? }`
- YouTube: `youtube:{channelId}` → `{ id, name, url, active, icon?, channel?, lastSubscribedAt?, lastVerifiedAt?, polling?: { all, members } }`
- Dedup: `youtube_video_sent:{videoId}` (unchanged)

`active: false` skips Discord. Omit `polling` when both flags are false; when present both keys are set. `polling.all` is the WebSub-outage backup (Data API `playlistItems` on the uploads playlist). `polling.members` is stored for later and is not polled yet.

The daily cron in `src/scheduled.ts` lists `youtube:` keys and enqueues a WebSub refresh per active channel whose `lastSubscribedAt` is missing or older than 10 days. It also enqueues a poll job for every active channel with `polling.all`. The `queue` handler dispatches on `batch.queue`: WebSub jobs post to the hub with callback `SERVICE_URL/webhooks/youtube`, record `lastSubscribedAt` on success (and clear `polling.all`), and on the first hub failure set `polling.all` and enqueue a poll job (retries continue up to 100, then a fresh job). Poll jobs load the channel, skip unless `polling.all` is true, fetch public uploads, run the shared accept/notify helper, and `send` the next job with `delaySeconds: 900`. WebSub GET `/webhooks/youtube` (and alias `GET /`) echoes the challenge only when the RFC query parses and `youtube:{channelId}` exists on subscribe (and records `lastVerifiedAt`); unsubscribe is accepted only when that key is missing.

Admin (`src/admin.ts`): authenticated `/admin/subscriptions`, `/admin/subscriptions/:provider`, `/admin/subscriptions/youtube/resync`, `/admin/subscriptions/youtube/:id/poll`, and `/admin/subscriptions/:provider/:id` routes (Bearer `ADMIN_TOKEN`) for list/add/activate/deactivate/resync/poll. Add looks up the alias; activate/deactivate use the stored Kick user id or YouTube channel id. Resync enqueues a WebSub subscribe job for every active YouTube channel (skips the cron’s 10-day lease filter). Poll merges `{ all?: boolean, members?: boolean }` into the stored flags and enqueues a poll job when `all` is true. The CLI (`scripts/admin.ts`) only `fetch`es those routes.

Flow:
1. Worker accepts admin `/admin/*` (GET/POST), `GET`/`POST` `/webhooks/youtube` for YouTube WebSub (KV-checked verification sets `lastVerifiedAt`; `GET /` is an alias), and `POST` for Kick webhooks; other methods return 404.
2. Kick: `Kick-Event-Type: livestream.status.updated` with `is_live: true` loads `kick:{broadcaster.user_id}`. Inactive or missing keys are skipped; the webhook still gets 200.
3. YouTube: Atom/XML body is parsed; each video loads `youtube:{channelId}`. Notify only if the sub is active, the video is recent, and `youtube_video_sent:{videoId}` is unset.
4. Discord destination: Kick uses `sub.channel ?? DISCORD_DEFAULT_CHANNEL`; YouTube uses `sub.channel ?? DISCORD_DEFAULT_YOUTUBE_CHANNEL`. Kick `links`/`mentions` behave as before. YouTube embed author uses `sub.name` / `sub.icon` when set.
5. Discord POSTs run in `ctx.waitUntil(...)`.
6. Cron does not call the hub or Data API directly: it `sendBatch`s `{ channelId }` WebSub jobs and poll watchdog jobs. Failed hub POSTs `message.retry()` with backoff and enable `polling.all` on first failure. Poll jobs self-reschedule every 15 minutes while `polling.all` stays true.

Important details when editing:
- **Subscriptions live in KV**, not in source. Prefix keys (`kick:`, `youtube:`); do not use the old blob keys `subscriptions` / `youtube_subscriptions`. Local admin needs `wrangler dev` running so `/admin` hits the same persist as the Worker.
- Fallback channels come from `env.DISCORD_DEFAULT_CHANNEL` and `env.DISCORD_DEFAULT_YOUTUBE_CHANNEL` (`vars` in `wrangler.jsonc`).
- `DISCORD_TOKEN`, `ADMIN_TOKEN`, and `YOUTUBE_TOKEN` are provided via `.dev.vars` locally (see `.dev.vars.example`) and must be set as secrets (`wrangler secret put …`). They are listed under `secrets.required` in `wrangler.jsonc`. YouTube channel lookup uses Data API v3 (`channels.list`) with `YOUTUBE_TOKEN`; polling uses `playlistItems.list` on the uploads playlist (`UC…` → `UU…`).
- Webhook signature verification is an explicit `TODO` in `fetch()` — payloads are currently trusted unconditionally.
- `env` is imported from `cloudflare:workers` at module scope in addition to the per-request `env` param.
- `placement.mode: "smart"` and `nodejs_compat` are enabled in `wrangler.jsonc`.
- `worker-configuration.d.ts` is generated — do not edit by hand; rerun `npm run cf-typegen` instead.
- Admin CLI (`commander` + `tsx`) is a **devDependency** under `scripts/`. Do not import it from Worker code or it will be bundled.
