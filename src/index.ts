import type { LivestreamStatusUpdated, Subscription } from "./types.d.ts";

import { env } from "cloudflare:workers";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // Only allow POST requests
    if (request.method !== "POST") {
      return new Response(null, { status: 404 });
    }

    let payload = await request.text();

    // Verify webhook signature
    // TODO!

    let data = JSON.parse(payload) as LivestreamStatusUpdated;

    // We only care about one event type for this worker, and only when
    // the stream is actually going live (not when it's ending).
    let eventType = request.headers.get("Kick-Event-Type");
    if (eventType == "livestream.status.updated" && data.is_live) {
      // Process webhook
      try {
        ctx.waitUntil(processWebhook(data));
      } catch (error) {
        // Encountered an error, log it and return a success response
        // since we don't want Kick to stop sending us events.
        console.error(error);
        return new Response();
      }
    }

    return new Response();
  },
} satisfies ExportedHandler<Env>;

async function processWebhook(data: LivestreamStatusUpdated) {
  let { broadcaster, title } = data;

  // Construct URL from slug
  var url = `https://kick.com/${broadcaster.channel_slug}`;

  // Fetch subscriptions fresh from KV on every request
  let subscriptions = await env.SUBSCRIPTIONS.get<Subscription[]>(
    "subscriptions",
    { type: "json" },
  );

  if (!subscriptions) {
    throw new Error("subscriptions key missing from KV");
  }

  // Find matching subscription based on the broadcaster's user_id
  let subscription = subscriptions.find(
    (sub) => sub.id === broadcaster.user_id,
  );

  // Die if we can't find a subscription
  if (!subscription) {
    throw new Error("No valid subscription found");
  }

  let { channel, links, mentions } = subscription;

  // If no channel is provided then use fallback value
  if (!channel) {
    channel = env.DISCORD_DEFAULT_CHANNEL;
  }

  let description = `:link: [Kick](${url})`;
  if (links) {
    description +=
      " · " +
      Object.entries(links)
        .map(
          ([name, link]) =>
            `[${name[0].toUpperCase() + name.slice(1)}](${link})`,
        )
        .join(" · ");
  }

  let content = ":red_circle: Stream has gone live!";
  if (mentions) {
    content = mentions.map((id) => `<@${id}>`).join(" ") + " " + content;
  }

  let message = {
    content,
    embeds: [
      {
        title: `:arrow_right: ${title}`,
        description,
        author: {
          name: broadcaster.username,
          icon_url: broadcaster.profile_picture,
        },
        color: "1752220",
      },
    ],
  };

  console.log({ message: "Discord message constructed", content: message });

  // Send message to Discord channel
  let response = await fetch(
    `https://discord.com/api/v10/channels/${channel}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    console.error({ message: "Discord API request failed", body });
  }
}
