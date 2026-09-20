import { inject } from "stratal/di";
import { LOGGER_TOKENS } from "stratal/logger";
import type { LoggerService } from "stratal/logger";
import { Controller, Post, type RouterContext } from "stratal/router";

import type { LivestreamStatusUpdated, Subscription } from "@/types";

import { DiscordService } from "@/discord/discord.service";
import { SubscriptionsService } from "@/subscriptions";

const KICK_EMBED_COLOR = 1_752_220;

@Controller("/webhooks/kick")
export class KickWebhooksController {
  constructor(
    @inject(DiscordService) private readonly discord: DiscordService,
    @inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    @inject(LOGGER_TOKENS.LoggerService) private readonly logger: LoggerService,
  ) {}

  @Post("/")
  async notify(ctx: RouterContext): Promise<Response> {
    // @TODO: verify webhook signature
    if (ctx.header("Kick-Event-Type") === "livestream.status.updated") {
      let data = await ctx.c.req.json<LivestreamStatusUpdated>();
      if (data.is_live) {
        ctx.c.executionCtx.waitUntil(this.processWebhook(data));
      }
    }
    return ctx.c.body(null, 200);
  }

  private async processWebhook(data: LivestreamStatusUpdated): Promise<void> {
    let { broadcaster, title } = data;
    let userId = broadcaster.user_id;
    let slug = broadcaster.channel_slug;

    let url = `https://kick.com/${slug}`;
    let sub = await this.subscriptions.get<Subscription>("kick", userId);

    // If sub doesn't exist or is inactive, stop processing webhook early
    if (!sub || !sub.active) {
      this.logger.info("Unknown or inactive Kick subscription received", {
        userId,
      });

      return;
    }

    let { channel, links, mentions } = sub;

    let description = `:link: [Kick](${url})`;
    if (links) {
      description +=
        " · " +
        Object.entries(links)
          .map(
            ([name, link]) =>
              `[${name[0].toUpperCase() + name.slice(1)}](${link})`,
          )
          .join(" · ");
    }

    let content = ":red_circle: Stream has gone live!";
    if (mentions) {
      content = mentions.map((id) => `<@${id}>`).join(" ") + " " + content;
    }

    let message = {
      content,
      embeds: [
        {
          title: `:arrow_right: ${title}`,
          description,
          author: {
            name: broadcaster.username,
            icon_url: broadcaster.profile_picture,
          },
          color: KICK_EMBED_COLOR,
        },
      ],
    };

    this.logger.info("Discord message constructed", { content: message });

    await this.discord.sendMessage("kick", message, channel);
  }
}
