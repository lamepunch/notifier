import type { YouTubeSubscribeJob, YouTubeSubscription } from "./types.d.ts";

import { env } from "cloudflare:workers";
import { YOUTUBE_PREFIX, youtubeKey } from "./kv";

const QUEUE_MAX_RETRIES = 100;
const SEND_BATCH_LIMIT = 100;

export async function scheduled(): Promise<void> {
  console.log({ message: "YouTube WebSub cron started" });

  if (!env.SERVICE_URL) {
    console.warn(
      "SERVICE_URL is not set, skipping YouTube WebSub subscriptions",
    );
    return;
  }

  await enqueueYouTubeSubscriptions();
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

  console.log({ message: "Listed YouTube KV keys", count: keys.length });
  return keys;
}

async function loadYouTubeSubscriptions(
  keys: string[],
): Promise<YouTubeSubscription[]> {
  let subs: YouTubeSubscription[] = [];

  // ponytail: KV bulk get is capped at 100 keys per call
  for (let i = 0; i < keys.length; i += 100) {
    let batch = keys.slice(i, i + 100);
    let values = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(batch, {
      type: "json",
    });
    for (let value of values.values()) {
      if (value) subs.push(value);
    }
  }

  console.log({
    message: "Loaded YouTube subscriptions",
    keys: keys.length,
    loaded: subs.length,
  });
  return subs;
}

async function enqueueYouTubeSubscriptions() {
  let keys = await listYouTubeKeys();
  let subs = (await loadYouTubeSubscriptions(keys)).filter((sub) => sub.active);

  if (subs.length === 0) {
    console.log("No active YouTube subscriptions configured");
    return;
  }

  for (let i = 0; i < subs.length; i += SEND_BATCH_LIMIT) {
    let chunk = subs.slice(i, i + SEND_BATCH_LIMIT);
    await env.YOUTUBE_SUBSCRIBE.sendBatch(
      chunk.map((sub) => ({ body: { channelId: sub.id } })),
    );
  }

  console.log({
    message: "YouTube WebSub jobs enqueued",
    count: subs.length,
  });
}

function retryDelaySeconds(attempts: number): number {
  let delaySeconds = Math.min(3600, 30 * 2 ** (attempts - 1));
  console.log({
    message: "Using exponential retry delay",
    attempts,
    delaySeconds,
  });
  return delaySeconds;
}

// Queues delaySeconds is a positive integer, capped at 24h on send().
const MAX_RETRY_DELAY = 86400;

function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) {
    console.log({ message: "No Retry-After header" });
    return;
  }

  let delay = Number(header);
  if (!Number.isFinite(delay)) {
    console.warn({ message: "Invalid Retry-After header", header });
    return;
  }

  let delaySeconds = Math.min(MAX_RETRY_DELAY, Math.max(1, delay));
  console.log({
    message: "Parsed Retry-After",
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
  batch: MessageBatch<YouTubeSubscribeJob>,
): Promise<void> {
  for (let message of batch.messages) {
    let { channelId } = message.body;
    console.log({
      message: "Processing YouTube WebSub job",
      channelId,
      attempts: message.attempts,
    });

    try {
      let sub = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(
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

      await subscribeToYouTubeChannel(channelId, env.SERVICE_URL);
      message.ack();
    } catch (error) {
      let delaySeconds = delaySecondsFromError(error);

      console.error({
        message: "YouTube WebSub subscription failed",
        channelId,
        attempts: message.attempts,
        delaySeconds,
        error: error instanceof Error ? error.message : String(error),
      });

      // Queues stop retrying after max_retries; send a fresh job so a
      // flaky hub keeps being attempted until it accepts (or we deactivate).
      if (message.attempts >= QUEUE_MAX_RETRIES) {
        let requeueDelay =
          delaySeconds ?? retryDelaySeconds(message.attempts);
        console.warn({
          message: "WebSub retries exhausted, re-enqueueing",
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
          message: "Retrying WebSub subscription after Retry-After",
          channelId,
          attempts: message.attempts,
          delaySeconds,
        });
        message.retry({ delaySeconds });
      } else {
        console.log({
          message: "Retrying WebSub subscription with default delay",
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
  params.set("hub.lease_seconds", "432000");
  params.set("hub.verify", "async");

  console.log({
    message: "Posting YouTube WebSub subscribe",
    channelId,
    callbackUrl,
  });

  let response = await fetch("https://pubsubhubbub.appspot.com/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!response.ok) {
    let body = await response.text();
    let retryAfter = response.headers.get("Retry-After");
    let delaySeconds = retryAfterSeconds(retryAfter);
    console.error({
      message: "YouTube WebSub subscription failed",
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

  console.log({ message: "YouTube WebSub subscription requested", channelId });
}
