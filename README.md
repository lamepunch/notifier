# notifier

Cloudflare Worker that posts Discord notifications when a subscribed Kick
channel goes live (via Kick webhooks) or a subscribed YouTube channel uploads
a video (via WebSub/PubSubHubbub).

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in DISCORD_TOKEN, ADMIN_TOKEN, YOUTUBE_TOKEN
```

Local YouTube WebSub needs a public callback. Funnel `wrangler dev` so the hub can reach you:

```sh
tailscale funnel --bg 8787
npm run dev
```

`npm run dev` passes `--var SERVICE_URL:https://laptop-mbp.corgi-spica.ts.net`, which overrides the workers.dev URL in `wrangler.jsonc`. Deploy still uses the production value.

Subscriptions live as individual keys in the `SUBSCRIPTIONS` KV namespace:

| Key | Value |
|-----|--------|
| `kick:{user_id}` | `{ id, slug, active, channel?, links?, mentions? }` |
| `youtube:{channelId}` | `{ id, name, url, active, icon?, channel?, lastSubscribedAt? }` |

`active: false` keeps the record but skips Discord notifies. The daily cron
enqueues a WebSub refresh for **active** YouTube channels that have not
been subscribed in the last 10 days; the queue consumer posts to the hub,
stores `lastSubscribedAt` on success, and retries on failure.

Create the Queues once before the first deploy (account-level names):

```sh
npx wrangler queues create notifier-youtube-websub
```

## Admin CLI

Subscription admin logic runs on the Worker under `/admin/*`. The CLI is a
thin HTTP client that sends `Authorization: Bearer $ADMIN_TOKEN`.

Locally, run `npm run dev` so the Worker (and local KV/queue) are up. Export
`ADMIN_TOKEN` to match `.dev.vars` (the Worker loads the secret from there).

```sh
export ADMIN_TOKEN=...   # same value as in .dev.vars
npm run admin -- --help
npm run admin -- list
npm run admin -- list youtube
npm run admin -- add kick <alias> [--channel <discordId>]
npm run admin -- add youtube <alias>
npm run admin -- activate youtube <alias>
npm run admin -- deactivate kick <alias>
npm run admin -- test kick <alias>   # stub
```

Defaults to `http://localhost:8787`. Use `--remote` for
`https://notifier.grenuttag.workers.dev`, or `--url <url>` for another base.
A YouTube `add` enqueues a WebSub subscribe job on the Worker.

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
YouTube channels (retries until the hub accepts); Kick webhooks must be
pointed at the worker URL from Kick's side.
