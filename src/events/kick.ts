import { env } from "cloudflare:workers";

import type { LivestreamStatusUpdated, Subscription } from "../types.d.ts";

import { DISCORD_API_BASE } from "../constants";
import { kickKey } from "../kv";

const KICK_EMBED_COLOR = 1_752_220;

export default async function processWebhook(data: LivestreamStatusUpdated) {
  let { broadcaster, title } = data;
  let url = `https://kick.com/${broadcaster.channel_slug}`;
  let sub = await env.SUBSCRIPTIONS.get<Subscription>(
    kickKey(broadcaster.user_id),
    { type: "json" },
  );

  if (sub?.active) {
    let { channel, links, mentions } = sub;

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
          color: KICK_EMBED_COLOR,
        },
      ],
    };

    console.log({ message: "Discord message constructed", content: message });

    let response = await fetch(
      `${DISCORD_API_BASE}/channels/${channel}/messages`,
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
      let body = await response.text();
      console.error({ message: "Discord API request failed", body });
    }
  } else {
    console.log({
      message: "Kick subscription missing or inactive",
      userId: broadcaster.user_id,
      slug: broadcaster.channel_slug,
      active: sub?.active ?? false,
    });
  }
}
