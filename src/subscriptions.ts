import { env } from "cloudflare:workers";
import { Singleton } from "stratal/di";

import type { Subscription } from "@/types";
import type { YouTubeSubscription } from "@/types/youtube";
import { KICK_PREFIX, YOUTUBE_PREFIX } from "@/kv";
import type { Provider } from "@/types";

@Singleton()
export class SubscriptionsService {
  key(provider: Provider, id: string | number): string {
    return `${this.prefix(provider)}${id}`;
  }

  get<T>(provider: Provider, id: string | number): Promise<T | null> {
    return env.SUBSCRIPTIONS.get<T>(this.key(provider, id), { type: "json" });
  }

  save<T extends { id: string | number }>(provider: Provider, record: T): Promise<void> {
    return env.SUBSCRIPTIONS.put(this.key(provider, record.id), JSON.stringify(record));
  }

  async list<T>(provider: Provider): Promise<T[]> {
    let prefix = this.prefix(provider);
    // Subscription counts are intentionally small; one page keeps this repository simple.
    let page = await env.SUBSCRIPTIONS.list({ prefix, limit: 100 });
    let values = await env.SUBSCRIPTIONS.get<T>(
      page.keys.map((entry) => entry.name),
      { type: "json" },
    );
    return [...values.values()].filter((value): value is T => value !== null);
  }

  private prefix(provider: Provider): string {
    return provider === "kick" ? KICK_PREFIX : YOUTUBE_PREFIX;
  }
}

export type { YouTubeSubscription } from "@/types/youtube";
