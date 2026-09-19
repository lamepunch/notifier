import { env } from "cloudflare:workers";
import { Transient, inject } from "stratal/di";
import { LOGGER_TOKENS } from "stratal/logger";
import type { LoggerService } from "stratal/logger";

import type { YouTubeSubscription, YouTubeVideo } from "@/types/youtube";

import { DiscordService } from "@/discord/discord.service";
import { youtubeVideoSentKey } from "@/kv";
import { SubscriptionsService } from "@/subscriptions";

const YOUTUBE_EMBED_COLOR = 16_711_680;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1_000;
const VIDEO_SENT_TTL_IN_S = 7 * 24 * 60 * 60;

@Transient()
export class YouTubeNotificationService {
  constructor(
    @inject(DiscordService) private readonly discord: DiscordService,
    @inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    @inject(LOGGER_TOKENS.LoggerService) private readonly logger: LoggerService,
  ) {}

  async notifyIfNewYouTubeVideo(
    video: YouTubeVideo,
    ctx: Pick<ExecutionContext, "waitUntil">,
    fromHub = false,
  ): Promise<void> {
    let sub = await this.subscriptions.get<YouTubeSubscription>("youtube", video.channelId);

    let isSubscribed: boolean = !!sub?.active;
    // Pings also fire for edits of old videos and are retried by the
    // hub, so "new upload" means: published recently AND not already
    // sent (tracked in KV).
    let publishedAt = new Date(video.published).getTime();
    let isRecent: boolean = Date.now() - publishedAt < ONE_DAY_IN_MS;
    let sentKey = youtubeVideoSentKey(video.videoId);
    let hasAlreadySent: boolean =
      isSubscribed && isRecent
        ? (await env.SUBSCRIPTIONS.get(sentKey)) !== null
        : false;
    let isAccepted: boolean = isSubscribed && isRecent && !hasAlreadySent;

    this.logger.info(isAccepted ? "Video accepted, sending notification" : "Video skipped", {
      videoId: video.videoId,
      channelId: video.channelId,
      published: video.published,
      updated: video.updated,
      isSubscribed,
      isRecent,
      hasAlreadySent,
    });

    if (isAccepted && sub) {
      // ponytail: KV is eventually consistent, so pings landing in
      // different colos within ~60s could double-send; a Durable
      // Object would make this exactly-once if that ever matters.
      await env.SUBSCRIPTIONS.put(sentKey, video.published, {
        expirationTtl: VIDEO_SENT_TTL_IN_S,
      });
      let shouldClearPolling = fromHub && sub.polling === true;
      if (shouldClearPolling) {
        delete sub.polling;
        await this.subscriptions.save("youtube", sub);
        this.logger.info("Cleared YouTube polling after hub notification sent", {
          channelId: video.channelId,
          videoId: video.videoId,
        });
      }
      try {
        ctx.waitUntil(this.processYouTubeUpload(video, sub));
      } catch (error) {
        this.logger.error("YouTube upload processing failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async processYouTubeUpload(
    video: YouTubeVideo,
    sub: YouTubeSubscription,
  ) {
    let { videoId, title, channelName, channelId, videoUrl } = video;
    let channel = sub.channel ?? env.DISCORD_DEFAULT_YOUTUBE_CHANNEL;
    let thumbnailUrl = `https://i3.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

    let message = {
      content: ":new: YouTube video just uploaded!",
      embeds: [
        {
          title,
          url: videoUrl,
          image: { url: thumbnailUrl },
          author: {
            name: sub.name || channelName,
            url: sub.url || `https://www.youtube.com/channel/${channelId}`,
            ...(sub.icon ? { icon_url: sub.icon } : {}),
          },
          color: YOUTUBE_EMBED_COLOR,
        },
      ],
    };

    this.logger.info("YouTube Discord message constructed", {
      content: message,
    });

    await this.discord.sendMessage(channel, message);
  }
}
