import { Transient } from "stratal/di";

import { AdminCommand } from "@/commands/admin-command";

@Transient()
export class AdminActivateCommand extends AdminCommand {
  static command =
    "admin activate {provider : kick or youtube} {id : Subscription id} {--remote : Use the deployed Worker}";
  static description = "Set a subscription active";

  handle(): Promise<number> | number {
    const provider = this.provider();
    if (!provider) return 1;
    return this.runRequest(
      `/admin/subscriptions/${provider}/${encodeURIComponent(this.string("id"))}/status/activate`,
      { method: "POST" },
    );
  }
}
