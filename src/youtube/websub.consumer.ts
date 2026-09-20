import { DI_TOKENS, Transient, inject } from "stratal/di";
import type { StratalEnv } from "stratal";
import { InjectQueue } from "stratal/queue";
import type { IQueueConsumer, IQueueSender, QueueMessage } from "stratal/queue";
import type { YouTubeSubscription, WebSubJob } from "@/types/youtube";
import { SubscriptionsService } from "@/subscriptions";
import { WebSubService } from "@/youtube/websub.service";

@Transient()
export class WebSubConsumer implements IQueueConsumer<WebSubJob> {
  readonly messageTypes = ["youtube.websub"];

  constructor(
    @inject(DI_TOKENS.CloudflareEnv) private readonly env: StratalEnv,
    @InjectQueue("poll") private readonly poll: IQueueSender,
    @inject(SubscriptionsService)
    private readonly subscriptions: SubscriptionsService,
    @inject(WebSubService)
    private readonly webSub: WebSubService,
  ) {}

  async handle(message: QueueMessage<WebSubJob>) {
    let { channelId } = message.payload;
    let sub = await this.subscriptions.get<YouTubeSubscription>("youtube", channelId);
    if (!sub?.active) return;

    try {
      if (!this.env.SERVICE_URL) throw new Error("SERVICE_URL is not set");
      await this.webSub.subscribe(
        channelId,
        new URL("/webhooks/youtube", this.env.SERVICE_URL).href,
      );
      sub.lastSubscribedAt = new Date().toISOString();
      await this.subscriptions.save("youtube", sub);
    } catch (error) {
      if (sub.polling !== true) {
        sub.polling = true;
        await this.subscriptions.save("youtube", sub);
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
