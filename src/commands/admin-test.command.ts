import { Transient } from "stratal/di";
import { Command } from "stratal/quarry";

import { PROVIDERS, type Provider } from "@/commands/admin-command";

@Transient()
export class AdminTestCommand extends Command {
  static command =
    "admin test {provider : kick or youtube} {alias : Kick slug or YouTube handle}";
  static description = "Print the test event stub";

  handle(): number {
    const provider = this.string("provider");
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      this.fail(`provider must be one of: ${PROVIDERS.join(", ")}`);
      return 1;
    }
    this.line(
      JSON.stringify(
        { stub: "postTestEvent", provider: provider as Provider, alias: this.string("alias") },
        null,
        2,
      ),
    );
    return 0;
  }
}
