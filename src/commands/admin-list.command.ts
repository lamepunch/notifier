import { Transient } from "stratal/di";

import { AdminCommand } from "@/commands/admin-command";

@Transient()
export class AdminListCommand extends AdminCommand {
  static command =
    "admin list {provider? : kick or youtube} {--remote : Use the deployed Worker}";
  static description = "List stored subscriptions";

  handle(): Promise<number> {
    const value = this.string("provider");
    if (!value) return this.runRequest("/admin/subscriptions");
    const provider = this.provider();
    return provider
      ? this.runRequest(`/admin/subscriptions/${provider}`)
      : Promise.resolve(1);
  }
}
