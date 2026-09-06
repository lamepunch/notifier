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
only refreshes WebSub for **active** YouTube channels.

Admin CLI (lookup/KV writes are still stubs):

```sh
npm run admin -- --help
npm run admin -- list
npm run admin -- add kick <slug> [--channel <discordId>]
npm run admin -- add youtube <handle> [--channel <discordId>]
npm run admin -- activate kick <slug>
npm run admin -- deactivate youtube <handle>
npm run admin -- test kick <slug>
```

Until the CLI writes KV, seed local keys with wrangler:

```sh
wrangler kv key put kick:123 --path kick.json --binding SUBSCRIPTIONS --local --env=""
wrangler kv key put youtube:UCxxxx --path youtube.json --binding SUBSCRIPTIONS --local --env=""
```

Run locally:

```sh
npm run dev
```

## Deploy

```sh
wrangler secret put DISCORD_TOKEN --env=""
npm run deploy -- --env=""
```

Use `--env staging` instead of `--env=""` to target staging. Always pass one
of the two — the config defines a staging environment, so wrangler wants an
explicit target.

After deploying, the daily cron subscribes to **active** YouTube channels via
WebSub; Kick webhooks must be pointed at the worker URL from Kick's side.
