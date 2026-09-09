# notifier

Cloudflare Worker that posts Discord notifications when a subscribed Kick
channel goes live (via Kick webhooks) or a subscribed YouTube channel uploads
a video (via WebSub/PubSubHubbub).

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in DISCORD_TOKEN
```

Subscriptions live as individual keys in the `SUBSCRIPTIONS` KV namespace:

| Key | Value |
|-----|--------|
| `kick:{user_id}` | `{ id, slug, active, channel?, links?, mentions? }` |
| `youtube:{channelId}` | `{ id, name, url, active, icon?, channel? }` |

`active: false` keeps the record but skips Discord notifies. The daily cron
enqueues a WebSub refresh job per **active** YouTube channel; the queue
consumer posts to the hub and retries on failure.

Create the Queues once before the first deploy (account-level names):

```sh
npx wrangler queues create notifier-youtube-websub
```

Admin CLI uses Wrangler's `getPlatformProxy` so commands share the Worker's
`env.SUBSCRIPTIONS` binding (local persist matches `wrangler dev`). `add`
looks up a Kick slug or YouTube handle and upserts the KV record. `list` is
live; activate/test writes are still stubs:

```sh
npm run admin -- --help
npm run admin -- list
npm run admin -- list youtube
npm run admin -- add kick <alias> [--channel <discordId>]
npm run admin -- add youtube <alias>
npm run admin -- activate youtube <alias>
npm run admin -- deactivate kick <alias>
npm run admin -- test kick <alias>
```

`add` writes local KV by default. Use `--remote` to write production KV
and enqueue on the production WebSub queue (`wrangler.admin.jsonc`).
A YouTube add also enqueues a subscribe job immediately; local jobs are
consumed when `wrangler dev` is running.

Run locally:

```sh
npm run dev
```

## Deploy

```sh
wrangler secret put DISCORD_TOKEN
npm run deploy
```

After deploying, the daily cron enqueues WebSub refreshes for **active**
YouTube channels (retries until the hub accepts); Kick webhooks must be
pointed at the worker URL from Kick's side.
