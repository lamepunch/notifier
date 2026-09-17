import { env } from "cloudflare:workers";

import type {
  YouTubePollJob,
  YouTubeSubscribeJob,
  YouTubeSubscription,
  YouTubePlaylistItem,
  YouTubePlaylistItemsResponse,
  YouTubeVideo,
} from "@/types.d.ts";

import { QUEUE_SEND_BATCH_LIMIT } from "@/constants";
import { youtubeKey } from "@/kv";
import { notifyIfNewYouTubeVideo } from "./notifications";
import { listYouTubeKeys, loadYouTubeSubscriptions } from "./state";

const POLL_INTERVAL_IN_S = 900;

const PLAYLIST_MAX_RESULTS = 10;
const YOUTUBE_PLAYLIST_ITEMS_URL =
  "https://www.googleapis.com/youtube/v3/playlistItems";

export async function enqueueYouTubePolls(): Promise<{ count: number }> {
  let keys = await listYouTubeKeys();
  let subs = (await loadYouTubeSubscriptions(keys)).filter(
    (sub) => sub.active && sub.polling?.all === true,
  );
  let count = subs.length;

  if (count === 0) {
    console.log({
      message: "No YouTube channels need a poll watchdog job",
    });
  } else {
    for (let i = 0; i < subs.length; i += QUEUE_SEND_BATCH_LIMIT) {
      let chunk = subs.slice(i, i + QUEUE_SEND_BATCH_LIMIT);
      await env.YOUTUBE_POLL.sendBatch(
        chunk.map((sub) => ({ body: { channelId: sub.id } })),
      );
    }

    console.log({
      message: "Enqueued YouTube poll watchdog jobs",
      count,
    });
  }

  return { count };
}

export async function handlePollQueue(
  batch: MessageBatch<YouTubeSubscribeJob | YouTubePollJob>,
  ctx: ExecutionContext,
): Promise<void> {
  for (let message of batch.messages) {
    let { channelId } = message.body;
    console.log({
      message: "Processing queued YouTube poll job",
      channelId,
      attempts: message.attempts,
    });

    try {
      let sub = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(
        youtubeKey(channelId),
        { type: "json" },
      );
      let shouldPoll = !!sub?.active && sub.polling?.all === true;

      if (!shouldPoll) {
        console.log({
          message: "Skipping YouTube poll for missing, inactive, or unflagged channel",
          channelId,
        });
        message.ack();
        continue;
      }

      let videos = await fetchUploadsPlaylistVideos(channelId);
      for (let video of videos) {
        await notifyIfNewYouTubeVideo(video, ctx);
      }

      let latest = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(
        youtubeKey(channelId),
        { type: "json" },
      );
      let shouldReschedule =
        !!latest?.active && latest.polling?.all === true;
      if (shouldReschedule) {
        await env.YOUTUBE_POLL.send(
          { channelId },
          { delaySeconds: POLL_INTERVAL_IN_S },
        );
        console.log({
          message: "Scheduled next YouTube poll job",
          channelId,
          delaySeconds: POLL_INTERVAL_IN_S,
        });
      }

      message.ack();
    } catch (error) {
      console.error({
        message: "YouTube poll job failed",
        channelId,
        attempts: message.attempts,
        error: error instanceof Error ? error.message : String(error),
      });
      message.retry();
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
