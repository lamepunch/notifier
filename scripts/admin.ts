/// <reference path="../worker-configuration.d.ts" />

import { fileURLToPath } from "node:url";

import { Argument, Command } from "commander";
import { getPlatformProxy, type GetPlatformProxyOptions } from "wrangler";

import { KICK_PREFIX, YOUTUBE_PREFIX, kickKey, youtubeKey } from "../src/kv.ts";
import type { Subscription, YouTubeSubscription } from "../src/types.d.ts";

const ADMIN_WRANGLER = fileURLToPath(
  new URL("../wrangler.admin.jsonc", import.meta.url),
);

// KV key prefixes per provider. Add a row here when introducing a new platform.
const PROVIDERS = {
  kick: { prefix: KICK_PREFIX },
  youtube: { prefix: YOUTUBE_PREFIX },
} as const;

type Provider = keyof typeof PROVIDERS;
const PROVIDER_NAMES = Object.keys(PROVIDERS) as Provider[];

const YOUTUBE_ID_RE = /^UC[\w-]{22}$/;

type KickLookup = { provider: "kick"; record: Subscription };
type YouTubeLookup = { provider: "youtube"; record: YouTubeSubscription };
type LookupResult = KickLookup | YouTubeLookup;

/**
 * Type guard so Commander string args can be treated as Provider.
 */
function isProvider(value: string): value is Provider {
  return value in PROVIDERS;
}

/**
 * Commander argument for `<provider>` / optional `[provider]`, limited to PROVIDER_NAMES.
 */
function providerArg(required = true) {
  let arg = new Argument(
    required ? "<provider>" : "[provider]",
    `One of: ${PROVIDER_NAMES.join(", ")}`,
  ).choices(PROVIDER_NAMES);
  if (!required) arg.argOptional();
  return arg;
}

/**
 * Shared `--remote` / `--env` flags for commands that talk to KV.
 */
function kvFlags(cmd: Command) {
  return cmd
    .option("--remote", "Use production KV via wrangler.admin.jsonc")
    .option("--env <name>", "Wrangler environment name");
}

/**
 * Load Worker Env via getPlatformProxy and dispose the workerd child process
 * when the command finishes. Default config matches wrangler dev local KV.
 * `--remote` switches to wrangler.admin.jsonc (SUBSCRIPTIONS has `"remote": true`).
 */
async function withEnv(
  opts: { env?: string; remote?: boolean },
  fn: (env: Env) => Promise<void>,
) {
  let options: GetPlatformProxyOptions = {
    persist: true,
    environment: opts.env || undefined,
    remoteBindings: Boolean(opts.remote),
  };
  if (opts.remote) options.configPath = ADMIN_WRANGLER;
  let { env, dispose } = await getPlatformProxy<Env>(options);
  try {
    await fn(env);
  } finally {
    await dispose();
  }
}

/**
 * Page through KV list() until every key with the given prefix is collected.
 */
async function listKeys(env: Env, prefix: string): Promise<string[]> {
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
 * Bulk-get JSON values. KV allows at most 100 keys per get() call.
 */
async function getJsonMap(
  env: Env,
  keys: string[],
): Promise<Map<string, unknown>> {
  let out = new Map<string, unknown>();
  for (let i = 0; i < keys.length; i += 100) {
    let batch = keys.slice(i, i + 100);
    let values = await env.SUBSCRIPTIONS.get(batch, { type: "json" });
    for (let [key, value] of values) {
      if (value) out.set(key, value);
    }
  }
  return out;
}

/**
 * Throw with status and a short body snippet so Cloudflare/consent walls are visible.
 */
async function httpError(url: string, response: Response): Promise<never> {
  let body = await response.text();
  throw new Error(`${url} failed: ${response.status} ${body.slice(0, 200)}`);
}

/**
 * Resolve a Kick slug via the public v2 channel endpoint. KV id is `user_id`.
 */
async function lookupKick(alias: string): Promise<Subscription> {
  let url = `https://kick.com/api/v2/channels/${encodeURIComponent(alias)}`;
  let response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) await httpError(url, response);

  let data = (await response.json()) as {
    user_id?: number;
    slug?: string;
  };
  if (typeof data.user_id !== "number") {
    throw new Error(`Kick channel ${alias} has no user_id`);
  }

  return {
    id: data.user_id,
    slug: data.slug || alias,
    active: true,
  };
}

/**
 * Parse a YouTube handle, channel URL, or UC id.
 */
function youtubeTarget(alias: string): { id?: string; handle?: string } {
  let s = alias.trim();
  if (YOUTUBE_ID_RE.test(s)) return { id: s };

  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^(www\.|m\.)?youtube\.com\//i, "");
  let channel = s.match(/^channel\/(UC[\w-]{22})/);
  if (channel) return { id: channel[1] };

  s = s.replace(/^@/, "").replace(/[/?#].*$/, "");
  if (YOUTUBE_ID_RE.test(s)) return { id: s };
  if (!s) throw new Error(`Invalid YouTube alias: ${alias}`);
  return { handle: s };
}

function attrContent(html: string, attr: string, name: string): string | undefined {
  let named = new RegExp(
    `${attr}=["']${name}["'][^>]*content=["']([^"']+)["']`,
    "i",
  );
  let contentFirst = new RegExp(
    `content=["']([^"']+)["'][^>]*${attr}=["']${name}["']`,
    "i",
  );
  return html.match(named)?.[1] || html.match(contentFirst)?.[1];
}

function youtubeChannelId(html: string): string | undefined {
  let fromMeta = attrContent(html, "itemprop", "channelId");
  if (fromMeta && YOUTUBE_ID_RE.test(fromMeta)) return fromMeta;

  let external = html.match(/"externalId"\s*:\s*"(UC[\w-]{22})"/);
  if (external) return external[1];

  let canonical = html.match(/\/channel\/(UC[\w-]{22})/);
  if (canonical) return canonical[1];
}

function stripYouTubeSuffix(title: string): string {
  return title.replace(/\s+[–-]\s+YouTube$/i, "").trim();
}

/**
 * Channel display name from the Atom feed when og:title is missing.
 */
async function youtubeFeedName(channelId: string): Promise<string | undefined> {
  let url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let response = await fetch(url);
  if (!response.ok) return;
  let rss = await response.text();
  return rss.match(/<author>\s*<name>([^<]+)<\/name>/)?.[1];
}

/**
 * Resolve a YouTube handle or UC id from the public channel page.
 */
async function lookupYouTube(alias: string): Promise<YouTubeSubscription> {
  let target = youtubeTarget(alias);
  let pageUrl = target.id
    ? `https://www.youtube.com/channel/${target.id}`
    : `https://www.youtube.com/@${target.handle}`;

  let response = await fetch(pageUrl);
  if (!response.ok) await httpError(pageUrl, response);
  let html = await response.text();

  let id = target.id || youtubeChannelId(html);
  if (!id) {
    throw new Error(
      `Could not find YouTube channel id for ${alias}: ${html.slice(0, 200)}`,
    );
  }

  let ogTitle = attrContent(html, "property", "og:title");
  let ogUrl = attrContent(html, "property", "og:url");
  let ogImage = attrContent(html, "property", "og:image");
  let name = ogTitle ? stripYouTubeSuffix(ogTitle) : await youtubeFeedName(id);
  if (!name) name = target.handle || id;

  let record: YouTubeSubscription = {
    id,
    name,
    url: ogUrl || `https://www.youtube.com/channel/${id}`,
    active: true,
  };
  if (ogImage) record.icon = ogImage;
  return record;
}

/**
 * Resolve a human alias (Kick slug / YouTube handle) to platform ids and metadata.
 */
async function lookup(
  provider: Provider,
  alias: string,
): Promise<LookupResult> {
  if (provider === "kick") {
    return { provider, record: await lookupKick(alias) };
  }
  return { provider, record: await lookupYouTube(alias) };
}

/**
 * Write a subscription record to SUBSCRIPTIONS. Lookup should already have run.
 * Upserts identity fields, sets active, and keeps existing Kick links/mentions.
 */
async function put(
  env: Env,
  found: LookupResult,
  channel?: string,
) {
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
    else if (existing?.channel) record.channel = existing.channel;

    if (existing?.links) record.links = existing.links;
    if (existing?.mentions) record.mentions = existing.mentions;

    await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));
    console.log(JSON.stringify({ [key]: record }, null, 2));
    return;
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

  await env.SUBSCRIPTIONS.put(key, JSON.stringify(record));
  console.log(JSON.stringify({ [key]: record }, null, 2));
}

/**
 * Flip `active` on an existing subscription without deleting the KV key.
 */
async function setActive(
  _env: Env,
  provider: Provider,
  alias: string,
  active: boolean,
) {
  console.log("[stub] setActive", { provider, alias, active });
}

/**
 * Print stored subscription JSON, optionally for a single provider.
 */
async function listSubscriptions(env: Env, provider?: Provider) {
  let names = provider ? [provider] : PROVIDER_NAMES;
  let out: Record<string, Record<string, unknown>> = {};

  for (let name of names) {
    let keys = await listKeys(env, PROVIDERS[name].prefix);
    out[name] = Object.fromEntries(await getJsonMap(env, keys));
  }

  console.log(JSON.stringify(out, null, 2));
}

/**
 * Look up the channel by alias and upsert the KV record as active.
 * YouTube adds also enqueue a WebSub subscribe job.
 */
async function add(
  env: Env,
  provider: Provider,
  alias: string,
  channel?: string,
) {
  let found = await lookup(provider, alias);
  await put(env, found, channel);
  if (found.provider === "youtube") {
    await env.YOUTUBE_SUBSCRIBE.send({ channelId: found.record.id });
    console.log({
      message: "YouTube WebSub job enqueued",
      channelId: found.record.id,
    });
  }
}

/**
 * POST a fake Kick/YouTube webhook at the local worker (wrangler dev).
 */
async function postTestEvent(provider: Provider, alias: string, url: string) {
  console.log(`[stub] postTestEvent`, { provider, alias, url });
}

const program = new Command()
  .name("admin")
  .description("Administer subscriptions in KV and send local test events");

kvFlags(
  program
    .command("list")
    .description("List stored subscriptions")
    .addArgument(providerArg(false)),
).action(
  async (
    provider: string | undefined,
    opts: { remote?: boolean; env?: string },
  ) => {
    let filter = provider && isProvider(provider) ? provider : undefined;
    await withEnv(opts, (env) => listSubscriptions(env, filter));
  },
);

kvFlags(
  program
    .command("add")
    .description("Add or upsert a subscription")
    .addArgument(providerArg())
    .argument("<alias>", "Kick slug or YouTube handle")
    .option("-c, --channel <discordId>", "Discord channel id override"),
).action(
  async (
    provider: Provider,
    alias: string,
    opts: { channel?: string; remote?: boolean; env?: string },
  ) => {
    await withEnv(opts, (env) => add(env, provider, alias, opts.channel));
  },
);

kvFlags(
  program
    .command("activate")
    .description("Set a subscription active")
    .addArgument(providerArg())
    .argument("<alias>", "Kick slug or YouTube handle"),
).action(
  async (
    provider: Provider,
    alias: string,
    opts: { remote?: boolean; env?: string },
  ) => {
    await withEnv(opts, (env) => setActive(env, provider, alias, true));
  },
);

kvFlags(
  program
    .command("deactivate")
    .description("Set a subscription inactive")
    .addArgument(providerArg())
    .argument("<alias>", "Kick slug or YouTube handle"),
).action(
  async (
    provider: Provider,
    alias: string,
    opts: { remote?: boolean; env?: string },
  ) => {
    await withEnv(opts, (env) => setActive(env, provider, alias, false));
  },
);

program
  .command("test")
  .description("Send a test event to the local worker")
  .addArgument(providerArg())
  .argument("<alias>", "Kick slug or YouTube handle")
  .option("--url <url>", "Worker URL", "http://localhost:8787")
  .action(async (provider: Provider, alias: string, opts: { url: string }) => {
    await lookup(provider, alias);
    await postTestEvent(provider, alias, opts.url);
  });

void program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
