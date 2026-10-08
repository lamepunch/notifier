import { Transient, inject } from "stratal/di";
import { LOGGER_TOKENS } from "stratal/logger";
import type { LoggerService } from "stratal/logger";
import { InjectQueue } from "stratal/queue";
import type { IQueueConsumer, IQueueSender, QueueMessage } from "stratal/queue";
import type { WebSubJob } from "@/types/youtube";
import { YouTubeSubscriptionRepository } from "@/youtube/subscription.repository";
import { WebSubService } from "@/youtube/websub.service";

@Transient()
export class WebSubConsumer implements IQueueConsumer<WebSubJob> {
  readonly messageTypes = ["youtube.websub"];

  constructor(
    @InjectQueue("poll") private readonly poll: IQueueSender,
    @inject(YouTubeSubscriptionRepository)
    private readonly subscriptions: YouTubeSubscriptionRepository,
    @inject(WebSubService)
    private readonly webSub: WebSubService,
    @inject(LOGGER_TOKENS.LoggerService)
    private readonly logger: LoggerService,
  ) {}

  async handle(message: QueueMessage<WebSubJob>) {
    let { channelId } = message.payload;
    let sub = await this.subscriptions.get(channelId);
    if (!sub?.active) return;

    try {
      await this.webSub.subscribe(channelId);
      sub.lastSubscribedAt = new Date().toISOString();
      await this.subscriptions.save(sub);
    } catch (error) {
      if (sub.polling !== true) {
        sub.polling = true;
        await this.subscriptions.save(sub);
        this.logger.info("YouTube polling channel queued", {
          channelId,
          source: "fallback",
        });
        await this.poll.dispatch({
          type: "youtube.poll",
          payload: { channelId },
          metadata: { idempotencyKey: crypto.randomUUID() },
        });
      }
      throw error;
    }
  }
}
