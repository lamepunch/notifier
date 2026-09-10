import { Argument, Command } from "commander";

const PROVIDER_NAMES = ["kick", "youtube"] as const;
type Provider = (typeof PROVIDER_NAMES)[number];

const DEFAULT_URL = "http://localhost:8787";
const REMOTE_URL = "https://notifier.grenuttag.workers.dev";
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
  return cmd
    .option("--remote", `Use ${REMOTE_URL}`)
    .option("--url <url>", "Worker base URL", DEFAULT_URL);
}

function resolveUrl(opts: { remote?: boolean; url?: string }): string {
  if (opts.remote) return REMOTE_URL;
  return opts.url || DEFAULT_URL;
}

function adminToken(): string {
  let token = process.env.NOTIFIER_ADMIN_TOKEN;
  if (!token) {
    throw new Error(
      "NOTIFIER_ADMIN_TOKEN is not set (export it or add it to the environment)",
    );
  }
  return token;
}

async function adminFetch(
  baseUrl: string,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
): Promise<unknown> {
  let url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  let headers: Record<string, string> = {
    Authorization: `Bearer ${adminToken()}`,
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
    opts: { remote?: boolean; url?: string },
  ) => {
    let path = "/admin/subscriptions";
    if (provider && isProvider(provider)) {
      path += `?provider=${provider}`;
    }
    printJson(await adminFetch(resolveUrl(opts), path));
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
    opts: { channel?: string; remote?: boolean; url?: string },
  ) => {
    let body: Record<string, string> = { provider, alias };
    if (opts.channel) body.channel = opts.channel;
    printJson(
      await adminFetch(resolveUrl(opts), "/admin/subscriptions", {
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
    .argument("<alias>", "Kick slug or YouTube handle"),
).action(
  async (
    provider: Provider,
    alias: string,
    opts: { remote?: boolean; url?: string },
  ) => {
    printJson(
      await adminFetch(resolveUrl(opts), "/admin/subscriptions/activate", {
        method: "POST",
        body: { provider, alias },
      }),
    );
  },
);

targetFlags(
  program
    .command("deactivate")
    .description("Set a subscription inactive")
    .addArgument(providerArg())
    .argument("<alias>", "Kick slug or YouTube handle"),
).action(
  async (
    provider: Provider,
    alias: string,
    opts: { remote?: boolean; url?: string },
  ) => {
    printJson(
      await adminFetch(resolveUrl(opts), "/admin/subscriptions/deactivate", {
        method: "POST",
        body: { provider, alias },
      }),
    );
  },
);

program
  .command("test")
  .description("Send a test event to the local worker")
  .addArgument(providerArg())
  .argument("<alias>", "Kick slug or YouTube handle")
  .option("--url <url>", "Worker URL", DEFAULT_URL)
  .action(async (provider: Provider, alias: string, opts: { url: string }) => {
    console.log(`[stub] postTestEvent`, { provider, alias, url: opts.url });
  });

void program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
