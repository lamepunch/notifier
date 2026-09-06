/// <reference path="../worker-configuration.d.ts" />

import { Command } from "commander";
import { getPlatformProxy } from "wrangler";

import { KICK_PREFIX, YOUTUBE_PREFIX } from "../src/kv.ts";
import type { Subscription, YouTubeSubscription } from "../src/types.d.ts";

type Platform = "kick" | "youtube";

function kvFlags(cmd: Command) {
  return cmd
    .option("--remote", "Enable remote bindings from wrangler.jsonc")
    .option(
      "--env <name>",
      'Wrangler environment (omit for production, same as --env="")',
    );
}

function channelOption(cmd: Command) {
  return cmd.option(
    "-c, --channel <discordId>",
    "Discord channel id override",
  );
}

async function withEnv(
  opts: { env?: string; remote?: boolean },
  fn: (env: Env) => Promise<void>,
) {
  let { env, dispose } = await getPlatformProxy<Env>({
    persist: true,
    environment: opts.env || undefined,
    remoteBindings: Boolean(opts.remote),
  });
  try {
    await fn(env);
  } finally {
    await dispose();
  }
}

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

async function getJsonMap<T>(env: Env, keys: string[]): Promise<Map<string, T>> {
  let out = new Map<string, T>();
  for (let i = 0; i < keys.length; i += 100) {
    let batch = keys.slice(i, i + 100);
    let values = await env.SUBSCRIPTIONS.get<T>(batch, { type: "json" });
    for (let [key, value] of values) {
      if (value) out.set(key, value);
    }
  }
  return out;
}

async function lookupKick(slug: string) {
  console.log(`[stub] lookupKick(${JSON.stringify(slug)})`);
}

async function lookupYouTube(handle: string) {
  console.log(`[stub] lookupYouTube(${JSON.stringify(handle)})`);
}

async function putKick(_env: Env, slug: string, channel?: string) {
  console.log("[stub] putKick", { slug, channel, active: true });
}

async function putYouTube(_env: Env, handle: string, channel?: string) {
  console.log("[stub] putYouTube", { handle, channel, active: true });
}

async function setActive(
  _env: Env,
  platform: Platform,
  alias: string,
  active: boolean,
) {
  console.log("[stub] setActive", { platform, alias, active });
}

async function listSubscriptions(env: Env) {
  let kickKeys = await listKeys(env, KICK_PREFIX);
  let youtubeKeys = await listKeys(env, YOUTUBE_PREFIX);

  let kick = Object.fromEntries(
    await getJsonMap<Subscription>(env, kickKeys),
  );
  let youtube = Object.fromEntries(
    await getJsonMap<YouTubeSubscription>(env, youtubeKeys),
  );

  console.log(JSON.stringify({ kick, youtube }, null, 2));
}

async function addKick(
  env: Env,
  slug: string,
  opts: { channel?: string },
) {
  await lookupKick(slug);
  await putKick(env, slug, opts.channel);
}

async function addYouTube(
  env: Env,
  handle: string,
  opts: { channel?: string },
) {
  await lookupYouTube(handle);
  await putYouTube(env, handle, opts.channel);
}

async function postKickEvent(slug: string) {
  console.log(`[stub] postKickEvent(${JSON.stringify(slug)})`);
}

async function postYouTubeEvent(handle: string) {
  console.log(`[stub] postYouTubeEvent(${JSON.stringify(handle)})`);
}

const program = new Command()
  .name("admin")
  .description(
    "Administer Kick/YouTube subscriptions in KV and send local test events",
  );

kvFlags(program.command("list").description("List stored subscriptions")).action(
  async (opts: { remote?: boolean; env?: string }) => {
    await withEnv(opts, listSubscriptions);
  },
);

const add = program.command("add").description("Add or upsert a subscription");
channelOption(
  kvFlags(
    add
      .command("kick")
      .description("Add a Kick channel by slug")
      .argument("<slug>", "Kick channel slug"),
  ),
).action(
  async (
    slug: string,
    opts: { channel?: string; remote?: boolean; env?: string },
  ) => {
    await withEnv(opts, (env) => addKick(env, slug, opts));
  },
);
channelOption(
  kvFlags(
    add
      .command("youtube")
      .description("Add a YouTube channel by handle")
      .argument("<handle>", "YouTube handle, with or without @"),
  ),
).action(
  async (
    handle: string,
    opts: { channel?: string; remote?: boolean; env?: string },
  ) => {
    await withEnv(opts, (env) => addYouTube(env, handle, opts));
  },
);

const activate = program
  .command("activate")
  .description("Set a subscription active");
kvFlags(
  activate
    .command("kick")
    .description("Activate a Kick subscription")
    .argument("<slug>", "Kick channel slug"),
).action(async (slug: string, opts: { remote?: boolean; env?: string }) => {
  await withEnv(opts, (env) => setActive(env, "kick", slug, true));
});
kvFlags(
  activate
    .command("youtube")
    .description("Activate a YouTube subscription")
    .argument("<handle>", "YouTube handle, with or without @"),
).action(async (handle: string, opts: { remote?: boolean; env?: string }) => {
  await withEnv(opts, (env) => setActive(env, "youtube", handle, true));
});

const deactivate = program
  .command("deactivate")
  .description("Set a subscription inactive");
kvFlags(
  deactivate
    .command("kick")
    .description("Deactivate a Kick subscription")
    .argument("<slug>", "Kick channel slug"),
).action(async (slug: string, opts: { remote?: boolean; env?: string }) => {
  await withEnv(opts, (env) => setActive(env, "kick", slug, false));
});
kvFlags(
  deactivate
    .command("youtube")
    .description("Deactivate a YouTube subscription")
    .argument("<handle>", "YouTube handle, with or without @"),
).action(async (handle: string, opts: { remote?: boolean; env?: string }) => {
  await withEnv(opts, (env) => setActive(env, "youtube", handle, false));
});

const test = program
  .command("test")
  .description("Send a test event to the local worker");
test
  .command("kick")
  .description("POST a Kick livestream.status.updated event")
  .argument("<slug>", "Kick channel slug")
  .option("--url <url>", "Worker URL", "http://localhost:8787")
  .action(async (slug: string) => {
    await lookupKick(slug);
    await postKickEvent(slug);
  });
test
  .command("youtube")
  .description("POST a YouTube Atom/WebSub ping")
  .argument("<handle>", "YouTube handle, with or without @")
  .option("--url <url>", "Worker URL", "http://localhost:8787")
  .action(async (handle: string) => {
    await lookupYouTube(handle);
    await postYouTubeEvent(handle);
  });

void program.parseAsync();
