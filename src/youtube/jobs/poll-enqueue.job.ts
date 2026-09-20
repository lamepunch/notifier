import type { CronJob, ScheduledController } from "stratal/cron";
import { Transient, inject } from "stratal/di";
import { LOGGER_TOKENS } from "stratal/logger";
import type { LoggerService } from "stratal/logger";
import { InjectQueue } from "stratal/queue";
import type { IQueueSender } from "stratal/queue";
import type { YouTubeSubscription } from "@/types/youtube";
import { SubscriptionsService } from "@/subscriptions";

/**
 * Enqueues the polling fallback for active YouTube channels with WebSub issues.
 */
@Transient()
export class YouTubePollEnqueueJob implements CronJob {
  static schedule = "*/15 * * * *";

  constructor(
    @InjectQueue("poll") private readonly polls: IQueueSender,
    @inject(SubscriptionsService)
    private readonly subscriptions: SubscriptionsService,
    @inject(LOGGER_TOKENS.LoggerService)
    private readonly logger: LoggerService,
  ) {}

  async execute(_controller: ScheduledController): Promise<void> {
    await this.enqueuePolls("cron");
  }

  poll(channelId: string, source = "admin"): Promise<void> {
    this.logger.info("YouTube polling channel queued", { channelId, source });
    return this.polls.dispatch({
      type: "youtube.poll",
      payload: { channelId },
      metadata: { idempotencyKey: crypto.randomUUID() },
    });
  }

  // Queue active YouTube channels whose WebSub subscriptions use polling fallback.
  async enqueuePolls(source = "cron"): Promise<{ count: number }> {
    let selected = (await this.subscriptions.list<YouTubeSubscription>("youtube")).filter(
      (sub) => sub.active && sub.polling === true,
    );
    for (let sub of selected) await this.poll(sub.id, source);
    return { count: selected.length };
  }
}
