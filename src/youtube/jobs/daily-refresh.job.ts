import type { CronJob, ScheduledController } from "stratal/cron";
import { Transient, inject } from "stratal/di";
import { WebSubService } from "@/youtube/websub.service";

@Transient()
export class DailyYouTubeRefreshJob implements CronJob {
  static schedule = "0 0 * * *";

  constructor(@inject(WebSubService) private readonly webSub: WebSubService) {}

  async execute(_controller: ScheduledController): Promise<void> {
    await this.webSub.resync();
  }
}
