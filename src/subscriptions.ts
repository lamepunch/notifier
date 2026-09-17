import { env } from "cloudflare:workers";

import type { Subscription, YouTubeSubscription as YouTubeRecord } from "./types.d.ts";
import { KV_GET_BATCH_LIMIT } from "./constants";
import { KICK_PREFIX, YOUTUBE_PREFIX } from "./kv";

function subscriptionStore<T extends { id: string | number }>(prefix: string) {
  const key = (id: T["id"]): string => `${prefix}${id}`;

  return {
    key,
    get(id: T["id"]): Promise<T | null> {
      return env.SUBSCRIPTIONS.get<T>(key(id), { type: "json" });
    },
    save(record: T): Promise<void> {
      return env.SUBSCRIPTIONS.put(key(record.id), JSON.stringify(record));
    },
    async list(): Promise<T[]> {
      let keys: string[] = [];
      let cursor: string | undefined;
      do {
        let page = await env.SUBSCRIPTIONS.list({ prefix, cursor });
        keys.push(...page.keys.map((entry) => entry.name));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);

      let records: T[] = [];
      for (let i = 0; i < keys.length; i += KV_GET_BATCH_LIMIT) {
        let values = await env.SUBSCRIPTIONS.get<T>(
          keys.slice(i, i + KV_GET_BATCH_LIMIT),
          { type: "json" },
        );
        for (let value of values.values()) {
          if (value !== null) records.push(value);
        }
      }
      return records;
    },
  };
}

export const KickSubscription = subscriptionStore<Subscription>(KICK_PREFIX);
export const YouTubeSubscription = subscriptionStore<YouTubeRecord>(YOUTUBE_PREFIX);

export type YouTubeSubscription = YouTubeRecord;
