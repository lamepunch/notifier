import { env } from "cloudflare:workers";

import type { YouTubePollJob, YouTubeSubscribeJob } from "./types.d.ts";

import { enqueueYouTubePolls, handlePollQueue } from "./events/youtube/polling";
import {
  enqueueYouTubeSubscriptions,
  handleSubscribeQueue,
} from "./events/youtube/subscribing";

const YOUTUBE_POLL_QUEUE = "notifier-youtube-poll";

export async function scheduled(): Promise<void> {
  console.log({
    message: "Starting daily YouTube WebSub refresh and poll watchdog cron",
  });

  if (env.SERVICE_URL) {
    await enqueueYouTubeSubscriptions();
  } else {
    console.warn("SERVICE_URL is not set; skipping enqueue of WebSub hub jobs");
  }

  await enqueueYouTubePolls();
}

export async function queue(
  batch: MessageBatch<YouTubeSubscribeJob | YouTubePollJob>,
  _env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  let isPollQueue = batch.queue === YOUTUBE_POLL_QUEUE;
  if (isPollQueue) {
    await handlePollQueue(batch, ctx);
  } else {
    await handleSubscribeQueue(batch);
  }
}
