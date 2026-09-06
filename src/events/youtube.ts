import type {
  YouTubeFeedEntry,
  YouTubeSubscription,
  YouTubeVideo,
} from "../types.d.ts";

import { env } from "cloudflare:workers";
import XMLParser from "@nodable/flexible-xml-parser";

export function handleWebSubVerification(request: Request): Response {
  let url = new URL(request.url);
  let hubMode = url.searchParams.get("hub.mode");
  let hubChallenge = url.searchParams.get("hub.challenge");
  let hubTopic = url.searchParams.get("hub.topic");
  let hubLease = url.searchParams.get("hub.lease_seconds");

  if (hubChallenge && (hubMode === "subscribe" || hubMode === "unsubscribe")) {
    console.log({
      message: "WebSub verification accepted",
      hubMode,
      hubTopic,
      hubLease,
    });
    return new Response(hubChallenge, {
      headers: { "Content-Type": "text/plain" },
    });
  }

  console.log({
    message: "GET request was not a valid WebSub verification",
    url: request.url,
  });
  return new Response(null, { status: 404 });
}

export async function processYouTubeUpload(
  video: YouTubeVideo,
  sub: YouTubeSubscription,
) {
  let { videoId, title, channelName, channelId, videoUrl } = video;
  let channel = sub.channel ?? env.DISCORD_DEFAULT_YOUTUBE_CHANNEL;
  let thumbnailUrl = `https://i3.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

  let message = {
    content: ":new: YouTube video just uploaded!",
    embeds: [
      {
        title,
        url: videoUrl,
        image: { url: thumbnailUrl },
        author: {
          name: sub.name || channelName,
          url: sub.url || `https://www.youtube.com/channel/${channelId}`,
          ...(sub.icon ? { icon_url: sub.icon } : {}),
        },
        color: 16711680,
      },
    ],
  };

  console.log({
    message: "YouTube Discord message constructed",
    content: message,
  });

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
    console.error({
      message: "Discord API request failed for YouTube upload",
      body,
    });
  }
}

export function parseYouTubeFeed(xml: string): YouTubeVideo[] {
  let parser = new XMLParser();
  let feed = parser.parse(xml) as {
    feed?: { entry?: YouTubeFeedEntry | YouTubeFeedEntry[] };
  };

  let entries = feed.feed?.entry;
  if (!entries) return [];

  let entryArray = Array.isArray(entries) ? entries : [entries];
  let videos: YouTubeVideo[] = [];

  for (let entry of entryArray) {
    let videoId = entry["yt:videoId"];
    let channelId = entry["yt:channelId"];
    let title = entry.title;
    let published = entry.published;
    let updated = entry.updated;

    if (!videoId || !title || !channelId) continue;

    let author = entry.author;
    let channelName =
      typeof author === "object" && author && "name" in author
        ? author.name
        : "YouTube";

    videos.push({
      videoId,
      title,
      channelId,
      channelName: typeof channelName === "string" ? channelName : "YouTube",
      published: published || updated || "",
      updated: updated || published || "",
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  return videos;
}
