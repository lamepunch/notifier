import type {
  LivestreamStatusUpdated,
  Subscription,
  YouTubeSubscriptions,
  YouTubeVideo,
} from "./types.d.ts";

import { env } from "cloudflare:workers";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // Handle WebSub subscription verification
    if (request.method === "GET") {
      return handleWebSubVerification(request);
    }

    // Only allow POST requests
    if (request.method !== "POST") {
      return new Response(null, { status: 404 });
    }

    let payload = await request.text();
    let eventType = request.headers.get("Kick-Event-Type");
    let contentType = request.headers.get("Content-Type") || "";

    // Verify webhook signature
    // TODO!

    if (eventType === "livestream.status.updated") {
      let data = JSON.parse(payload) as LivestreamStatusUpdated;

      // We only care when the stream is actually going live (not when it's ending).
      if (data.is_live) {
        try {
          ctx.waitUntil(processWebhook(data));
        } catch (error) {
          // Encountered an error, log it and return a success response
          // since we don't want Kick to stop sending us events.
          console.error(error);
        }
      }

      return new Response();
    }

    // YouTube PubSubHubbub sends Atom feed notifications
    if (contentType.includes("xml") || contentType.includes("atom")) {
      let youtubeSubscriptions = await env.SUBSCRIPTIONS.get<YouTubeSubscriptions>(
        "youtube_subscriptions",
        { type: "json" },
      );

      let videos = parseYouTubeFeed(payload);

      if (youtubeSubscriptions && youtubeSubscriptions.length > 0) {
        for (let video of videos) {
          if (
            video.published === video.updated &&
            youtubeSubscriptions.includes(video.channelId)
          ) {
            try {
              ctx.waitUntil(processYouTubeUpload(video));
            } catch (error) {
              console.error(error);
            }
          }
        }
      }

      return new Response();
    }

    return new Response();
  },

  async scheduled(controller, env, ctx): Promise<void> {
    if (!env.SERVICE_URL) {
      console.warn("SERVICE_URL is not set, skipping YouTube WebSub subscriptions");
      return;
    }

    await subscribeToYouTubeChannels(env.SERVICE_URL);
  },
} satisfies ExportedHandler<Env>;

function handleWebSubVerification(request: Request): Response {
  let url = new URL(request.url);
  let hubMode = url.searchParams.get("hub.mode");
  let hubChallenge = url.searchParams.get("hub.challenge");

  if (hubChallenge && (hubMode === "subscribe" || hubMode === "unsubscribe")) {
    return new Response(hubChallenge, {
      headers: { "Content-Type": "text/plain" },
    });
  }

  return new Response(null, { status: 404 });
}

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
  let subscription = subscriptions.find((sub) => sub.id === broadcaster.user_id);

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

async function processYouTubeUpload(video: YouTubeVideo) {
  let { videoId, title, channelName, channelId, videoUrl } = video;
  let channel = env.DISCORD_DEFAULT_CHANNEL;
  let thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  let message = {
    content: ":new: New YouTube upload!",
    embeds: [
      {
        title,
        url: videoUrl,
        description: `:arrow_right: [Watch on YouTube](${videoUrl})`,
        image: { url: thumbnailUrl },
        author: {
          name: channelName,
          url: `https://www.youtube.com/channel/${channelId}`,
        },
        color: 16711680,
      },
    ],
  };

  console.log({ message: "YouTube Discord message constructed", content: message });

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
    console.error({ message: "Discord API request failed for YouTube upload", body });
  }
}

async function subscribeToYouTubeChannels(callbackUrl: string) {
  let youtubeSubscriptions = await env.SUBSCRIPTIONS.get<YouTubeSubscriptions>(
    "youtube_subscriptions",
    { type: "json" },
  );

  if (!youtubeSubscriptions || youtubeSubscriptions.length === 0) {
    console.log("No YouTube subscriptions configured");
    return;
  }

  await Promise.all(
    youtubeSubscriptions.map((channelId) =>
      subscribeToYouTubeChannel(channelId, callbackUrl).catch((error) => {
        console.error({ message: "YouTube subscription failed", channelId, error });
      }),
    ),
  );
}

async function subscribeToYouTubeChannel(channelId: string, callbackUrl: string) {
  let params = new URLSearchParams();
  params.set("hub.mode", "subscribe");
  params.set(
    "hub.topic",
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
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

function parseYouTubeFeed(xml: string): YouTubeVideo[] {
  let videos: YouTubeVideo[] = [];
  let matches = xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g);

  for (let match of matches) {
    let entry = match[1];
    let videoId = extractTag(entry, "yt:videoId");
    let channelId = extractTag(entry, "yt:channelId");
    let title = extractTag(entry, "title");
    let channelName = extractAuthorName(entry);
    let published = extractTag(entry, "published");
    let updated = extractTag(entry, "updated");

    if (!videoId || !title || !channelId) continue;

    videos.push({
      videoId,
      title: decodeXml(title),
      channelId,
      channelName: decodeXml(channelName || "YouTube"),
      published: published || updated || "",
      updated: updated || published || "",
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  return videos;
}

function extractTag(xml: string, tag: string): string | undefined {
  let match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  return match ? match[1] : undefined;
}

function extractAuthorName(entry: string): string | undefined {
  let match = entry.match(/<author[^>]*>([\s\S]*?)<\/author>/);
  if (!match) return undefined;
  let nameMatch = match[1].match(/<name>([^<]+)<\/name>/);
  return nameMatch ? nameMatch[1] : undefined;
}

function decodeXml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCharCode(parseInt(code, 16)),
    );
}
