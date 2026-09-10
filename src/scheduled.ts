import { env } from "cloudflare:workers";

import type { YouTubeSubscribeJob, YouTubeSubscription } from "./types.d.ts";

import { KV_GET_BATCH_LIMIT } from "./constants";
import { YOUTUBE_PREFIX, youtubeKey } from "./kv";

const QUEUE_MAX_RETRIES = 100;
const QUEUE_SEND_BATCH_LIMIT = 100;
const WEBSUB_LEASE_IN_S = 864_000;
const WEBSUB_LEASE_IN_MS = WEBSUB_LEASE_IN_S * 1_000;
const RETRY_DELAY_BASE_IN_S = 30;
const RETRY_DELAY_CAP_IN_S = 3_600;
const MAX_RETRY_DELAY_IN_S = 86_400;
const YOUTUBE_WEBSUB_HUB = "https://pubsubhubbub.appspot.com/subscribe";

export async function scheduled(): Promise<void> {
  console.log({ message: "YouTube WebSub cron started" });

  if (env.SERVICE_URL) {
    await enqueueYouTubeSubscriptions();
  } else {
    console.warn(
      "SERVICE_URL is not set, skipping YouTube WebSub subscriptions",
    );
  }
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
    message: "Loaded YouTube subscriptions",
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

async function enqueueYouTubeSubscriptions() {
  let keys = await listYouTubeKeys();
  let active = (await loadYouTubeSubscriptions(keys)).filter(
    (sub) => sub.active,
  );
  let subs = active.filter(needsWebSubRefresh);
  let skipped = active.length - subs.length;

  if (subs.length === 0) {
    console.log({
      message: "No YouTube WebSub refreshes due",
      active: active.length,
      skipped,
    });
  } else {
    for (let i = 0; i < subs.length; i += QUEUE_SEND_BATCH_LIMIT) {
      let chunk = subs.slice(i, i + QUEUE_SEND_BATCH_LIMIT);
      await env.YOUTUBE_SUBSCRIBE.sendBatch(
        chunk.map((sub) => ({ body: { channelId: sub.id } })),
      );
    }

    console.log({
      message: "YouTube WebSub jobs enqueued",
      count: subs.length,
      skipped,
    });
  }
}

function retryDelaySeconds(attempts: number): number {
  let delaySeconds = Math.min(
    RETRY_DELAY_CAP_IN_S,
    RETRY_DELAY_BASE_IN_S * 2 ** (attempts - 1),
  );
  console.log({
    message: "Using exponential retry delay",
    attempts,
    delaySeconds,
  });
  return delaySeconds;
}

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

  // Queues delaySeconds is a positive integer, capped at 24h on send().
  let delaySeconds = Math.min(MAX_RETRY_DELAY_IN_S, Math.max(1, delay));
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
      sub.lastSubscribedAt = new Date().toISOString();
      await env.SUBSCRIPTIONS.put(youtubeKey(channelId), JSON.stringify(sub));
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
  params.set("hub.lease_seconds", String(WEBSUB_LEASE_IN_S));
  params.set("hub.verify", "async");

  console.log({
    message: "Posting YouTube WebSub subscribe",
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
