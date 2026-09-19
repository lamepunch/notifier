import XMLParser from "@nodable/flexible-xml-parser";
import { Controller, Get, Post, type RouterContext } from "stratal/router";
import { inject } from "stratal/di";
import { z } from "stratal/validation";
import type { YouTubeFeed, YouTubeVideo } from "@/types/youtube";
import { YouTubeNotificationService } from "@/youtube/notifications.service";
import { WebSubService } from "@/youtube/websub.service";

const webSubVerification = z.object({
  "hub.mode": z.enum(["subscribe", "unsubscribe"]),
  "hub.topic": z.url(),
  "hub.challenge": z.string().min(1),
  "hub.lease_seconds": z.string().regex(/^\d+$/).optional(),
}).refine(
  (query) => query["hub.mode"] !== "subscribe" || query["hub.lease_seconds"] !== undefined,
  { message: "hub.lease_seconds is required when subscribing" },
);

@Controller("/webhooks/youtube")
export class YouTubeWebhooksController {
  constructor(
    @inject(YouTubeNotificationService)
    private readonly notifications: YouTubeNotificationService,
    @inject(WebSubService)
    private readonly webSub: WebSubService,
  ) {}

  @Get("/", { query: webSubVerification })
  async verify(ctx: RouterContext): Promise<Response> {
    return this.webSub.verify(ctx);
  }

  @Post("/")
  async notify(ctx: RouterContext): Promise<Response> {
    let videos = parseYouTubeFeed(await ctx.c.req.text());
    for (let video of videos) {
      await this.notifications.notifyIfNewYouTubeVideo(
        video,
        ctx.c.executionCtx,
        true,
      );
    }
    return ctx.c.body(null, 200);
  }
}

@Controller("/")
export class WebSubFallbackController {
  constructor(
    @inject(WebSubService)
    private readonly webSub: WebSubService,
  ) {}

  @Get("/", { query: webSubVerification })
  verify(ctx: RouterContext): Promise<Response> {
    return this.webSub.verify(ctx);
  }
}

export function parseYouTubeFeed(xml: string): YouTubeVideo[] {
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

    let author = entry.author;
    let channelName =
      typeof author === "object" && author && "name" in author
        ? author.name
        : "YouTube";

    videos.push({
      videoId,
      title,
      channelId,
      channelName: typeof channelName === "string" ? channelName : "YouTube",
      published: published || updated || "",
      updated: updated || published || "",
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }

  return videos;
}
