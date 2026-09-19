import type { CronJob, ScheduledController } from "stratal/cron";
import { Transient, inject } from "stratal/di";
import { InjectQueue } from "stratal/queue";
import type { IQueueSender } from "stratal/queue";
import type { YouTubeSubscription } from "@/types/youtube";
import { SubscriptionsService } from "@/subscriptions";

@Transient()
export class YouTubePollEnqueueJob implements CronJob {
  static schedule = "*/15 * * * *";

  constructor(
    @InjectQueue("poll") private readonly polls: IQueueSender,
    @inject(SubscriptionsService)
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async execute(_controller: ScheduledController): Promise<void> {
    await this.enqueuePolls();
  }

  poll(channelId: string): Promise<void> {
    return this.polls.dispatch({
      type: "youtube.poll",
      payload: { channelId },
      metadata: { idempotencyKey: crypto.randomUUID() },
    });
  }

  async enqueuePolls(): Promise<{ count: number }> {
    let selected = (await this.subscriptions.list<YouTubeSubscription>("youtube")).filter(
      (sub) => sub.active && sub.polling === true,
    );
    for (let sub of selected) await this.poll(sub.id);
    return { count: selected.length };
  }
}
