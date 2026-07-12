import type { YouTubeSubscriptions } from "./types.d.ts";

import { env } from "cloudflare:workers";

export async function scheduled(): Promise<void> {
  if (!env.SERVICE_URL) {
    console.warn(
      "SERVICE_URL is not set, skipping YouTube WebSub subscriptions",
    );
    return;
  }

  await subscribeToYouTubeChannels(env.SERVICE_URL);
}

async function subscribeToYouTubeChannels(callbackUrl: string) {
  let subs = await env.SUBSCRIPTIONS.get<YouTubeSubscriptions>(
    "youtube_subscriptions",
    { type: "json" },
  );

  if (!subs || subs.length === 0) {
    console.log("No YouTube subscriptions configured");
    return;
  }

  await Promise.all(
    subs.map((channelId) =>
      subscribeToYouTubeChannel(channelId, callbackUrl).catch((error) => {
        console.error({
          message: "YouTube subscription failed",
          channelId,
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
