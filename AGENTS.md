# Project instructions

Do not write or add tests, test scripts, test frameworks, or test commands.
This is a standing user instruction, including for refactors and bug fixes.
It overrides skill guidance recommending or requiring new tests. Use existing
typechecking and build commands for validation.

# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

# Stratal

Before modifying code that uses Stratal, retrieve and follow the applicable
Stratal guidance. Read the Stratal skill first:

- `/Users/grenuttag/.agents/skills/stratal/SKILL.md`

Then read the relevant reference before changing the associated area:

- DI, services, or providers: `references/modules-and-di.md`
- Controllers, routes, or OpenAPI metadata: `references/routing.md`
- Middleware or guards: `references/middleware-and-guards.md`
- Queues or cron jobs: `references/queues-and-cron.md`
- Logging or runtime infrastructure: `references/infrastructure.md`
- SSR or Inertia: `references/inertia.md`
- Errors or validation: `references/errors-and-i18n.md`

Do not rely on pre-trained Stratal knowledge when the installed package or
project reference disagrees. Use the installed Stratal version as the source
of truth, and validate changes with the existing typecheck/build commands.

# Commands

| Command | Purpose |
|---------|---------|
| `npm start` | Local dev server (wrangler dev) on http://localhost:8787 |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after binding/var/secret changes |
| `npx quarry admin <cmd>` | HTTP client for the Worker admin routes; requires a running Worker and local admin token |

No test or lint scripts are configured.

# Architecture

Cloudflare Worker (`src/index.ts`) posts Discord messages for Kick go-live webhooks and YouTube WebSub upload pings.

Subscriptions are one KV key per channel in `SUBSCRIPTIONS`:

- Kick: `kick:{user_id}` → `{ id, slug, active, channel?, links?, mentions? }`
- YouTube: `youtube:{channelId}` → `{ id, name, url, active, icon?, channel?, lastSubscribedAt?, lastVerifiedAt?, polling?: boolean }`
- Deduplication: `youtube_video_sent:{videoId}`

`active: false` skips Discord. `polling: true` enables the WebSub-outage backup through the YouTube Data API.

The daily cron refreshes active YouTube WebSub subscriptions whose lease is missing or older than 10 days. The poll cron enqueues work for active channels with `polling === true`. Failed WebSub requests enable polling; poll jobs self-reschedule every 15 minutes while polling remains enabled. Accepted WebSub notifications clear polling after delivery.

WebSub verification is supported at `GET /webhooks/youtube` and the backward-compatible fallback `GET /`; the challenge is accepted only for known YouTube subscriptions. Feed uploads are handled at `POST /webhooks/youtube`.

Admin routes under `src/admin/` support listing, adding, activating, deactivating, resyncing, and polling subscriptions using Bearer `ADMIN_TOKEN` authentication.

# Important details

- Subscriptions live in KV, not source. Use the `kick:` and `youtube:` prefixes; do not restore the old blob keys.
- Fallback channels come from `env.DISCORD_DEFAULT_CHANNEL` and `env.DISCORD_DEFAULT_YOUTUBE_CHANNEL`.
- `DISCORD_TOKEN`, `ADMIN_TOKEN`, and `YOUTUBE_TOKEN` are provided via `.dev.vars` locally and must be configured as secrets in deployment.
- Webhook signature verification remains an explicit TODO; payloads are currently trusted.
- `env` is imported from `cloudflare:workers` at module scope in addition to per-request bindings.
- `placement.mode: "smart"` and `nodejs_compat` are enabled in `wrangler.jsonc`.
- `worker-configuration.d.ts` is generated; do not edit it by hand.
- The admin CLI is dev-only and must not be imported from Worker code.
