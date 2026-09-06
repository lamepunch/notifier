import type { LivestreamStatusUpdated, Subscription } from "../types.d.ts";

import { env } from "cloudflare:workers";
import { kickKey } from "../kv";

export async function processWebhook(data: LivestreamStatusUpdated) {
  let { broadcaster, title } = data;

  // Construct URL from slug
  var url = `https://kick.com/${broadcaster.channel_slug}`;

  // Fetch subscriptions fresh from KV on every request
  let sub = await env.SUBSCRIPTIONS.get<Subscription>(
    kickKey(broadcaster.user_id),
    { type: "json" },
  );

  // Die if we can't find a subscription
  if (!sub || !sub.active) {
    console.log({
      message: "Kick subscription missing or inactive",
      userId: broadcaster.user_id,
      slug: broadcaster.channel_slug,
      active: sub?.active ?? false,
    });
    return;
  }

  let { channel, links, mentions } = sub;

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
