import XMLParser from "@nodable/flexible-xml-parser";
import { env } from "cloudflare:workers";
import * as v from "valibot";

import type {
  YouTubeFeed,
  YouTubePlaylistItem,
  YouTubePlaylistItemsResponse,
  YouTubePolling,
  YouTubeSubscription,
  YouTubeVideo,
} from "../types.d.ts";

import { DISCORD_API_BASE } from "../constants";
import { youtubeKey, youtubeVideoSentKey } from "../kv";

const YOUTUBE_EMBED_COLOR = 16_711_680;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1_000;
const VIDEO_SENT_TTL_IN_S = 7 * 24 * 60 * 60;
const PLAYLIST_MAX_RESULTS = 10;
const YOUTUBE_PLAYLIST_ITEMS_URL =
  "https://www.googleapis.com/youtube/v3/playlistItems";

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

  if (!parsed.success) {
    console.log({
      message: "GET request was not a valid WebSub verification",
      url: request.url,
    });
    return new Response(null, { status: 404 });
  }

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
}

/** `{ all, members }` when either flag is on; omitted from KV when both are false. */
function pollingFlags(
  all: boolean,
  members: boolean,
): YouTubePolling | undefined {
  if (!all && !members) return undefined;
  return { all, members };
}

export function setPollingFlags(
  sub: YouTubeSubscription,
  all: boolean,
  members: boolean,
): void {
  let polling = pollingFlags(all, members);
  if (polling) {
    sub.polling = polling;
  } else {
    delete sub.polling;
  }
}

export async function notifyIfNewYouTubeVideo(
  video: YouTubeVideo,
  ctx: ExecutionContext,
  fromHub = false,
): Promise<void> {
  let sub = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(
    youtubeKey(video.channelId),
    { type: "json" },
  );

  let isSubscribed: boolean = !!sub?.active;
  // Pings also fire for edits of old videos and are retried by the
  // hub, so "new upload" means: published recently AND not already
  // sent (tracked in KV).
  let publishedAt = new Date(video.published).getTime();
  let isRecent: boolean = Date.now() - publishedAt < ONE_DAY_IN_MS;
  let sentKey = youtubeVideoSentKey(video.videoId);
  let hasAlreadySent: boolean =
    isSubscribed && isRecent
      ? (await env.SUBSCRIPTIONS.get(sentKey)) !== null
      : false;
  let isAccepted: boolean = isSubscribed && isRecent && !hasAlreadySent;

  console.log({
    message: isAccepted
      ? "Video accepted, sending notification"
      : "Video skipped",
    videoId: video.videoId,
    channelId: video.channelId,
    published: video.published,
    updated: video.updated,
    isSubscribed,
    isRecent,
    hasAlreadySent,
  });

  if (isAccepted && sub) {
    // ponytail: KV is eventually consistent, so pings landing in
    // different colos within ~60s could double-send; a Durable
    // Object would make this exactly-once if that ever matters.
    await env.SUBSCRIPTIONS.put(sentKey, video.published, {
      expirationTtl: VIDEO_SENT_TTL_IN_S,
    });
    let shouldClearPolling = fromHub && sub.polling?.all === true;
    if (shouldClearPolling) {
      let members = sub.polling?.members ?? false;
      setPollingFlags(sub, false, members);
      await env.SUBSCRIPTIONS.put(
        youtubeKey(video.channelId),
        JSON.stringify(sub),
      );
      console.log({
        message: "Cleared YouTube polling after hub notification sent",
        channelId: video.channelId,
        videoId: video.videoId,
      });
    }
    try {
      ctx.waitUntil(processYouTubeUpload(video, sub));
    } catch (error) {
      console.error({
        message: "YouTube upload processing failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function uploadsPlaylistId(channelId: string): string {
  return `UU${channelId.slice(2)}`;
}

function videosFromPlaylistItems(items: YouTubePlaylistItem[]): YouTubeVideo[] {
  let videos: YouTubeVideo[] = [];

  for (let item of items) {
    let videoId =
      item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
    let title = item.snippet?.title;
    let channelId = item.snippet?.channelId;
    let published =
      item.contentDetails?.videoPublishedAt ??
      item.snippet?.publishedAt ??
      "";

    if (!videoId || !title || !channelId) continue;

    let channelName = item.snippet?.channelTitle ?? "YouTube";
    videos.push({
      videoId,
      title,
      channelId,
      channelName,
      published,
      updated: published,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  return videos;
}

export async function fetchUploadsPlaylistVideos(
  channelId: string,
): Promise<YouTubeVideo[]> {
  if (!env.YOUTUBE_TOKEN) {
    throw new Error("YOUTUBE_TOKEN is not set");
  }

  let playlistId = uploadsPlaylistId(channelId);
  let params = new URLSearchParams({
    part: "snippet,contentDetails",
    maxResults: String(PLAYLIST_MAX_RESULTS),
    playlistId,
    key: env.YOUTUBE_TOKEN,
  });
  let url = `${YOUTUBE_PLAYLIST_ITEMS_URL}?${params}`;

  console.log({
    message: "Fetching YouTube uploads playlist",
    channelId,
    playlistId,
  });

  let response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    let body = await response.text();
    console.error({
      message: "YouTube playlistItems.list failed",
      channelId,
      playlistId,
      status: response.status,
      body,
    });
    throw new Error(
      `YouTube playlistItems.list failed: ${response.status} ${body}`,
    );
  }

  let data = (await response.json()) as YouTubePlaylistItemsResponse;
  let videos = videosFromPlaylistItems(data.items ?? []);
  console.log({
    message: "YouTube uploads playlist parsed",
    channelId,
    playlistId,
    videoCount: videos.length,
  });
  return videos;
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
