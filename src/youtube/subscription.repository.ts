import { DI_TOKENS, Singleton, inject } from "stratal/di";
import type { StratalEnv } from "stratal";

import type { YouTubeSubscription } from "@/types/youtube";
import { YOUTUBE_PREFIX, youtubeVideoSentKey } from "@/kv";

const VIDEO_SENT_TTL_IN_S = 7 * 24 * 60 * 60;

/**
 * KV access for YouTube subscriptions (`youtube:{channelId}`) and the
 * per-video dedup markers (`youtube_video_sent:{videoId}`).
 */
@Singleton()
export class YouTubeSubscriptionRepository {
  constructor(@inject(DI_TOKENS.CloudflareEnv) private readonly env: StratalEnv) {}

  /** Public because the admin routes key their responses by it; nothing else builds these keys by hand. */
  key(channelId: string): string {
    return `${YOUTUBE_PREFIX}${channelId}`;
  }

  get(channelId: string): Promise<YouTubeSubscription | null> {
    return this.env.subs.get<YouTubeSubscription>(this.key(channelId), { type: "json" });
  }

  save(record: YouTubeSubscription): Promise<void> {
    return this.env.subs.put(this.key(record.id), JSON.stringify(record));
  }

  async list(): Promise<YouTubeSubscription[]> {
    // Subscription counts are intentionally small; one page keeps this repository simple.
    // ponytail: past 100 channels this silently truncates; add `cursor` pagination and
    // batch the gets (KV bulk get takes at most 100 keys per call).
    let page = await this.env.subs.list({ prefix: YOUTUBE_PREFIX, limit: 100 });
    let values = await this.env.subs.get<YouTubeSubscription>(
      page.keys.map((entry) => entry.name),
      { type: "json" },
    );

    return [...values.values()].filter((value): value is YouTubeSubscription => value !== null);
  }

  async listActive(): Promise<YouTubeSubscription[]> {
    return (await this.list()).filter((sub) => sub.active);
  }

  /**
   * Returns the updated record, or null when the channel is unknown.
   * Read-modify-write, not atomic: concurrent writers can lose updates.
   */
  async setActive(channelId: string, active: boolean): Promise<YouTubeSubscription | null> {
    let existing = await this.get(channelId);

    if (!existing) return null;

    let record: YouTubeSubscription = { ...existing, active };

    await this.save(record);
    return record;
  }

  /**
   * Returns the updated record, or null when the channel is unknown.
   * Disabling deletes the field: `polling` is stored as `true` or absent, never `false`.
   * Read-modify-write, not atomic.
   */
  async setPolling(channelId: string, enabled: boolean): Promise<YouTubeSubscription | null> {
    let existing = await this.get(channelId);

    if (!existing) return null;

    let record: YouTubeSubscription = { ...existing };

    if (enabled) record.polling = true;
    else delete record.polling;

    await this.save(record);
    return record;
  }

  /**
   * Store a freshly looked-up channel as active, keeping the Discord channel,
   * WebSub timestamps, and polling flag from any existing record. Always sets
   * `active: true`, so re-adding a deactivated channel reactivates it. An explicit
   * `channel` overrides the existing one.
   */
  async upsert(found: YouTubeSubscription, channel?: string): Promise<YouTubeSubscription> {
    let existing = await this.get(found.id);
    let record: YouTubeSubscription = {
      id: found.id,
      name: found.name,
      url: found.url,
      active: true,
    };

    if (found.icon) record.icon = found.icon;

    record.channel = channel || existing?.channel;

    if (!record.channel) delete record.channel;

    if (existing?.lastSubscribedAt) record.lastSubscribedAt = existing.lastSubscribedAt;

    if (existing?.lastVerifiedAt) record.lastVerifiedAt = existing.lastVerifiedAt;

    if (existing?.polling === true) record.polling = true;

    await this.save(record);
    return record;
  }

  /** True while a dedup marker exists; markers expire after VIDEO_SENT_TTL_IN_S. */
  hasSentVideo(videoId: string): Promise<boolean> {
    return this.env.subs.get(youtubeVideoSentKey(videoId)).then((value) => value !== null);
  }

  /**
   * The TTL is the dedup window: a video re-announced after it expires would be
   * sent again. Only the key's existence is checked; `published` is kept for debugging.
   */
  markVideoSent(videoId: string, published: string): Promise<void> {
    return this.env.subs.put(youtubeVideoSentKey(videoId), published, {
      expirationTtl: VIDEO_SENT_TTL_IN_S,
    });
  }
}
