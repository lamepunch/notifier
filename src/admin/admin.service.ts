import { DI_TOKENS, inject, Transient } from "stratal/di";
import type { StratalEnv } from "stratal";
import type {
  YouTubeChannelListResponse,
  YouTubeTarget,
} from "@/types/youtube";
import type {
  KickChannelResponse,
  LookupResult,
  Provider,
  Subscription,
} from "@/types";
import { HttpException } from "stratal/errors";
import { DailyYouTubeRefreshJob } from "@/youtube/jobs/daily-refresh.job";
import { YouTubePollEnqueueJob } from "@/youtube/jobs/poll-enqueue.job";
import {
  SubscriptionsService,
  type YouTubeSubscription as YouTubeRecord,
} from "@/subscriptions";

const PROVIDERS: Provider[] = ["kick", "youtube"];
const YOUTUBE_ID_RE = /^UC[\w-]{22}$/;

@Transient()
export class AdminService {
  constructor(
    @inject(DI_TOKENS.CloudflareEnv) private readonly env: StratalEnv,
    @inject(DailyYouTubeRefreshJob)
    private readonly refreshJob: DailyYouTubeRefreshJob,
    @inject(YouTubePollEnqueueJob)
    private readonly pollJob: YouTubePollEnqueueJob,
    @inject(SubscriptionsService)
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async list(provider?: string): Promise<Record<string, Record<string, unknown>>> {
    let names = provider ? [requireProvider(provider)] : PROVIDERS;
    let out: Record<string, Record<string, unknown>> = {};
    for (let name of names) {
      let records =
        name === "kick"
          ? await this.subscriptions.list<Subscription>("kick")
          : await this.subscriptions.list<YouTubeRecord>("youtube");
      out[name] = Object.fromEntries(
        records.map((record) => [
          name === "kick"
            ? this.subscriptions.key("kick", record.id as number)
            : this.subscriptions.key("youtube", record.id as string),
          record,
        ]),
      );
    }
    return out;
  }

  async resyncYouTube() {
    if (!this.env.SERVICE_URL) throw new HttpException(500, "SERVICE_URL is not set");
    return {
      message: "YouTube WebSub jobs enqueued",
      ...(await this.refreshJob.enqueueSubscriptions(true)),
    };
  }

  /** Scrape the hub's subscription-details page for each active YouTube channel. */
  async youtubeHubStatus() {
    if (!this.env.SERVICE_URL) throw new HttpException(500, "SERVICE_URL is not set");
    let callback = new URL("/webhooks/youtube", this.env.SERVICE_URL).href;
    let subs = (await this.subscriptions.list<YouTubeRecord>("youtube")).filter(
      (sub) => sub.active,
    );
    let results = await Promise.all(
      subs.map(async (sub) => {
        let params = new URLSearchParams({
          "hub.callback": callback,
          "hub.topic": `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${sub.id}`,
          "hub.secret": "",
        });
        let response = await fetch(
          `https://pubsubhubbub.appspot.com/subscription-details?${params}`,
        );
        // ponytail: HTML scrape, breaks if Google changes the page layout
        let text = (await response.text()).replace(/<[^>]*>/g, "\n");
        let field = (label: string) =>
          text.match(new RegExp(`${label}\\s+([^\\n]*\\S)`))?.[1] ?? null;
        return {
          id: sub.id,
          name: sub.name,
          polling: sub.polling === true,
          lastSubscribedAt: sub.lastSubscribedAt ?? null,
          state: response.ok ? field("State") : `http ${response.status}`,
          expiresAt: field("Expiration time"),
          lastVerifiedAt: field("Last successful verification"),
          lastVerificationError: field("Last verification error"),
          lastDeliveryError: field("Last delivery error"),
        };
      }),
    );
    return {
      expired: results.filter((r) => r.state !== "verified").length,
      total: results.length,
      subscriptions: results,
    };
  }

  async add(provider: string, alias: string, channel?: string) {
    let found = await lookupByAlias(requireProvider(provider), alias, this.env.YOUTUBE_TOKEN);
    let written = await upsert(found, channel, this.subscriptions);
    if (found.provider === "youtube") {
      await this.refreshJob.subscribe(found.record.id);
      return {
        ...written,
        message: "YouTube WebSub job enqueued",
        channelId: found.record.id,
      };
    }
    return written;
  }

  async setActive(provider: string, id: string, active: boolean) {
    if (requireProvider(provider) === "kick") {
      let userId = Number(id);
      if (!Number.isInteger(userId))
        throw new HttpException(400, "id must be a Kick user id");
      let existing = await this.subscriptions.get<Subscription>("kick", userId);
      if (!existing) throw new HttpException(404, `No Kick subscription for ${id}`);
      let record: Subscription = { ...existing, active };
      await this.subscriptions.save("kick", record);
      return { [this.subscriptions.key("kick", userId)]: record };
    }
    requireYouTubeId(id);
    let existing = await this.subscriptions.get<YouTubeRecord>("youtube", id);
    if (!existing) throw new HttpException(404, `No YouTube subscription for ${id}`);
    let record: YouTubeRecord = { ...existing, active };
    await this.subscriptions.save("youtube", record);
    return { [this.subscriptions.key("youtube", id)]: record };
  }

  async setYouTubePolling(id: string, enabled: boolean) {
    requireYouTubeId(id);
    let existing = await this.subscriptions.get<YouTubeRecord>("youtube", id);
    if (!existing) throw new HttpException(404, `No YouTube subscription for ${id}`);
    let record: YouTubeRecord = { ...existing };
    if (enabled) record.polling = true;
    else delete record.polling;
    await this.subscriptions.save("youtube", record);
    if (record.polling === true) await this.pollJob.poll(id);
    return { [this.subscriptions.key("youtube", id)]: record };
  }
}

function requireProvider(value: string): Provider {
  if (!PROVIDERS.includes(value as Provider))
    throw new HttpException(400, `provider must be one of: ${PROVIDERS.join(", ")}`);
  return value as Provider;
}

function requireYouTubeId(id: string) {
  if (!YOUTUBE_ID_RE.test(id))
    throw new HttpException(400, "id must be a YouTube channel id");
}

async function lookupByAlias(
  provider: Provider,
  alias: string,
  youtubeToken?: string,
): Promise<LookupResult> {
  return provider === "kick"
    ? { provider, record: await lookupKick(alias) }
    : { provider, record: await lookupYouTube(alias, youtubeToken) };
}

async function upsert(
  found: LookupResult,
  channel?: string,
  subscriptions?: SubscriptionsService,
): Promise<Record<string, Subscription | YouTubeRecord>> {
  if (!subscriptions) throw new Error("SubscriptionsService is required");
  if (found.provider === "kick") {
    let existing = await subscriptions.get<Subscription>("kick", found.record.id);
    let record: Subscription = {
      id: found.record.id,
      slug: found.record.slug,
      active: true,
    };
    record.channel = channel || found.record.channel || existing?.channel;
    record.links = found.record.links || existing?.links;
    record.mentions = found.record.mentions || existing?.mentions;
    if (!record.channel) delete record.channel;
    if (!record.links) delete record.links;
    if (!record.mentions) delete record.mentions;
    await subscriptions.save("kick", record);
    return { [subscriptions.key("kick", record.id)]: record };
  }
  let existing = await subscriptions.get<YouTubeRecord>("youtube", found.record.id);
  let record: YouTubeRecord = {
    id: found.record.id,
    name: found.record.name,
    url: found.record.url,
    active: true,
  };
  if (found.record.icon) record.icon = found.record.icon;
  record.channel = channel || existing?.channel;
  if (!record.channel) delete record.channel;
  if (existing?.lastSubscribedAt) record.lastSubscribedAt = existing.lastSubscribedAt;
  if (existing?.lastVerifiedAt) record.lastVerifiedAt = existing.lastVerifiedAt;
  if (existing?.polling === true) record.polling = true;
  await subscriptions.save("youtube", record);
  return { [subscriptions.key("youtube", record.id)]: record };
}

async function upstreamError(url: string, response: Response): Promise<never> {
  let body = await response.text();
  throw new HttpException(502, `${url} failed: ${response.status} ${body.slice(0, 200)}`);
}

async function lookupKick(alias: string): Promise<Subscription> {
  let url = `https://kick.com/api/v2/channels/${encodeURIComponent(alias)}`;
  let response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) await upstreamError(url, response);
  let data = (await response.json()) as KickChannelResponse;
  if (typeof data.user_id !== "number")
    throw new HttpException(502, `Kick channel ${alias} has no user_id`);
  return { id: data.user_id, slug: data.slug || alias, active: true };
}

function parseYouTubeAlias(alias: string): YouTubeTarget {
  let value = alias.trim();
  if (YOUTUBE_ID_RE.test(value)) return { id: value };
  value = value.replace(/^https?:\/\//i, "").replace(/^(www\.|m\.)?youtube\.com\//i, "");
  let channel = value.match(/^channel\/(UC[\w-]{22})/);
  if (channel) return { id: channel[1] };
  value = value.replace(/^@/, "").replace(/[/?#].*$/, "");
  if (YOUTUBE_ID_RE.test(value)) return { id: value };
  if (!value) throw new HttpException(400, `Invalid YouTube alias: ${alias}`);
  return { handle: value };
}

async function lookupYouTube(alias: string, youtubeToken?: string): Promise<YouTubeRecord> {
  if (!youtubeToken) throw new HttpException(500, "YOUTUBE_TOKEN is not set");
  let target = parseYouTubeAlias(alias);
  let params = new URLSearchParams({ part: "snippet", key: youtubeToken });
  if (target.id) params.set("id", target.id);
  else if (target.handle) params.set("forHandle", target.handle);
  let url = `https://www.googleapis.com/youtube/v3/channels?${params}`;
  let response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok)
    await upstreamError("https://www.googleapis.com/youtube/v3/channels", response);
  let item = ((await response.json()) as YouTubeChannelListResponse).items?.[0];
  if (!item?.id || !item.snippet)
    throw new HttpException(404, `No YouTube channel for ${alias}`);
  let customUrl = item.snippet.customUrl;
  let record: YouTubeRecord = {
    id: item.id,
    name: item.snippet.title || target.handle || item.id,
    url: customUrl
      ? customUrl.startsWith("http")
        ? customUrl
        : `https://www.youtube.com/${customUrl.replace(/^\//, "")}`
      : `https://www.youtube.com/channel/${item.id}`,
    active: true,
  };
  let icon =
    item.snippet.thumbnails?.high?.url ||
    item.snippet.thumbnails?.medium?.url ||
    item.snippet.thumbnails?.default?.url;
  if (icon) record.icon = icon;
  return record;
}
