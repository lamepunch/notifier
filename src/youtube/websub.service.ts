import XMLParser from "@nodable/flexible-xml-parser";
import type { StratalEnv } from "stratal";
import { DI_TOKENS, Transient, inject } from "stratal/di";
import { HttpException } from "stratal/errors";
import { LOGGER_TOKENS } from "stratal/logger";
import type { LoggerService } from "stratal/logger";
import { InjectQueue } from "stratal/queue";
import type { IQueueSender } from "stratal/queue";
import type { RouterContext } from "stratal/router";

import type { YouTubeFeed, YouTubeSubscription, YouTubeVideo } from "@/types/youtube";
import { YouTubeNotificationService } from "@/youtube/notifications.service";
import { YouTubeSubscriptionRepository } from "@/youtube/subscription.repository";

const WEBSUB_LEASE_IN_S = 864_000;
const WEBSUB_LEASE_IN_MS = WEBSUB_LEASE_IN_S * 1_000;
// Renew before expiry; must exceed the daily cron interval or leases lapse.
const RENEW_MARGIN_IN_MS = 2 * 24 * 60 * 60 * 1_000;
const HUB_URL = "https://pubsubhubbub.appspot.com";

@Transient()
export class WebSubService {
  constructor(
    @inject(DI_TOKENS.CloudflareEnv) private readonly env: StratalEnv,
    @InjectQueue("websub") private readonly queue: IQueueSender,
    @inject(YouTubeSubscriptionRepository)
    private readonly subscriptions: YouTubeSubscriptionRepository,
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
    if (!mode || !topic || !challenge) throw new HttpException(404, "Not found");

    let channelId = new URL(topic).searchParams.get("channel_id");

    if (!channelId) throw new HttpException(404, "Missing channel_id");

    let sub = await this.subscriptions.get(channelId);
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
      await this.subscriptions.save(sub);
    }

    this.logger.info("YouTube WebSub verification accepted", { channelId, mode });
    return ctx.text(challenge);
  }

  /** The URL that the WebSub hub sends verification and feed requests to. */
  callbackUrl(): string {
    if (!this.env.SERVICE_URL) throw new HttpException(500, "SERVICE_URL is not set");

    return new URL("/webhooks/youtube", this.env.SERVICE_URL).href;
  }

  /** Queue a WebSub subscribe request for one channel. */
  enqueue(channelId: string): Promise<void> {
    return this.queue.dispatch({
      type: "youtube.websub",
      payload: { channelId },
      metadata: { idempotencyKey: crypto.randomUUID() },
    });
  }

  /**
   * Queue subscribe requests for active channels whose lease is missing or
   * about to expire, or for every active channel when forced.
   */
  async resync(force = false): Promise<{ count: number; skipped: number; active: number }> {
    this.callbackUrl();
    let active = await this.subscriptions.listActive();
    let selected = force
      ? active
      : active.filter((sub) => {
          let timestamp = Date.parse(sub.lastSubscribedAt ?? "");

          return (
            !Number.isFinite(timestamp) ||
            Date.now() - timestamp >= WEBSUB_LEASE_IN_MS - RENEW_MARGIN_IN_MS
          );
        });

    for (let sub of selected) await this.enqueue(sub.id);

    return {
      count: selected.length,
      skipped: active.length - selected.length,
      active: active.length,
    };
  }

  /** Scrape the hub's subscription-details page for each active channel. */
  async hubStatus() {
    let results = await Promise.all(
      (await this.subscriptions.listActive()).map((sub) => this.hubDetails(sub)),
    );

    return {
      expired: results.filter((r) => r.state !== "verified").length,
      total: results.length,
      subscriptions: results,
    };
  }

  /** Scrape the hub's subscription-details page for one channel. */
  async hubDetails(sub: YouTubeSubscription) {
    let params = new URLSearchParams({
      "hub.callback": this.callbackUrl(),
      "hub.topic": topicUrl(sub.id),
      "hub.secret": "",
    });
    let response = await fetch(`${HUB_URL}/subscription-details?${params}`);
    let fields = new Map<string, string | null>();
    let label = "";
    let buffer = "";

    // The page is a list of <dt>label</dt><dd>value</dd> pairs; "n/a" means no value.
    // ponytail: HTML scrape, breaks if Google changes the page layout
    await new HTMLRewriter()
      .on("dt, dd", {
        element(el) {
          let isLabel = el.tagName === "dt";

          buffer = "";
          el.onEndTag(() => {
            let value = buffer.replace(/\s+/g, " ").trim();

            if (isLabel) label = value;
            else fields.set(label, value === "n/a" ? null : value);
          });
        },
        text(chunk) {
          buffer += chunk.text;
        },
      })
      .transform(response)
      .arrayBuffer();

    let field = (name: string) => fields.get(name) ?? null;

    return {
      id: sub.id,
      name: sub.name,
      polling: sub.polling === true,
      lastSubscribedAt: sub.lastSubscribedAt ?? null,
      state: response.ok ? (field("State") ?? "unparsed") : `http ${response.status}`,
      expiresAt: field("Expiration time"),
      lastVerifiedAt: field("Last successful verification"),
      lastVerificationError: field("Last verification error"),
      lastDeliveryError: field("Last delivery error"),
    };
  }

  /**
   * Send a subscription request to the WebSub hub
   * @param channelId A specific YouTube channel that we want to subscribe to
   */
  async subscribe(channelId: string): Promise<void> {
    let params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.topic": topicUrl(channelId),
      "hub.callback": this.callbackUrl(),
      "hub.lease_seconds": String(WEBSUB_LEASE_IN_S),
      "hub.verify": "async",
    });

    let response = await fetch(`${HUB_URL}/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok)
      throw new Error(
        `YouTube WebSub subscription failed: ${response.status} ${await response.text()}`,
      );
  }

  /**
   * Handle a notification from the WebSub hub
   * @param clearPolling Whether this notification should clear the subscription polling flag
   */
  async notify(ctx: RouterContext, clearPolling: boolean): Promise<Response> {
    let videos = this.parseYouTubeFeed(await ctx.c.req.text());

    for (let video of videos)
      await this.notifications.notifyIfNewYouTubeVideo(video, ctx.c.executionCtx, clearPolling);

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

function topicUrl(channelId: string): string {
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}
