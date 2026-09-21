---
name: notifier-admin
description: Manage the notifier Worker's authenticated admin API through its live OpenAPI routes.
---

# Notifier admin API

Use this skill when the user asks to inspect or change subscriptions, polling,
WebSub resyncs, activation, or any other notifier admin operation.

The production base URL is `https://notifier.grenuttag.workers.dev`. Use
`NOTIFIER_REMOTE_ADMIN_TOKEN` from the environment; never print or persist the
token. Local development uses `http://localhost:8787` and
`NOTIFIER_ADMIN_TOKEN`.

Before acting, fetch the live OpenAPI document from `/openapi.json` (try
`/api/openapi.json` if needed) and use its operation definitions rather than
hard-coding route names. Resolve path parameters, query parameters, request
bodies, and content types from the selected operation. Send
`Authorization: Bearer <token>` and parse JSON responses.

Read operations may run immediately. For mutations, summarize the exact
operation and affected resource and obtain user confirmation unless the user
has already explicitly authorized that specific change. After mutations,
re-fetch the affected resource and report any failed or non-persisted changes.

Use `curl` or the standard library; do not recreate a project-specific CLI.
If the OpenAPI document is unavailable, use the route descriptions in the
Worker source only as a fallback and state that limitation.
