import { Transient } from "stratal/di";

import { AdminCommand } from "@/commands/admin-command";

@Transient()
export class AdminPollCommand extends AdminCommand {
  static command =
    "admin poll {provider : youtube} {id : YouTube channel id} {--on : Enable polling} {--off : Disable polling} {--remote : Use the deployed Worker}";
  static description = "Set YouTube polling on a subscription";

  handle(): Promise<number> | number {
    const provider = this.provider();
    if (!provider) return 1;
    if (provider !== "youtube") {
      this.fail("poll is only supported for youtube");
      return 1;
    }

    const on = this.boolean("on");
    const off = this.boolean("off");
    if (on === off) {
      this.fail("specify exactly one of --on or --off");
      return 1;
    }

    return this.runRequest(
      `/admin/subscriptions/youtube/${encodeURIComponent(this.string("id"))}/poll`,
      { method: "POST", body: { polling: on } },
    );
  }
}
