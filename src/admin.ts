import { AutoRouter, StatusError, type IRequest } from "itty-router";
import { env } from "cloudflare:workers";

import type {
  KickChannelResponse,
  LookupResult,
  Provider,
  Subscription,
  YouTubeChannelListResponse,
  YouTubeSubscription,
  YouTubeTarget,
} from "./types.d.ts";

import { KV_GET_BATCH_LIMIT } from "./constants";
import { KICK_PREFIX, YOUTUBE_PREFIX, kickKey, youtubeKey } from "./kv";

const PROVIDERS = {
  kick: { prefix: KICK_PREFIX },
  youtube: { prefix: YOUTUBE_PREFIX },
} as const;

const PROVIDER_NAMES = Object.keys(PROVIDERS) as Provider[];

const YOUTUBE_ID_RE = /^UC[\w-]{22}$/;
const ERROR_BODY_PREVIEW_LENGTH = 200;

/** True when `value` is `"kick"` or `"youtube"`. */
function isProvider(value: string): value is Provider {
  return value in PROVIDERS;
}

/** JSON HTTP response with an optional status (default 200). */
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/**
 * Returns true if `Authorization: Bearer` matches `ADMIN_TOKEN`.
 * Comparison is constant-time so response timing cannot leak the secret.
 */
function authorize(request: Request): boolean {
  if (!env.ADMIN_TOKEN) return false;

  let header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;

  let encoder = new TextEncoder();
  let provided = encoder.encode(header.slice("Bearer ".length));
  let expected = encoder.encode(env.ADMIN_TOKEN);
  if (provided.byteLength !== expected.byteLength) return false;

  return crypto.subtle.timingSafeEqual(provided, expected);
}

/**
 * All KV key names under `prefix` (e.g. `kick:` or `youtube:`).
 * Cloudflare returns keys in pages, so this loops until the list is complete.
 */
async function listKeys(prefix: string): Promise<string[]> {
  let keys: string[] = [];
  let cursor: string | undefined;

  do {
    let page = await env.SUBSCRIPTIONS.list({ prefix, cursor });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return keys;
}

/**
 * Loads each KV key as JSON. Used by `list` to turn key names into records.
 * Gets keys in batches because Cloudflare caps bulk get at 100 keys.
 */
async function getJsonMap(keys: string[]): Promise<Map<string, unknown>> {
  let out = new Map<string, unknown>();
  for (let i = 0; i < keys.length; i += KV_GET_BATCH_LIMIT) {
    let batch = keys.slice(i, i + KV_GET_BATCH_LIMIT);
    let values = await env.SUBSCRIPTIONS.get(batch, { type: "json" });
    for (let [key, value] of values) {
      if (value) out.set(key, value);
    }
  }
  return out;
}

/**
 * Turns a failed Kick or YouTube HTTP response into a 502 for the admin CLI.
 * Only the first 200 characters of the body are included.
 */
async function throwUpstreamError(
  url: string,
  response: Response,
): Promise<never> {
  let body = await response.text();
  throw new StatusError(
    502,
    `${url} failed: ${response.status} ${body.slice(0, ERROR_BODY_PREVIEW_LENGTH)}`,
  );
}

/**
 * Resolves a Kick slug (or username) to the subscription record we store.
 * Hits Kick's public channel API for `user_id` and `slug`.
 */
async function lookupKick(alias: string): Promise<Subscription> {
  let url = `https://kick.com/api/v2/channels/${encodeURIComponent(alias)}`;
  let response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) await throwUpstreamError(url, response);

  let data = (await response.json()) as KickChannelResponse;
  if (typeof data.user_id !== "number") {
    throw new StatusError(502, `Kick channel ${alias} has no user_id`);
  }

  return {
    id: data.user_id,
    slug: data.slug || alias,
    active: true,
  };
}

/**
 * Parses whatever the CLI passed as a YouTube alias into an API lookup target.
 * Accepts a `UC…` channel id, a youtube.com/channel/UC… URL, or an @handle.
 */
function parseYouTubeAlias(alias: string): YouTubeTarget {
  let s = alias.trim();
  if (YOUTUBE_ID_RE.test(s)) return { id: s };

  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^(www\.|m\.)?youtube\.com\//i, "");
  let channel = s.match(/^channel\/(UC[\w-]{22})/);
  if (channel) return { id: channel[1] };

  s = s.replace(/^@/, "").replace(/[/?#].*$/, "");
  if (YOUTUBE_ID_RE.test(s)) return { id: s };
  if (!s) throw new StatusError(400, `Invalid YouTube alias: ${alias}`);
  return { handle: s };
}

/**
 * Resolves a YouTube alias to the subscription record we store (id, name, url, icon).
 * Calls YouTube Data API v3 `channels.list` with `YOUTUBE_TOKEN`.
 */
async function lookupYouTube(alias: string): Promise<YouTubeSubscription> {
  if (!env.YOUTUBE_TOKEN) {
    throw new StatusError(500, "YOUTUBE_TOKEN is not set");
  }

  let target = parseYouTubeAlias(alias);
  let params = new URLSearchParams({
    part: "snippet",
    key: env.YOUTUBE_TOKEN,
  });
  if (target.id) params.set("id", target.id);
  else if (target.handle) params.set("forHandle", target.handle);

  let url = `https://www.googleapis.com/youtube/v3/channels?${params}`;
  let response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    await throwUpstreamError(
      "https://www.googleapis.com/youtube/v3/channels",
      response,
    );
  }

  let data = (await response.json()) as YouTubeChannelListResponse;
  let item = data.items?.[0];
  let id = item?.id;
  let snippet = item?.snippet;
  if (!id || !snippet) {
    throw new StatusError(404, `No YouTube channel for ${alias}`);
  }

  let customUrl = snippet.customUrl;
  let channelUrl = `https://www.youtube.com/channel/${id}`;
  if (customUrl) {
    channelUrl = customUrl.startsWith("http")
      ? customUrl
      : `https://www.youtube.com/${customUrl.replace(/^\//, "")}`;
  }

  let record: YouTubeSubscription = {
    id,
    name: snippet.title || target.handle || id,
    url: channelUrl,
    active: true,
  };
  let icon =
    snippet.thumbnails?.high?.url ||
    snippet.thumbnails?.medium?.url ||
    snippet.thumbnails?.default?.url;
  if (icon) record.icon = icon;
  return record;
}

/**
 * Looks up Kick or YouTube by alias, depending on `provider`.
 * Shared by add and activate/deactivate so they resolve names the same way.
 */
async function lookupByAlias(
  provider: Provider,
  alias: string,
): Promise<LookupResult> {
  if (provider === "kick") {
    return { provider, record: await lookupKick(alias) };
  }
  return { provider, record: await lookupYouTube(alias) };
}

/**
 * Writes a subscription to KV (creates or overwrites).
 * Keeps an existing Discord channel override, Kick links/mentions, and YouTube
 * WebSub lease unless the request supplies a new channel.
 */
async function upsertSubscription(
  found: LookupResult,
  channel?: string,
): Promise<Record<string, Subscription | YouTubeSubscription>> {
  if (found.provider === "kick") {
    let key = kickKey(found.record.id);
    let existing = await env.SUBSCRIPTIONS.get<Subscription>(key, {
      type: "json",
    });
    let record: Subscription = {
      id: found.record.id,
      slug: found.record.slug,
      active: true,
    };
    if (channel) record.channel = channel;
    else if (found.record.channel) record.channel = found.record.channel;
    else if (existing?.channel) record.channel = existing.channel;

    if (found.record.links) record.links = found.record.links;
    else if (existing?.links) record.links = existing.links;
    if (found.record.mentions) record.mentions = found.record.mentions;
    else if (existing?.mentions) record.mentions = existing.mentions;

    await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));
    return { [key]: record };
  }

  let key = youtubeKey(found.record.id);
  let existing = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(key, {
    type: "json",
  });
  let record: YouTubeSubscription = {
    id: found.record.id,
    name: found.record.name,
    url: found.record.url,
    active: true,
  };
  if (found.record.icon) record.icon = found.record.icon;
  if (channel) record.channel = channel;
  else if (existing?.channel) record.channel = existing.channel;
  if (existing?.lastSubscribedAt) {
    record.lastSubscribedAt = existing.lastSubscribedAt;
  }

  await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));
  return { [key]: record };
}

/**
 * Returns stored subscriptions grouped by provider (`kick` / `youtube`).
 * Pass `provider` to list only that platform.
 */
async function listSubscriptions(
  provider?: Provider,
): Promise<Record<string, Record<string, unknown>>> {
  let names = provider ? [provider] : PROVIDER_NAMES;
  let out: Record<string, Record<string, unknown>> = {};

  for (let name of names) {
    let keys = await listKeys(PROVIDERS[name].prefix);
    out[name] = Object.fromEntries(await getJsonMap(keys));
  }

  return out;
}

/**
 * Looks up the channel, upserts it as active, and (for YouTube) enqueues a
 * WebSub subscribe job so uploads start notifying Discord.
 */
async function addSubscription(
  provider: Provider,
  alias: string,
  channel?: string,
) {
  let found = await lookupByAlias(provider, alias);
  let written = await upsertSubscription(found, channel);
  if (found.provider === "youtube") {
    await env.YOUTUBE_SUBSCRIBE.send({ channelId: found.record.id });
    return {
      ...written,
      message: "YouTube WebSub job enqueued",
      channelId: found.record.id,
    };
  }
  return written;
}

/**
 * Sets `active` on an existing KV subscription (activate / deactivate).
 * Resolves the alias first; 404 if that channel is not stored yet.
 */
async function setActive(
  provider: Provider,
  alias: string,
  active: boolean,
): Promise<Record<string, Subscription | YouTubeSubscription>> {
  let found = await lookupByAlias(provider, alias);

  if (found.provider === "kick") {
    let key = kickKey(found.record.id);
    let existing = await env.SUBSCRIPTIONS.get<Subscription>(key, {
      type: "json",
    });
    if (!existing) {
      throw new StatusError(404, `No Kick subscription for ${alias}`);
    }
    let record: Subscription = { ...existing, active };
    await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));
    return { [key]: record };
  }

  let key = youtubeKey(found.record.id);
  let existing = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(key, {
    type: "json",
  });
  if (!existing) {
    throw new StatusError(404, `No YouTube subscription for ${alias}`);
  }
  let record: YouTubeSubscription = { ...existing, active };
  await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));
  return { [key]: record };
}

/** Reads the request JSON object, or 400 if the body is missing/invalid. */
async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new StatusError(400, "Invalid JSON body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new StatusError(400, "JSON body must be an object");
  }
  return body as Record<string, unknown>;
}

/**
 * Pulls `provider`, `alias`, and optional `channel` off an add/activate body.
 * Throws 400 if provider is not kick/youtube or alias is empty.
 */
function requireProviderAlias(body: Record<string, unknown>): {
  provider: Provider;
  alias: string;
  channel?: string;
} {
  let providerRaw = body.provider;
  let aliasRaw = body.alias;
  if (typeof providerRaw !== "string" || !isProvider(providerRaw)) {
    throw new StatusError(
      400,
      `provider must be one of: ${PROVIDER_NAMES.join(", ")}`,
    );
  }
  if (typeof aliasRaw !== "string" || !aliasRaw.trim()) {
    throw new StatusError(400, "alias is required");
  }
  let channel =
    typeof body.channel === "string" && body.channel.trim()
      ? body.channel.trim()
      : undefined;
  return { provider: providerRaw, alias: aliasRaw.trim(), channel };
}

/**
 * Runs before every `/admin` route. Returns 401 if the Bearer token is wrong;
 * returns nothing if auth succeeds so the matched route can run.
 */
function rejectUnauthorized(request: IRequest): Response | undefined {
  if (!authorize(request)) {
    return json({ error: "Unauthorized" }, 401);
  }
}

/**
 * Converts thrown errors into JSON for the admin CLI.
 * `StatusError` (400/404/502 from lookup/validation) keeps its status and message.
 * Anything else is logged and returned as 500 "Something went wrong".
 */
function respondWithAdminError(error: unknown): Response {
  if (error instanceof StatusError) {
    return json({ error: error.message }, error.status);
  }
  let message = error instanceof Error ? error.message : String(error);
  console.error({ message: "Admin request failed", error: message });
  return json({ error: "Something went wrong" }, 500);
}

const admin = AutoRouter<IRequest>({
  base: "/admin",
  before: [rejectUnauthorized],
  catch: respondWithAdminError,
  missing: () => json({ error: "Not found" }, 404),
});

admin.get("/subscriptions", async (request) => {
  let providerParam = request.query.provider;
  let provider: Provider | undefined;
  if (typeof providerParam === "string") {
    if (!isProvider(providerParam)) {
      throw new StatusError(
        400,
        `provider must be one of: ${PROVIDER_NAMES.join(", ")}`,
      );
    }
    provider = providerParam;
  }
  return json(await listSubscriptions(provider));
});

admin.post("/subscriptions", async (request) => {
  let { provider, alias, channel } = requireProviderAlias(
    await readJsonBody(request),
  );
  return json(await addSubscription(provider, alias, channel));
});

admin.post("/subscriptions/activate", async (request) => {
  let { provider, alias } = requireProviderAlias(await readJsonBody(request));
  return json(await setActive(provider, alias, true));
});

admin.post("/subscriptions/deactivate", async (request) => {
  let { provider, alias } = requireProviderAlias(await readJsonBody(request));
  return json(await setActive(provider, alias, false));
});

export default admin;
