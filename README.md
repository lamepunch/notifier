# notifier

Cloudflare Worker that posts Discord notifications when a subscribed Kick
channel goes live (via Kick webhooks) or a subscribed YouTube channel uploads
a video (via WebSub/PubSubHubbub, with Data API polling as a backup).

The Worker uses Stratal modules for HTTP controllers, queue consumers, and cron
jobs. `src/app.module.ts` is the shared application graph for the Worker and the
Quarry CLI; CLI-only admin commands are registered in `src/quarry.ts` so they do
not enter the Worker bundle.

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in DISCORD_TOKEN, ADMIN_TOKEN, YOUTUBE_TOKEN
```

Development requires Node.js 22 or newer.

Local YouTube WebSub needs a public callback. Funnel `wrangler dev` so the hub can reach you:

```sh
tailscale funnel --bg 8787
npm start
```

`npm start` passes `--var SERVICE_URL:https://laptop-mbp.corgi-spica.ts.net`, which overrides the workers.dev URL in `wrangler.jsonc`. Deploy still uses the production value. The hub callback is `SERVICE_URL/webhooks/youtube`.

Subscriptions live as individual keys in the `subs` KV namespace:

| Key | Value |
|-----|--------|
| `kick:{user_id}` | `{ id, slug, active, channel?, links?, mentions? }` |
| `youtube:{channelId}` | `{ id, name, url, active, icon?, channel?, lastSubscribedAt?, lastVerifiedAt?, polling?: boolean }` |

`active: false` keeps the record but skips Discord notifies. `polling: true`
polls public uploads via Data API `playlistItems` (uploads playlist `UC…` →
`UU…`) as a WebSub backup; omitting `polling` disables it.

The daily cron enqueues a WebSub refresh for **active** YouTube channels that
have not been subscribed in the last 10 days. The queue consumer posts to the
hub and stores `lastSubscribedAt` on success. A failed subscribe immediately
enables `polling`; the hourly cron then enqueues polling while the flag
remains enabled. Polling shares WebSub's notify path (active + published in the
last 24h + `youtube_video_sent:{videoId}` unset). `polling` clears when
a hub feed POST is accepted and its Discord notification is scheduled, not when
the hub accepts the subscribe POST. There are no delayed self-poll messages.

Queue jobs use the framework retry policy: three retries at a fixed 60-second
delay. Exhausted jobs are recorded by Stratal in the `queue` KV
namespace for inspection and retry through Quarry. The application does not
retry indefinitely and does not use `Retry-After` to schedule queue work.
The hub's later GET to
`/webhooks/youtube` (RFC query: `hub.mode`, `hub.topic`, `hub.challenge`,
`hub.lease_seconds`) is accepted only for a stored channel and sets
`lastVerifiedAt`. YouTube callbacks are accepted only at `/webhooks/youtube`.

Queue producers dispatch through Stratal's injected senders, and the Worker
exports Stratal directly for HTTP, queue, and scheduled events.

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
npx quarry help admin list
npx quarry admin list
npx quarry admin list youtube
npx quarry admin add kick <alias> [--channel <discordId>]
npx quarry admin add youtube <alias>
npx quarry admin activate youtube <id>
npx quarry admin deactivate kick <id>
npx quarry admin resync             # enqueue WebSub subscribe for active channels
npx quarry admin poll youtube <id> --on|--off
npx quarry admin test kick <alias>  # JSON no-op stub
```

Defaults to `http://localhost:8787`. Use `--remote` for
`https://notifier.grenuttag.workers.dev`.
A YouTube `add` enqueues a WebSub subscribe job on the Worker.
`admin poll youtube <id> --on` enables `polling` and triggers an immediate
poll through the Worker. `--off` removes `polling`. Admin command responses are
emitted as JSON on stdout; validation,
authentication, and HTTP failures return a nonzero exit code.

Quarry also exposes the Stratal application inventory and failed-job tools:

```sh
npx quarry route:list --hidden    # include the hidden /admin routes
npx quarry schedule:list
npx quarry queue:list
npx quarry queue:failed
npx quarry queue:retry <id>
```

The built-in queue commands use Quarry's configured bindings, which are local
by default. `--remote` applies only to the `admin` HTTP commands.

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
YouTube channels and the 15-minute cron enqueues work for channels already
polling; Kick
webhooks must be pointed at `https://notifier.grenuttag.workers.dev/webhooks/kick`
from Kick's side. Legacy root and catch-all webhook URLs return 404.
