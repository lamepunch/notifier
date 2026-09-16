#!/usr/bin/env tsx

import { Argument, Command } from "commander";

const PROVIDER_NAMES = ["kick", "youtube"] as const;
type Provider = (typeof PROVIDER_NAMES)[number];

const DEFAULT_URL = "http://localhost:8787";
const REMOTE_URL = "https://notifier.grenuttag.workers.dev";
const LOCAL_TOKEN_ENV = "NOTIFIER_ADMIN_TOKEN";
const REMOTE_TOKEN_ENV = "NOTIFIER_REMOTE_ADMIN_TOKEN";
const ERROR_BODY_PREVIEW_LENGTH = 200;

function isProvider(value: string): value is Provider {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

function providerArg(required = true) {
  let arg = new Argument(
    required ? "<provider>" : "[provider]",
    `One of: ${PROVIDER_NAMES.join(", ")}`,
  ).choices(PROVIDER_NAMES);
  if (!required) arg.argOptional();
  return arg;
}

function targetFlags(cmd: Command) {
  return cmd.option("--remote", `Use ${REMOTE_URL}`);
}

async function adminFetch(
  remote: boolean | undefined,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<unknown> {
  let baseUrl = remote ? REMOTE_URL : DEFAULT_URL;
  let tokenName = remote ? REMOTE_TOKEN_ENV : LOCAL_TOKEN_ENV;
  let token = process.env[tokenName];
  if (!token) {
    throw new Error(
      `${tokenName} is not set (export it or add it to the environment)`,
    );
  }

  let url = new URL(path, baseUrl);
  let headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  let response = await fetch(url, {
    method: init.method,
    headers,
    body,
  });
  let text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }

  if (!response.ok) {
    let detail =
      data && typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : text.slice(0, ERROR_BODY_PREVIEW_LENGTH);
    throw new Error(
      `${init.method} ${url.pathname} failed: ${response.status} ${detail}`,
    );
  }

  return data;
}

function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

const program = new Command()
  .name("admin")
  .description("Call the Worker's /admin subscription API");

targetFlags(
  program
    .command("list")
    .description("List stored subscriptions")
    .addArgument(providerArg(false)),
).action(
  async (
    provider: string | undefined,
    opts: { remote?: boolean },
  ) => {
    let path = "/admin/subscriptions";
    if (provider && isProvider(provider)) {
      path += `/${provider}`;
    }
    printJson(await adminFetch(opts.remote, path));
  },
);

targetFlags(
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
    opts: { channel?: string; remote?: boolean },
  ) => {
    let body: Record<string, string> = { alias };
    if (opts.channel) body.channel = opts.channel;
    printJson(
      await adminFetch(opts.remote, `/admin/subscriptions/${provider}`, {
        method: "POST",
        body,
      }),
    );
  },
);

targetFlags(
  program
    .command("activate")
    .description("Set a subscription active")
    .addArgument(providerArg())
    .argument("<id>", "Kick user id or YouTube channel id"),
).action(
  async (
    provider: Provider,
    id: string,
    opts: { remote?: boolean },
  ) => {
    printJson(
      await adminFetch(
        opts.remote,
        `/admin/subscriptions/${provider}/${encodeURIComponent(id)}/activate`,
        { method: "POST" },
      ),
    );
  },
);

targetFlags(
  program
    .command("deactivate")
    .description("Set a subscription inactive")
    .addArgument(providerArg())
    .argument("<id>", "Kick user id or YouTube channel id"),
).action(
  async (
    provider: Provider,
    id: string,
    opts: { remote?: boolean },
  ) => {
    printJson(
      await adminFetch(
        opts.remote,
        `/admin/subscriptions/${provider}/${encodeURIComponent(id)}/deactivate`,
        { method: "POST" },
      ),
    );
  },
);

targetFlags(
  program
    .command("resync")
    .description("Enqueue WebSub resubscribe for all active YouTube channels"),
).action(async (opts: { remote?: boolean }) => {
  printJson(
    await adminFetch(opts.remote, "/admin/subscriptions/youtube/resync", {
      method: "POST",
    }),
  );
});

targetFlags(
  program
    .command("poll")
    .description("Set YouTube polling flags on a stored subscription")
    .addArgument(providerArg())
    .argument("<id>", "YouTube channel id")
    .option("--all", "Enable backup polling for public uploads")
    .option("--members", "Set the members-only polling flag (not polled yet)")
    .option("--off", "Disable polling"),
).action(
  async (
    provider: Provider,
    id: string,
    opts: {
      all?: boolean;
      members?: boolean;
      off?: boolean;
      remote?: boolean;
    },
  ) => {
    if (provider !== "youtube") {
      throw new Error("poll is only supported for youtube");
    }

    let hasOff = !!opts.off;
    let hasAll = !!opts.all;
    let hasMembers = !!opts.members;
    let hasEnable = hasAll || hasMembers;
    if (hasOff && hasEnable) {
      throw new Error("--off cannot be combined with --all or --members");
    }
    if (!hasOff && !hasEnable) {
      throw new Error("specify --all, --members, or --off");
    }

    let body: { all?: boolean; members?: boolean };
    if (hasOff) {
      body = { all: false, members: false };
    } else {
      body = {};
      if (hasAll) body.all = true;
      if (hasMembers) body.members = true;
    }

    printJson(
      await adminFetch(
        opts.remote,
        `/admin/subscriptions/youtube/${encodeURIComponent(id)}/poll`,
        { method: "POST", body },
      ),
    );
  },
);

program
  .command("test")
  .description("Send a test event to the local worker")
  .addArgument(providerArg())
  .argument("<alias>", "Kick slug or YouTube handle")
  .action(async (provider: Provider, alias: string) => {
    console.log(`[stub] postTestEvent`, { provider, alias });
  });

void program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
