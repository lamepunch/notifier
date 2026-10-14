import { DI_TOKENS, Singleton, inject } from "stratal/di";
import type { StratalEnv } from "stratal";

import type { Subscription } from "@/types";
import { KICK_PREFIX, YOUTUBE_PREFIX } from "@/kv";
import type { Provider } from "@/types";

@Singleton()
export class SubscriptionsService {
  constructor(@inject(DI_TOKENS.CloudflareEnv) private readonly env: StratalEnv) {}

  key(provider: Provider, id: string | number): string {
    return `${this.prefix(provider)}${id}`;
  }

  get<T>(provider: Provider, id: string | number): Promise<T | null> {
    return this.env.subs.get<T>(this.key(provider, id), { type: "json" });
  }

  save<T extends { id: string | number }>(provider: Provider, record: T): Promise<void> {
    return this.env.subs.put(this.key(provider, record.id), JSON.stringify(record));
  }

  async list<T>(provider: Provider): Promise<T[]> {
    let prefix = this.prefix(provider);
    // Subscription counts are intentionally small; one page keeps this repository simple.
    let page = await this.env.subs.list({ prefix, limit: 100 });
    let values = await this.env.subs.get<T>(
      page.keys.map((entry) => entry.name),
      { type: "json" },
    );

    return [...values.values()].filter((value): value is T => value !== null);
  }

  private prefix(provider: Provider): string {
    return provider === "kick" ? KICK_PREFIX : YOUTUBE_PREFIX;
  }
}
