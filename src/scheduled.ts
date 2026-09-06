import type { YouTubeSubscription } from "./types.d.ts";

import { env } from "cloudflare:workers";
import { YOUTUBE_PREFIX } from "./kv";

export async function scheduled(): Promise<void> {
  if (!env.SERVICE_URL) {
    console.warn(
      "SERVICE_URL is not set, skipping YouTube WebSub subscriptions",
    );
    return;
  }

  await subscribeToYouTubeChannels(env.SERVICE_URL);
}

async function listYouTubeKeys(): Promise<string[]> {
  let keys: string[] = [];
  let cursor: string | undefined;

  do {
    let page = await env.SUBSCRIPTIONS.list({
      prefix: YOUTUBE_PREFIX,
      cursor,
    });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return keys;
}

async function loadYouTubeSubscriptions(
  keys: string[],
): Promise<YouTubeSubscription[]> {
  let subs: YouTubeSubscription[] = [];

  // ponytail: KV bulk get is capped at 100 keys per call
  for (let i = 0; i < keys.length; i += 100) {
    let batch = keys.slice(i, i + 100);
    let values = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(batch, {
      type: "json",
    });
    for (let value of values.values()) {
      if (value) subs.push(value);
    }
  }

  return subs;
}

async function subscribeToYouTubeChannels(callbackUrl: string) {
  let keys = await listYouTubeKeys();
  let subs = (await loadYouTubeSubscriptions(keys)).filter((sub) => sub.active);

  if (subs.length === 0) {
    console.log("No active YouTube subscriptions configured");
    return;
  }

  await Promise.all(
    subs.map((sub) =>
      subscribeToYouTubeChannel(sub.id, callbackUrl).catch((error) => {
        console.error({
          message: "YouTube subscription failed",
          channelId: sub.id,
          error,
        });
      }),
    ),
  );
}

async function subscribeToYouTubeChannel(
  channelId: string,
  callbackUrl: string,
) {
  let params = new URLSearchParams();
  params.set("hub.mode", "subscribe");
  params.set(
    "hub.topic",
    // Must be the /xml/ variant: the hub accepts the plain feed URL as a
    // topic but YouTube never publishes events to it.
    `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`,
  );
  params.set("hub.callback", callbackUrl);
  params.set("hub.lease_seconds", "432000");
  params.set("hub.verify", "async");

  let response = await fetch("https://pubsubhubbub.appspot.com/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error({
      message: "YouTube WebSub subscription failed",
      status: response.status,
      body,
      channelId,
    });
    return;
  }

  console.log({ message: "YouTube WebSub subscription requested", channelId });
}
