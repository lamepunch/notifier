import XMLParser from "@nodable/flexible-xml-parser";
import { Singleton, inject } from "stratal/di";
import { HttpException } from "stratal/errors";
import { LOGGER_TOKENS } from "stratal/logger";
import type { LoggerService } from "stratal/logger";
import type { RouterContext } from "stratal/router";

import type { YouTubeFeed, YouTubeSubscription, YouTubeVideo } from "@/types/youtube";
import { SubscriptionsService } from "@/subscriptions";
import { YouTubeNotificationService } from "@/youtube/notifications.service";

@Singleton()
export class WebSubService {
  constructor(
    @inject(SubscriptionsService)
    private readonly subscriptions: SubscriptionsService,
    @inject(YouTubeNotificationService)
    private readonly notifications: YouTubeNotificationService,
    @inject(LOGGER_TOKENS.LoggerService)
    private readonly logger: LoggerService,
  ) {}

  /**
   * Handle a WebSub verification request to ensure that a subscription request was
   * actually valid and wanted from the subscriber.
   *
   * [Hub Verifies Intent of the Subscriber](https://pubsubhubbub.github.io/PubSubHubbub/pubsubhubbub-core-0.4.html#verifysub)
   */
  async verify(ctx: RouterContext): Promise<Response> {
    let mode = ctx.query("hub.mode");
    let topic = ctx.query("hub.topic");
    let challenge = ctx.query("hub.challenge");

    this.logger.info("YouTube WebSub verification request received", {
      mode,
      topic,
    });

    // Give up if we can't find any of these in the querystring
    if (!mode || !topic || !challenge) {
      throw new HttpException(404, "Not found");
    }

    let channelId = new URL(topic).searchParams.get("channel_id");
    if (!channelId) throw new HttpException(404, "Missing channel_id");

    let sub = await this.subscriptions.get<YouTubeSubscription>("youtube", channelId);
    let subscribing = mode === "subscribe";
    this.logger.info("YouTube WebSub verification subscription lookup", {
      channelId,
      mode,
      isKnownSubscription: !!sub,
    });

    // This subscription doesn't exist, reject it per the WebSub spec
    if (subscribing !== !!sub) {
      this.logger.warn("YouTube WebSub verification rejected", {
        channelId,
        mode,
        challenge,
        isKnownSubscription: !!sub,
      });
      throw new HttpException(404, "Unknown subscription");
    }

    if (subscribing && sub) {
      sub.lastVerifiedAt = new Date().toISOString();
      await this.subscriptions.save("youtube", sub);
    }

    this.logger.info("YouTube WebSub verification accepted", { channelId, mode });
    return ctx.text(challenge);
  }

  /**
   * Send a subscription request to the WebSub hub
   * @param channelId A specific YouTube channel that we want to subscribe to
   * @param callbackUrl The URL that the WebSub hub will send requests to
   */
  async subscribe(channelId: string, callbackUrl: string): Promise<void> {
    let params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.topic": `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`,
      "hub.callback": callbackUrl,
      "hub.lease_seconds": String(864_000),
      "hub.verify": "async",
    });

    let response = await fetch("https://pubsubhubbub.appspot.com/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `YouTube WebSub subscription failed: ${response.status} ${await response.text()}`,
      );
    }
  }

  /**
   * Handle a notification from the WebSub hub
   * @param clearPolling Whether this notification should clear the subscription polling flag
   */
  async notify(ctx: RouterContext, clearPolling: boolean): Promise<Response> {
    let videos = this.parseYouTubeFeed(await ctx.c.req.text());
    for (let video of videos) {
      await this.notifications.notifyIfNewYouTubeVideo(
        video,
        ctx.c.executionCtx,
        clearPolling,
      );
    }
    return ctx.c.body(null, 200);
  }

  /**
   * Parse the WebSub XML request body into an intermediate data format
   * @param xml Request body sent via WebSub hub
   * @returns An array of YouTubeVideo objects
   */
  private parseYouTubeFeed(xml: string): YouTubeVideo[] {
    let parser = new XMLParser();
    let feed = parser.parse(xml) as YouTubeFeed;

    let entries = feed.feed?.entry;
    if (!entries) return [];

    let entryArray = Array.isArray(entries) ? entries : [entries];
    let videos: YouTubeVideo[] = [];

    for (let entry of entryArray) {
      let videoId = entry["yt:videoId"];
      let channelId = entry["yt:channelId"];
      let title = entry.title;
      let published = entry.published;
      let updated = entry.updated;

      if (!videoId || !title || !channelId) continue;

      videos.push({
        videoId,
        title,
        channelId,
        channelName: "YouTube",
        published: published || updated || "",
        updated: updated || published || "",
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      });
    }

    return videos;
  }
}
