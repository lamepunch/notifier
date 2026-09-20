import { DI_TOKENS, Singleton, inject } from "stratal/di";
import type { StratalEnv } from "stratal";

import type { Subscription } from "@/types";
import type { YouTubeSubscription } from "@/types/youtube";
import { KICK_PREFIX, YOUTUBE_PREFIX, youtubeVideoSentKey } from "@/kv";
import type { Provider } from "@/types";

const VIDEO_SENT_TTL_IN_S = 7 * 24 * 60 * 60;

@Singleton()
export class SubscriptionsService {
  constructor(@inject(DI_TOKENS.CloudflareEnv) private readonly env: StratalEnv) {}

  key(provider: Provider, id: string | number): string {
    return `${this.prefix(provider)}${id}`;
  }

  get<T>(provider: Provider, id: string | number): Promise<T | null> {
    return this.env.subs.get<T>(this.key(provider, id), { type: "json" });
  }

  save<T extends { id: string | number }>(provider: Provider, record: T): Promise<void> {
    return this.env.subs.put(this.key(provider, record.id), JSON.stringify(record));
  }

  hasSentYouTubeVideo(videoId: string): Promise<boolean> {
    return this.env.subs.get(youtubeVideoSentKey(videoId)).then(
      (value) => value !== null,
    );
  }

  markYouTubeVideoSent(videoId: string, published: string): Promise<void> {
    return this.env.subs.put(youtubeVideoSentKey(videoId), published, {
      expirationTtl: VIDEO_SENT_TTL_IN_S,
    });
  }

  async list<T>(provider: Provider): Promise<T[]> {
    let prefix = this.prefix(provider);
    // Subscription counts are intentionally small; one page keeps this repository simple.
    let page = await this.env.subs.list({ prefix, limit: 100 });
    let values = await this.env.subs.get<T>(
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
