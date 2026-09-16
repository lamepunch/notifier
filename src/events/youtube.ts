import XMLParser from "@nodable/flexible-xml-parser";
import { env } from "cloudflare:workers";
import * as v from "valibot";

import type {
  YouTubeFeed,
  YouTubeSubscription,
  YouTubeVideo,
} from "../types.d.ts";

import { DISCORD_API_BASE } from "../constants";
import { youtubeKey } from "../kv";

const YOUTUBE_EMBED_COLOR = 16_711_680;

const webSubVerification = v.variant("hub.mode", [
  v.object({
    "hub.mode": v.literal("subscribe"),
    "hub.topic": v.pipe(v.string(), v.url()),
    "hub.challenge": v.pipe(v.string(), v.minLength(1)),
    "hub.lease_seconds": v.pipe(v.string(), v.digits()),
  }),
  v.object({
    "hub.mode": v.literal("unsubscribe"),
    "hub.topic": v.pipe(v.string(), v.url()),
    "hub.challenge": v.pipe(v.string(), v.minLength(1)),
    "hub.lease_seconds": v.optional(v.pipe(v.string(), v.digits())),
  }),
]);

function channelIdFromTopic(topic: string): string | undefined {
  return new URL(topic).searchParams.get("channel_id") ?? undefined;
}

export async function handleWebSubVerification(
  request: Request,
): Promise<Response> {
  let url = new URL(request.url);
  let parsed = v.safeParse(
    webSubVerification,
    Object.fromEntries(url.searchParams),
  );

  if (parsed.success) {
    let channelId = channelIdFromTopic(parsed.output["hub.topic"]);
    if (channelId) {
      let hubMode = parsed.output["hub.mode"];
      let hubChallenge = parsed.output["hub.challenge"];
      let hubTopic = parsed.output["hub.topic"];
      let hubLease = parsed.output["hub.lease_seconds"];
      let sub = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(
        youtubeKey(channelId),
        { type: "json" },
      );
      let isKnown = !!sub;
      let isSubscribe = hubMode === "subscribe";
      let isUnsubscribe = hubMode === "unsubscribe";
      let isAccepted =
        (isSubscribe && isKnown) || (isUnsubscribe && !isKnown);

      if (isAccepted) {
        if (isSubscribe && sub) {
          sub.lastVerifiedAt = new Date().toISOString();
          await env.SUBSCRIPTIONS.put(youtubeKey(channelId), JSON.stringify(sub));
        }

        console.log({
          message: "WebSub verification accepted",
          hubMode,
          hubTopic,
          hubLease,
          channelId,
        });
        return new Response(hubChallenge, {
          headers: { "Content-Type": "text/plain" },
        });
      } else {
        console.log({
          message: "WebSub verification rejected",
          url: request.url,
          hubMode,
          hubTopic,
          hubLease,
          channelId,
          isKnown,
        });
        return new Response(null, { status: 404 });
      }
    } else {
      console.log({
        message: "GET request was not a valid WebSub verification",
        url: request.url,
      });
      return new Response(null, { status: 404 });
    }
  } else {
    console.log({
      message: "GET request was not a valid WebSub verification",
      url: request.url,
    });
    return new Response(null, { status: 404 });
  }
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
        color: YOUTUBE_EMBED_COLOR,
      },
    ],
  };

  console.log({
    message: "YouTube Discord message constructed",
    content: message,
  });

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
    console.error({
      message: "Discord API request failed for YouTube upload",
      body,
    });
  }
}

export function parseYouTubeFeed(xml: string): YouTubeVideo[] {
  let parser = new XMLParser();
  let feed = parser.parse(xml) as YouTubeFeed;

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
