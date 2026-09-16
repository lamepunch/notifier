# notifier

Cloudflare Worker that posts Discord notifications when a subscribed Kick
channel goes live (via Kick webhooks) or a subscribed YouTube channel uploads
a video (via WebSub/PubSubHubbub, with Data API polling as a backup).

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in DISCORD_TOKEN, ADMIN_TOKEN, YOUTUBE_TOKEN
```

Local YouTube WebSub needs a public callback. Funnel `wrangler dev` so the hub can reach you:

```sh
tailscale funnel --bg 8787
npm start
```

`npm start` passes `--var SERVICE_URL:https://laptop-mbp.corgi-spica.ts.net`, which overrides the workers.dev URL in `wrangler.jsonc`. Deploy still uses the production value. The hub callback is `SERVICE_URL/webhooks/youtube`.

Subscriptions live as individual keys in the `SUBSCRIPTIONS` KV namespace:

| Key | Value |
|-----|--------|
| `kick:{user_id}` | `{ id, slug, active, channel?, links?, mentions? }` |
| `youtube:{channelId}` | `{ id, name, url, active, icon?, channel?, lastSubscribedAt?, lastVerifiedAt?, polling?: { all, members } }` |

`active: false` keeps the record but skips Discord notifies. Omit `polling`
when both flags are false; when present, both keys are set. `polling.all`
polls public uploads via Data API `playlistItems` (uploads playlist `UC…` →
`UU…`) as a WebSub backup. `polling.members` is stored for later and is not
polled yet.

The daily cron enqueues a WebSub refresh for **active** YouTube channels that
have not been subscribed in the last 10 days; the queue consumer posts to the
hub, stores `lastSubscribedAt` on success, and on the first hub failure sets
`polling.all` and enqueues a poll job. Poll jobs run every 15 minutes while
`polling.all` is true and share WebSub’s notify path (active + published in
the last 24h + `youtube_video_sent:{videoId}` unset). `polling.all` clears
when a hub feed POST is accepted and Discord is sent, not when the hub
accepts the subscribe POST. The daily cron also re-enqueues poll jobs for
those channels so a dropped message cannot kill the loop. The hub's later GET to
`/webhooks/youtube` (RFC query: `hub.mode`, `hub.topic`, `hub.challenge`,
`hub.lease_seconds`) is accepted only for a stored channel and sets
`lastVerifiedAt`. `GET /` still accepts verification so existing origin
callbacks keep working until they refresh.

Create the Queues once before the first deploy (account-level names):

```sh
npx wrangler queues create notifier-youtube-websub
npx wrangler queues create notifier-youtube-poll
```

## Admin CLI

Subscription admin logic runs on the Worker under `/admin/*`. The CLI is a
thin HTTP client that sends `Authorization: Bearer` with a token from the
environment. Local calls use `NOTIFIER_ADMIN_TOKEN`; `--remote` uses
`NOTIFIER_REMOTE_ADMIN_TOKEN`. The Worker secret is still `ADMIN_TOKEN`
(`.dev.vars` locally, `wrangler secret` in production).

Locally, run `npm start` so the Worker (and local KV/queue) are up.

```sh
export NOTIFIER_ADMIN_TOKEN=...          # same value as ADMIN_TOKEN in .dev.vars
export NOTIFIER_REMOTE_ADMIN_TOKEN=...   # same value as the production secret
npx admin --help
npx admin list
npx admin list youtube
npx admin add kick <alias> [--channel <discordId>]
npx admin add youtube <alias>
npx admin activate youtube <id>
npx admin deactivate kick <id>
npx admin resync              # enqueue WebSub subscribe for all active YouTube channels
npx admin poll youtube <id> --all|--members|--off
npx admin test kick <alias>   # stub
```

Defaults to `http://localhost:8787`. Use `--remote` for
`https://notifier.grenuttag.workers.dev`.
A YouTube `add` enqueues a WebSub subscribe job on the Worker.
`npx admin poll youtube <id> --all` sets `polling.all` and enqueues a poll
job immediately. `--members` only stores the flag. `--off` removes `polling`.

If production is behind Cloudflare Access, the CLI must be allowed through
(path bypass or Access service token). Worker auth is Bearer only.

## Deploy

```sh
wrangler secret put DISCORD_TOKEN
wrangler secret put ADMIN_TOKEN
wrangler secret put YOUTUBE_TOKEN
npm run deploy
```

After deploying, the daily cron enqueues WebSub refreshes for **active**
YouTube channels (retries until the hub accepts; first hub failure turns on
`polling.all`) and poll watchdog jobs for channels already polling; Kick
webhooks must be pointed at the worker URL from Kick's side.
