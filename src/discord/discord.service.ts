import { DI_TOKENS, Transient, inject } from "stratal/di";
import type { StratalEnv } from "stratal";
import { LOGGER_TOKENS } from "stratal/logger";
import type { LoggerService } from "stratal/logger";

import type { Provider } from "@/types";

@Transient()
export class DiscordService {
  constructor(
    @inject(DI_TOKENS.CloudflareEnv) private readonly env: StratalEnv,
    @inject(LOGGER_TOKENS.LoggerService) private readonly logger: LoggerService,
  ) {}

  async sendMessage(provider: Provider, message: unknown, channelId?: string): Promise<void> {
    let resolvedChannelId =
      channelId ??
      (provider === "kick"
        ? this.env.DISCORD_DEFAULT_CHANNEL
        : this.env.DISCORD_DEFAULT_YOUTUBE_CHANNEL);
    if (!resolvedChannelId) {
      throw new Error(`No Discord channel configured for ${provider}`);
    }

    let response = await fetch(
      `https://discord.com/api/v10/channels/${resolvedChannelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.env.DISCORD_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(message),
      },
    );

    if (!response.ok) {
      this.logger.error("Discord API request failed", {
        channelId: resolvedChannelId,
        body: await response.text(),
      });
    }
  }
}
