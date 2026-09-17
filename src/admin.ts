import { AutoRouter, StatusError, type IRequest } from "itty-router";
import { env } from "cloudflare:workers";
import * as v from "valibot";

import type {
  KickChannelResponse,
  LookupResult,
  Provider,
  Subscription,
  YouTubeChannelListResponse,
  YouTubeTarget,
} from "./types.d.ts";

import { setPollingFlags } from "./events/youtube/state";
import { KickSubscription, YouTubeSubscription } from "./subscriptions";
import { enqueueYouTubeSubscriptions } from "./events/youtube/subscribing";

const PROVIDERS = {
  kick: KickSubscription,
  youtube: YouTubeSubscription,
} as const;

const PROVIDER_NAMES = Object.keys(PROVIDERS) as Provider[];

const YOUTUBE_ID_RE = /^UC[\w-]{22}$/;
const ERROR_BODY_PREVIEW_LENGTH = 200;

const addSubscriptionBody = v.object({
  alias: v.pipe(v.string(), v.trim(), v.minLength(1)),
  channel: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
});

const pollSubscriptionBody = v.object({
  all: v.optional(v.boolean()),
  members: v.optional(v.boolean()),
});

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
 * Keeps an existing Discord channel override, Kick links/mentions, YouTube
 * WebSub lease, and polling flags unless the request supplies a new channel.
 */
async function upsertSubscription(
  found: LookupResult,
  channel?: string,
): Promise<Record<string, Subscription | YouTubeSubscription>> {
  if (found.provider === "kick") {
    let key = KickSubscription.key(found.record.id);
    let existing = await KickSubscription.get(found.record.id);
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

    await KickSubscription.save(record);
    return { [key]: record };
  }

  let key = YouTubeSubscription.key(found.record.id);
  let existing = await YouTubeSubscription.get(found.record.id);
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
  if (existing?.lastVerifiedAt) {
    record.lastVerifiedAt = existing.lastVerifiedAt;
  }
  if (existing?.polling) {
    record.polling = existing.polling;
  }

  await YouTubeSubscription.save(record);
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
    out[name] = Object.fromEntries(
      name === "kick"
        ? (await KickSubscription.list()).map((record) => [KickSubscription.key(record.id), record])
        : (await YouTubeSubscription.list()).map((record) => [YouTubeSubscription.key(record.id), record]),
    );
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
 * `:id` is the stored Kick user id or YouTube channel id; 404 if missing.
 */
async function setActive(
  provider: Provider,
  id: string,
  active: boolean,
): Promise<Record<string, Subscription | YouTubeSubscription>> {
  if (provider === "kick") {
    let userId = Number(id);
    let isKickUserId = Number.isInteger(userId);
    if (!isKickUserId) {
      throw new StatusError(400, "id must be a Kick user id");
    }
    let key = KickSubscription.key(userId);
    let existing = await KickSubscription.get(userId);
    if (!existing) {
      throw new StatusError(404, `No Kick subscription for ${id}`);
    }
    let record: Subscription = { ...existing, active };
    await KickSubscription.save(record);
    return { [key]: record };
  }

  let isYouTubeChannelId = YOUTUBE_ID_RE.test(id);
  if (!isYouTubeChannelId) {
    throw new StatusError(400, "id must be a YouTube channel id");
  }
  let key = YouTubeSubscription.key(id);
  let existing = await YouTubeSubscription.get(id);
  if (!existing) {
    throw new StatusError(404, `No YouTube subscription for ${id}`);
  }
  let record: YouTubeSubscription = { ...existing, active };
  await YouTubeSubscription.save(record);
  return { [key]: record };
}

/**
 * Merges `all` / `members` into the stored YouTube `polling` object.
 * Omits `polling` when both flags are false. Setting `all` true enqueues a poll job.
 */
async function setYouTubePolling(
  id: string,
  patch: { all?: boolean; members?: boolean },
): Promise<Record<string, YouTubeSubscription>> {
  let isYouTubeChannelId = YOUTUBE_ID_RE.test(id);
  if (!isYouTubeChannelId) {
    throw new StatusError(400, "id must be a YouTube channel id");
  }

  let hasAll = patch.all !== undefined;
  let hasMembers = patch.members !== undefined;
  if (!hasAll && !hasMembers) {
    throw new StatusError(400, "all or members is required");
  }

  let key = YouTubeSubscription.key(id);
  let existing = await YouTubeSubscription.get(id);
  if (!existing) {
    throw new StatusError(404, `No YouTube subscription for ${id}`);
  }

  let all = patch.all ?? existing.polling?.all ?? false;
  let members = patch.members ?? existing.polling?.members ?? false;
  let record: YouTubeSubscription = { ...existing };
  setPollingFlags(record, all, members);
  await YouTubeSubscription.save(record);

  let shouldEnqueue = record.polling?.all === true;
  if (shouldEnqueue) {
    await env.YOUTUBE_POLL.send({ channelId: id });
  }

  return { [key]: record };
}

/** Parses JSON with `schema`, or 400 if the body is missing/invalid. */
async function parseJsonBody<TSchema extends v.GenericSchema>(
  request: Request,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new StatusError(400, "Invalid JSON body");
  }
  let parsed = v.safeParse(schema, body);
  if (!parsed.success) {
    throw new StatusError(400, parsed.issues[0].message);
  }
  return parsed.output;
}

/** Reads `:provider` from the URL. Throws 400 unless it is kick or youtube. */
function requireProvider(request: IRequest): Provider {
  let providerRaw = request.params.provider;
  if (typeof providerRaw !== "string" || !isProvider(providerRaw)) {
    throw new StatusError(
      400,
      `provider must be one of: ${PROVIDER_NAMES.join(", ")}`,
    );
  }
  return providerRaw;
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

const admin = AutoRouter({
  base: "/admin",
  before: [rejectUnauthorized],
  catch: respondWithAdminError,
  missing: () => json({ error: "Not found" }, 404),
});

admin.get("/subscriptions", async () => {
  return json(await listSubscriptions());
});

admin.get("/subscriptions/:provider", async (request) => {
  return json(await listSubscriptions(requireProvider(request)));
});

admin.post("/subscriptions/youtube/resync", async () => {
  if (!env.SERVICE_URL) {
    throw new StatusError(500, "SERVICE_URL is not set");
  }
  let result = await enqueueYouTubeSubscriptions(true);
  return json({
    message: "YouTube WebSub jobs enqueued",
    ...result,
  });
});

admin.post("/subscriptions/youtube/:id/poll", async (request) => {
  let { all, members } = await parseJsonBody(request, pollSubscriptionBody);
  return json(await setYouTubePolling(request.params.id, { all, members }));
});

admin.post("/subscriptions/:provider", async (request) => {
  let { alias, channel } = await parseJsonBody(request, addSubscriptionBody);
  return json(await addSubscription(requireProvider(request), alias, channel));
});

admin.post("/subscriptions/:provider/:id/activate", async (request) => {
  return json(
    await setActive(requireProvider(request), request.params.id, true),
  );
});

admin.post("/subscriptions/:provider/:id/deactivate", async (request) => {
  return json(
    await setActive(requireProvider(request), request.params.id, false),
  );
});

export default admin;
