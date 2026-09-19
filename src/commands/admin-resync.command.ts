import { Transient } from "stratal/di";

import { AdminCommand } from "@/commands/admin-command";

@Transient()
export class AdminResyncCommand extends AdminCommand {
  static command = "admin resync {--remote : Use the deployed Worker}";
  static description =
    "Enqueue WebSub resubscribe for all active YouTube channels";

  handle(): Promise<number> {
    return this.runRequest("/admin/subscriptions/youtube/resync", {
      method: "POST",
    });
  }
}
