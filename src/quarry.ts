import { QuarryRunner } from "stratal/quarry/runner";

import { AppModule } from "@/app.module";
import {
  AdminActivateCommand,
  AdminAddCommand,
  AdminClient,
  AdminDeactivateCommand,
  AdminListCommand,
  AdminPollCommand,
  AdminResyncCommand,
  AdminTestCommand,
} from "@/commands";

export default QuarryRunner.run({
  imports: [AppModule],
  providers: [
    AdminClient,
    AdminListCommand,
    AdminAddCommand,
    AdminActivateCommand,
    AdminDeactivateCommand,
    AdminResyncCommand,
    AdminPollCommand,
    AdminTestCommand,
  ],
});
