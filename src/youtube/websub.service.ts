import { Singleton, inject } from "stratal/di";
import { HttpException } from "stratal/errors";
import type { RouterContext } from "stratal/router";

import type { YouTubeSubscription } from "@/types/youtube";
import { SubscriptionsService } from "@/subscriptions";

@Singleton()
export class WebSubService {
  constructor(
    @inject(SubscriptionsService)
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async verify(ctx: RouterContext): Promise<Response> {
    let channelId = new URL(ctx.query("hub.topic")).searchParams.get("channel_id");
    if (!channelId) throw new HttpException(404, "Missing channel_id");

    let sub = await this.subscriptions.get<YouTubeSubscription>("youtube", channelId);
    let subscribing = ctx.query("hub.mode") === "subscribe";
    if (subscribing !== !!sub) throw new HttpException(404, "Unknown subscription");
    if (subscribing && sub) {
      sub.lastVerifiedAt = new Date().toISOString();
      await this.subscriptions.save("youtube", sub);
    }
    return ctx.text(ctx.query("hub.challenge"));
  }

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
}
