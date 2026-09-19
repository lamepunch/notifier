import { Transient } from "stratal/di";

import { AdminCommand } from "@/commands/admin-command";

@Transient()
export class AdminAddCommand extends AdminCommand {
  static command =
    "admin add {provider : kick or youtube} {alias : Kick slug or YouTube handle} {--c|channel= : Discord channel id override} {--remote : Use the deployed Worker}";
  static description = "Add or update a subscription";

  handle(): Promise<number> | number {
    const provider = this.provider();
    if (!provider) return 1;
    const body: Record<string, string> = { alias: this.string("alias") };
    const channel = this.string("channel");
    if (channel) body.channel = channel;
    return this.runRequest(`/admin/subscriptions/${provider}`, {
      method: "POST",
      body,
    });
  }
}
