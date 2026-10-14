---
name: notifier-troubleshoot
description: Diagnose why a YouTube upload or Kick go-live did not produce a Discord message from the notifier Worker.
---

# Troubleshooting missing Discord posts

Use this skill when the user reports that a video or stream was not posted to
Discord. Work from the outside in and stop once one step explains the miss.
These steps only read data. Ask before changing a subscription, deleting KV
keys, or re-posting.

Use the `notifier-admin` skill for admin API calls (base URL, token, and
OpenAPI discovery). Production admin calls use `NOTIFIER_REMOTE_ADMIN_TOKEN`.
The `ADMIN_TOKEN` in `.dev.vars` is local-only and returns `401` against
production.

Don't diagnose production through `wrangler dev`. It reads a local copy of
the `subs` KV, but `SERVICE_URL` still points hub lookups at the production
callback. The output mixes local subscriptions with production hub state.
Use the production admin API, or `wrangler kv … --remote`.

## 1. Subscription

Fetch the channel's record and live hub state in one call:

```
GET /admin/subscriptions/youtube/{channelId}
```

The response holds the KV record under `youtube:{channelId}` and a `hub`
object. If you only know the channel name or `@handle`, list
`GET /admin/subscriptions/youtube` and match on `name` or `url`.

Check that:

- `active` is `true`. If it is `false`, Discord is skipped by design.
- `channel` is set. If it is missing, posts go to
  `DISCORD_DEFAULT_YOUTUBE_CHANNEL` in `wrangler.jsonc`. People often look in
  the wrong channel.
- `polling` is set. If it is `true`, the WebSub hub failed at some point and
  the hourly poll cron covers the gap.

## 2. WebSub hub

In the `hub` object (or `GET /admin/subscriptions/youtube/hub` for all
channels):

- `state` should be `verified` and `expiresAt` in the future. The daily cron
  renews leases older than 8 days.
- `lastDeliveryError` should be `n/a`, or older than the upload.

If the admin API is unavailable, query the hub directly:
`https://pubsubhubbub.appspot.com/subscription-details?hub.callback=https%3A%2F%2Fnotifier.grenuttag.workers.dev%2Fwebhooks%2Fyoutube&hub.topic=https%3A%2F%2Fwww.youtube.com%2Fxml%2Ffeeds%2Fvideos.xml%3Fchannel_id%3D{channelId}&hub.secret=`.
"Content received/delivered" shows the hub's last push to the Worker.

## 3. Dedup marker

```
npx wrangler kv key get --binding subs --remote youtube_video_sent:{videoId}
```

If the key exists, the Worker accepted the video and attempted the Discord
post. Its value is the video's `published` timestamp. Markers expire after 7
days.

## 4. Workers Logs

Free-text search only matches the log `message`. It does not find IDs stored
in context fields. Filter on the field instead:

- `videoId` equals `{videoId}`
- `channelId` equals `{channelId}` for all activity on a YouTube channel

Expected log lines for one video:

| Message | Meaning |
|---|---|
| `Video accepted, sending notification` | Passed the subscription, recency, and dedup checks |
| `Video skipped` | See `isSubscribed`, `isRecent` (published < 24h ago), `hasAlreadySent`. Hub redeliveries and edits of old videos land here |
| `YouTube Discord message constructed` | Embed built, same `requestId` as the accept |
| `YouTube Discord message sent` | Discord accepted it. `discord.channelId` and `discord.messageId` locate the post |
| `Discord API request failed` | Discord rejected it. `body` holds Discord's error |

To see every line from the same request, group by `$metadata.requestId`.
`$metadata.id` identifies a single event.

The Cloudflare observability MCP's `events` and `invocations` views can fail
with a schema validation error (`requestId`/`outcome` expected string) on this
Worker's logs. When that happens, use the `calculations` view with `count` or
`min(timestamp)` and `groupBys` on the fields you need (`$metadata.id`,
`$metadata.requestId`, `$metadata.message`).

## 5. Discord

With `discord.channelId` and `discord.messageId`, the post is at
`https://discord.com/channels/{guildId}/{channelId}/{messageId}`.

Don't look for the post by channel name or thumbnail. The embed author and icon
are copied from the KV record when the message is sent. If the creator renamed
the channel or changed the avatar since then, the post looks different from
the channel today.

Posts sent before the `YouTube Discord message sent` log line existed have no
message ID. For those, read the target channel around the accept timestamp.
The bot token in `.dev.vars` may lack Read Message History, which returns
`Missing Access` (50001).

## Re-posting

Re-posting is a mutation, so confirm with the user first, including the
target channel.

```
POST /admin/youtube/videos/{videoId}/post
{ "channel": "<discord channel id>" }   // optional
```

The route looks up the video through the YouTube Data API. It builds the
embed from the uploader's subscription and posts to `channel`, or to the
subscription's channel or the default if `channel` is omitted. It skips the
active, recency, and dedup checks, so it works for videos of any age and
always posts. Run it once per post. It returns `discord.channelId` and
`discord.messageId`, and marks the video as sent so a later ping doesn't post
it again. It returns `404` if the uploader has no subscription and `502` if
Discord rejects the message.

## Kick

Kick go-lives have no dedup marker or video ID. Check `kick:{user_id}`
(`active`, `channel`), then filter Workers Logs on `$workers.event.request.path`
equals `/webhooks/kick` around the stream start, and look for
`Discord message constructed` and `Discord API request failed`.
