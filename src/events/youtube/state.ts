import { env } from "cloudflare:workers";

import type { YouTubePolling, YouTubeSubscription } from "../../types.d.ts";

import { KV_GET_BATCH_LIMIT } from "../../constants";
import { YOUTUBE_PREFIX } from "../../kv";

export async function listYouTubeKeys(): Promise<string[]> {
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

export async function loadYouTubeSubscriptions(
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
