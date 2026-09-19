import { Module } from "stratal/module";
import { QueueModule } from "stratal/queue";

import { AdminModule } from "@/admin/admin.module";
import { DiscordModule } from "@/discord/discord.module";
import { KickWebhooksController } from "@/kick.controller";
import { YouTubeModule } from "@/youtube/youtube.module";
import { SubscriptionsService } from "@/subscriptions";

@Module({
  imports: [
    QueueModule.forRootAsync({
      inject: [],
      useFactory: () => ({
        provider: "cloudflare",
        store: { binding: "SUBSCRIPTIONS" },
        maxRetries: 3,
      }),
    }),
    AdminModule,
    DiscordModule,
    YouTubeModule,
  ],
  controllers: [KickWebhooksController],
  providers: [SubscriptionsService],
})
export class AppModule {}
