import { Module } from "stratal/module";
import { QueueModule } from "stratal/queue";

import { DiscordModule } from "@/discord/discord.module";

import { DailyYouTubeRefreshJob } from "@/youtube/jobs/daily-refresh.job";
import { YouTubeNotificationService } from "@/youtube/notifications.service";
import { YouTubePollEnqueueJob } from "@/youtube/jobs/poll-enqueue.job";
import { YouTubePollConsumer } from "@/youtube/poll.consumer";
import { YouTubePollingService } from "@/youtube/polling.service";
import {
  YouTubeWebhooksController,
  WebSubFallbackController,
} from "@/youtube/webhooks.controller";
import { WebSubConsumer } from "@/youtube/websub.consumer";
import { WebSubService } from "@/youtube/websub.service";

@Module({
  imports: [
    DiscordModule,
    QueueModule.registerQueue("websub"),
    QueueModule.registerQueue("poll"),
  ],
  providers: [YouTubeNotificationService, YouTubePollingService, WebSubService],
  controllers: [YouTubeWebhooksController, WebSubFallbackController],
  consumers: [WebSubConsumer, YouTubePollConsumer],
  jobs: [DailyYouTubeRefreshJob, YouTubePollEnqueueJob],
})
export class YouTubeModule {}
