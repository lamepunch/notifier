import { env } from "cloudflare:workers";
import { Transient } from "stratal/di";

@Transient()
export class DiscordService {
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
      console.error({
        message: "Discord API request failed",
        channelId,
        body: await response.text(),
      });
    }
  }
}
