import { env } from "cloudflare:workers";
import { Transient, inject } from "stratal/di";
import { LOGGER_TOKENS } from "stratal/logger";
import type { LoggerService } from "stratal/logger";

@Transient()
export class DiscordService {
  constructor(
    @inject(LOGGER_TOKENS.LoggerService) private readonly logger: LoggerService,
  ) {}

  async sendMessage(channelId: string, message: unknown): Promise<void> {
    let response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${env.DISCORD_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      },
    );

    if (!response.ok) {
      this.logger.error("Discord API request failed", {
        channelId,
        body: await response.text(),
      });
    }
  }
}
