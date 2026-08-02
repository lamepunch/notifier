# notifier

Cloudflare Worker that posts Discord notifications when a subscribed Kick
channel goes live (via Kick webhooks) or a subscribed YouTube channel uploads
a video (via WebSub/PubSubHubbub).

## Setup

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in DISCORD_TOKEN
```

Seed local KV with the channels to watch:

```sh
wrangler kv key put subscriptions --path subscriptions.json --binding SUBSCRIPTIONS --local --env=""
wrangler kv key put youtube_subscriptions --path youtube.json --binding SUBSCRIPTIONS --local --env=""
```

`subscriptions` is an array of `{ id, channel?, links?, mentions? }` (Kick
broadcaster user IDs), `youtube_subscriptions` an array of YouTube channel IDs.

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

After deploying, the daily cron subscribes to YouTube channels via WebSub;
Kick webhooks must be pointed at the worker URL from Kick's side.
