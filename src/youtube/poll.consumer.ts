import type { StratalExecutionContext } from "stratal";
import { DI_TOKENS, Transient, inject } from "stratal/di";
import type { IQueueConsumer, QueueMessage } from "stratal/queue";
import type { YouTubePollJob } from "@/types/youtube";
import { YouTubeSubscriptionRepository } from "@/youtube/subscription.repository";
import { YouTubeNotificationService } from "@/youtube/notifications.service";
import { YouTubePollingService } from "@/youtube/polling.service";

@Transient()
export class YouTubePollConsumer implements IQueueConsumer<YouTubePollJob> {
  readonly messageTypes = ["youtube.poll"];

  constructor(
    @inject(DI_TOKENS.ExecutionContext)
    private readonly ctx: StratalExecutionContext,
    @inject(YouTubePollingService)
    private readonly polling: YouTubePollingService,
    @inject(YouTubeNotificationService)
    private readonly notifications: YouTubeNotificationService,
    @inject(YouTubeSubscriptionRepository)
    private readonly subscriptions: YouTubeSubscriptionRepository,
  ) {}

  async handle(message: QueueMessage<YouTubePollJob>): Promise<void> {
    let { channelId } = message.payload;
    let sub = await this.subscriptions.get(channelId);
    if (!sub?.active || sub.polling !== true) return;
    for (let video of await this.polling.fetchUploadsPlaylistVideos(channelId)) {
      await this.notifications.notifyIfNewYouTubeVideo(video, this.ctx);
    }
  }
}
