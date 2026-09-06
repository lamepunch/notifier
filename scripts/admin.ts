import { Command } from "commander";

type Platform = "kick" | "youtube";

function remoteFlag(cmd: Command) {
  return cmd.option(
    "--remote",
    "target production KV (reserved; not used by stubs)",
  );
}

function channelOption(cmd: Command) {
  return cmd.option(
    "-c, --channel <discordId>",
    "Discord channel id override",
  );
}

async function lookupKick(slug: string) {
  console.log(`[stub] lookupKick(${JSON.stringify(slug)})`);
}

async function lookupYouTube(handle: string) {
  console.log(`[stub] lookupYouTube(${JSON.stringify(handle)})`);
}

async function putKick(slug: string, channel?: string) {
  console.log("[stub] putKick", { slug, channel, active: true });
}

async function putYouTube(handle: string, channel?: string) {
  console.log("[stub] putYouTube", { handle, channel, active: true });
}

async function setActive(platform: Platform, alias: string, active: boolean) {
  console.log("[stub] setActive", { platform, alias, active });
}

async function listSubscriptions(opts: { remote?: boolean }) {
  console.log("[stub] listSubscriptions", opts);
}

async function addKick(slug: string, opts: { channel?: string; remote?: boolean }) {
  await lookupKick(slug);
  await putKick(slug, opts.channel);
}

async function addYouTube(
  handle: string,
  opts: { channel?: string; remote?: boolean },
) {
  await lookupYouTube(handle);
  await putYouTube(handle, opts.channel);
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

remoteFlag(program.command("list").description("List stored subscriptions")).action(
  async (opts: { remote?: boolean }) => {
    await listSubscriptions(opts);
  },
);

const add = program.command("add").description("Add or upsert a subscription");
channelOption(
  remoteFlag(
    add
      .command("kick")
      .description("Add a Kick channel by slug")
      .argument("<slug>", "Kick channel slug"),
  ),
).action(
  async (
    slug: string,
    opts: { channel?: string; remote?: boolean },
  ) => {
    await addKick(slug, opts);
  },
);
channelOption(
  remoteFlag(
    add
      .command("youtube")
      .description("Add a YouTube channel by handle")
      .argument("<handle>", "YouTube handle, with or without @"),
  ),
).action(
  async (
    handle: string,
    opts: { channel?: string; remote?: boolean },
  ) => {
    await addYouTube(handle, opts);
  },
);

const activate = program
  .command("activate")
  .description("Set a subscription active");
remoteFlag(
  activate
    .command("kick")
    .description("Activate a Kick subscription")
    .argument("<slug>", "Kick channel slug"),
).action(async (slug: string) => {
  await setActive("kick", slug, true);
});
remoteFlag(
  activate
    .command("youtube")
    .description("Activate a YouTube subscription")
    .argument("<handle>", "YouTube handle, with or without @"),
).action(async (handle: string) => {
  await setActive("youtube", handle, true);
});

const deactivate = program
  .command("deactivate")
  .description("Set a subscription inactive");
remoteFlag(
  deactivate
    .command("kick")
    .description("Deactivate a Kick subscription")
    .argument("<slug>", "Kick channel slug"),
).action(async (slug: string) => {
  await setActive("kick", slug, false);
});
remoteFlag(
  deactivate
    .command("youtube")
    .description("Deactivate a YouTube subscription")
    .argument("<handle>", "YouTube handle, with or without @"),
).action(async (handle: string) => {
  await setActive("youtube", handle, false);
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
