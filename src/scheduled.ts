import { env } from "cloudflare:workers";

import type {
  YouTubePollJob,
  YouTubeSubscribeJob,
  YouTubeSubscription,
} from "./types.d.ts";

import { KV_GET_BATCH_LIMIT } from "./constants";
import {
  fetchUploadsPlaylistVideos,
  notifyIfNewYouTubeVideo,
  setPollingFlags,
} from "./events/youtube";
import { YOUTUBE_PREFIX, youtubeKey } from "./kv";

const QUEUE_MAX_RETRIES = 100;
const QUEUE_SEND_BATCH_LIMIT = 100;
const WEBSUB_LEASE_IN_S = 864_000;
const WEBSUB_LEASE_IN_MS = WEBSUB_LEASE_IN_S * 1_000;
const RETRY_DELAY_BASE_IN_S = 30;
const RETRY_DELAY_CAP_IN_S = 3_600;
const MAX_RETRY_DELAY_IN_S = 86_400;
const POLL_INTERVAL_IN_S = 900;
const YOUTUBE_WEBSUB_HUB = "https://pubsubhubbub.appspot.com/subscribe";
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

async function listYouTubeKeys(): Promise<string[]> {
  let keys: string[] = [];
  let cursor: string | undefined;

  do {
    let page = await env.SUBSCRIPTIONS.list({
      prefix: YOUTUBE_PREFIX,
      cursor,
    });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  console.log({
    message: "Listed YouTube subscription keys from KV",
    count: keys.length,
  });
  return keys;
}

async function loadYouTubeSubscriptions(
  keys: string[],
): Promise<YouTubeSubscription[]> {
  let subs: YouTubeSubscription[] = [];

  // ponytail: KV bulk get is capped at 100 keys per call
  for (let i = 0; i < keys.length; i += KV_GET_BATCH_LIMIT) {
    let batch = keys.slice(i, i + KV_GET_BATCH_LIMIT);
    let values = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(batch, {
      type: "json",
    });
    for (let value of values.values()) {
      if (value) subs.push(value);
    }
  }

  console.log({
    message: "Loaded YouTube subscription records from KV",
    keys: keys.length,
    loaded: subs.length,
  });
  return subs;
}

function needsWebSubRefresh(sub: YouTubeSubscription): boolean {
  let hasTimestamp = !!sub.lastSubscribedAt;
  let at = Date.parse(sub.lastSubscribedAt ?? "");
  let isValidTimestamp = Number.isFinite(at);
  let isLeaseExpired = Date.now() - at >= WEBSUB_LEASE_IN_MS;
  return !hasTimestamp || !isValidTimestamp || isLeaseExpired;
}

export async function enqueueYouTubeSubscriptions(
  force = false,
): Promise<{ count: number; skipped: number; active: number }> {
  let keys = await listYouTubeKeys();
  let active = (await loadYouTubeSubscriptions(keys)).filter(
    (sub) => sub.active,
  );

  let subs = active.filter(needsWebSubRefresh);
  // Enqueue all subscriptions if a resync operation was requested
  if (force) {
    subs = active;
  }
  let skipped = active.length - subs.length;
  let count = subs.length;

  if (count === 0) {
    console.log({
      message: "No YouTube channels need a WebSub hub refresh",
      active: active.length,
      skipped,
      force,
    });
  } else {
    for (let i = 0; i < subs.length; i += QUEUE_SEND_BATCH_LIMIT) {
      let chunk = subs.slice(i, i + QUEUE_SEND_BATCH_LIMIT);
      await env.YOUTUBE_SUBSCRIBE.sendBatch(
        chunk.map((sub) => ({ body: { channelId: sub.id } })),
      );
    }

    console.log({
      message: "Enqueued WebSub hub subscribe jobs",
      count,
      skipped,
      force,
    });
  }

  return { count, skipped, active: active.length };
}

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

function retryDelaySeconds(attempts: number): number {
  let delaySeconds = Math.min(
    RETRY_DELAY_CAP_IN_S,
    RETRY_DELAY_BASE_IN_S * 2 ** (attempts - 1),
  );
  console.log({
    message: "Computed exponential retry delay",
    attempts,
    delaySeconds,
  });
  return delaySeconds;
}

function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) {
    console.log({ message: "WebSub hub response has no Retry-After header" });
    return;
  }

  let delay = Number(header);
  if (!Number.isFinite(delay)) {
    console.warn({ message: "Invalid Retry-After header", header });
    return;
  }

  // Queues delaySeconds is a positive integer, capped at 24h on send().
  let delaySeconds = Math.min(MAX_RETRY_DELAY_IN_S, Math.max(1, delay));
  console.log({
    message: "Using Retry-After delay from WebSub hub",
    header,
    delay,
    delaySeconds,
  });
  return delaySeconds;
}

function delaySecondsFromError(error: unknown): number | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "delaySeconds" in error &&
    typeof error.delaySeconds === "number"
  ) {
    return error.delaySeconds;
  }
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

async function handlePollQueue(
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

async function handleSubscribeQueue(
  batch: MessageBatch<YouTubeSubscribeJob | YouTubePollJob>,
): Promise<void> {
  for (let message of batch.messages) {
    let { channelId } = message.body;
    console.log({
      message: "Processing queued WebSub hub subscribe job",
      channelId,
      attempts: message.attempts,
    });

    let sub: YouTubeSubscription | null = null;
    try {
      sub = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(
        youtubeKey(channelId),
        { type: "json" },
      );

      if (!sub?.active) {
        console.log({
          message: "Skipping WebSub refresh for missing or inactive channel",
          channelId,
        });
        message.ack();
        continue;
      }

      if (!env.SERVICE_URL) {
        throw new Error("SERVICE_URL is not set");
      }

      await subscribeToYouTubeChannel(
        channelId,
        new URL("/webhooks/youtube", env.SERVICE_URL).href,
      );
      sub.lastSubscribedAt = new Date().toISOString();
      let members = sub.polling?.members ?? false;
      setPollingFlags(sub, false, members);
      await env.SUBSCRIPTIONS.put(youtubeKey(channelId), JSON.stringify(sub));
      message.ack();
    } catch (error) {
      let delaySeconds = delaySecondsFromError(error);

      console.error({
        message: "WebSub hub subscribe job failed",
        channelId,
        attempts: message.attempts,
        delaySeconds,
        error: error instanceof Error ? error.message : String(error),
      });

      let isFirstFailure = message.attempts === 1;
      if (isFirstFailure && sub?.active) {
        try {
          let members = sub.polling?.members ?? false;
          setPollingFlags(sub, true, members);
          await env.SUBSCRIPTIONS.put(
            youtubeKey(channelId),
            JSON.stringify(sub),
          );
          await env.YOUTUBE_POLL.send({ channelId });
          console.log({
            message: "Enabled YouTube polling after WebSub hub failure",
            channelId,
          });
        } catch (pollError) {
          console.error({
            message: "Failed to enable YouTube polling after hub failure",
            channelId,
            error:
              pollError instanceof Error
                ? pollError.message
                : String(pollError),
          });
        }
      }

      // Queues stop retrying after max_retries; send a fresh job so a
      // flaky hub keeps being attempted until it accepts (or we deactivate).
      if (message.attempts >= QUEUE_MAX_RETRIES) {
        let requeueDelay = delaySeconds ?? retryDelaySeconds(message.attempts);
        console.warn({
          message: "Queue retries exhausted; sending a new WebSub hub job",
          channelId,
          attempts: message.attempts,
          delaySeconds: requeueDelay,
        });
        await env.YOUTUBE_SUBSCRIBE.send(
          { channelId },
          { delaySeconds: requeueDelay },
        );
        message.ack();
        continue;
      }

      // message.retry({ delaySeconds }) is required to honor Retry-After;
      // throwing would use the consumer's fixed retry_delay instead.
      if (delaySeconds !== undefined) {
        console.log({
          message: "Retrying WebSub hub job using Retry-After delay",
          channelId,
          attempts: message.attempts,
          delaySeconds,
        });
        message.retry({ delaySeconds });
      } else {
        console.log({
          message: "Retrying WebSub hub job with the queue default delay",
          channelId,
          attempts: message.attempts,
        });
        message.retry();
      }
    }
  }
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
  params.set("hub.lease_seconds", String(WEBSUB_LEASE_IN_S));
  params.set("hub.verify", "async");

  console.log({
    message: "Sending subscription request to WebSub hub",
    channelId,
    callbackUrl,
  });

  let response = await fetch(YOUTUBE_WEBSUB_HUB, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    let body = await response.text();
    let retryAfter = response.headers.get("Retry-After");
    let delaySeconds = retryAfterSeconds(retryAfter);
    console.error({
      message: "WebSub hub rejected subscription request",
      status: response.status,
      body,
      channelId,
      retryAfter,
      delaySeconds,
    });
    let error: Error & { delaySeconds?: number } = new Error(
      `YouTube WebSub subscription failed: ${response.status} ${body}`,
    );
    if (delaySeconds !== undefined) error.delaySeconds = delaySeconds;
    throw error;
  }

  console.log({
    message: "WebSub hub accepted subscription request",
    channelId,
  });
}
