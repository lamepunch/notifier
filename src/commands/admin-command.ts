import { inject, Transient } from "stratal/di";
import { Command } from "stratal/quarry";

import { AdminClient } from "@/commands/admin.client";

export const PROVIDERS = ["kick", "youtube"] as const;
export type Provider = (typeof PROVIDERS)[number];

@Transient()
export abstract class AdminCommand extends Command {
  constructor(@inject(AdminClient) protected readonly client: AdminClient) {
    super();
  }

  protected provider(name = "provider"): Provider | undefined {
    const value = this.string(name);
    if ((PROVIDERS as readonly string[]).includes(value)) {
      return value as Provider;
    }
    this.fail(`${name} must be one of: ${PROVIDERS.join(", ")}`);
    return undefined;
  }

  protected remote(): boolean {
    return this.boolean("remote");
  }

  protected json(value: unknown): void {
    this.line(JSON.stringify(value, null, 2));
  }

  protected async runRequest(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<number> {
    try {
      this.json(await this.client.request(this.remote(), path, init));
      return 0;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
}
