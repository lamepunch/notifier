import type { CronJob, ScheduledController } from "stratal/cron";
import { Transient, inject } from "stratal/di";
import { InjectQueue } from "stratal/queue";
import type { IQueueSender } from "stratal/queue";
import type { YouTubeSubscription } from "@/types/youtube";
import { SubscriptionsService } from "@/subscriptions";

const WEBSUB_LEASE_IN_MS = 864_000 * 1_000;
// Renew before expiry; must exceed the daily cron interval or leases lapse.
const RENEW_MARGIN_IN_MS = 2 * 24 * 60 * 60 * 1_000;

@Transient()
export class DailyYouTubeRefreshJob implements CronJob {
  static schedule = "0 0 * * *";

  constructor(
    @InjectQueue("websub")
    private readonly subscriptions: IQueueSender,
    @inject(SubscriptionsService)
    private readonly stores: SubscriptionsService,
  ) {}

  async execute(_controller: ScheduledController): Promise<void> {
    await this.enqueueSubscriptions();
  }

  subscribe(channelId: string): Promise<void> {
    return this.subscriptions.dispatch({
      type: "youtube.websub",
      payload: { channelId },
      metadata: { idempotencyKey: crypto.randomUUID() },
    });
  }

  async enqueueSubscriptions(
    force = false,
  ): Promise<{ count: number; skipped: number; active: number }> {
    let active = (await this.stores.list<YouTubeSubscription>("youtube")).filter(
      (sub) => sub.active,
    );
    let selected = force
      ? active
      : active.filter((sub) => {
          let timestamp = Date.parse(sub.lastSubscribedAt ?? "");
          return (
            !sub.lastSubscribedAt ||
            !Number.isFinite(timestamp) ||
            Date.now() - timestamp >= WEBSUB_LEASE_IN_MS - RENEW_MARGIN_IN_MS
          );
        });
    for (let sub of selected) await this.subscribe(sub.id);
    return {
      count: selected.length,
      skipped: active.length - selected.length,
      active: active.length,
    };
  }
}
