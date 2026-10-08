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
import type { YouTubeSubscription as YouTubeRecord } from "@/types/youtube";
import { SubscriptionsService } from "@/subscriptions";
import { YouTubePollEnqueueJob } from "@/youtube/jobs/poll-enqueue.job";
import { YouTubeSubscriptionRepository } from "@/youtube/subscription.repository";
import { WebSubService } from "@/youtube/websub.service";

const PROVIDERS: Provider[] = ["kick", "youtube"];
const YOUTUBE_ID_RE = /^UC[\w-]{22}$/;

@Transient()
export class AdminService {
  constructor(
    @inject(DI_TOKENS.CloudflareEnv) private readonly env: StratalEnv,
    @inject(WebSubService)
    private readonly webSub: WebSubService,
    @inject(YouTubePollEnqueueJob)
    private readonly pollJob: YouTubePollEnqueueJob,
    @inject(SubscriptionsService)
    private readonly subscriptions: SubscriptionsService,
    @inject(YouTubeSubscriptionRepository)
    private readonly youtube: YouTubeSubscriptionRepository,
  ) {}

  async list(provider?: string): Promise<Record<string, Record<string, unknown>>> {
    let names = provider ? [requireProvider(provider)] : PROVIDERS;
    let out: Record<string, Record<string, unknown>> = {};
    for (let name of names) {
      out[name] =
        name === "kick"
          ? Object.fromEntries(
              (await this.subscriptions.list<Subscription>("kick")).map((record) => [
                this.subscriptions.key("kick", record.id),
                record,
              ]),
            )
          : Object.fromEntries(
              (await this.youtube.list()).map((record) => [
                this.youtube.key(record.id),
                record,
              ]),
            );
    }
    return out;
  }

  async resyncYouTube() {
    return {
      message: "YouTube WebSub jobs enqueued",
      ...(await this.webSub.resync(true)),
    };
  }

  youtubeHubStatus() {
    return this.webSub.hubStatus();
  }

  async add(provider: string, alias: string, channel?: string) {
    let found = await lookupByAlias(requireProvider(provider), alias, this.env.YOUTUBE_TOKEN);
    if (found.provider === "youtube") {
      let record = await this.youtube.upsert(found.record, channel);
      await this.webSub.enqueue(record.id);
      return {
        [this.youtube.key(record.id)]: record,
        message: "YouTube WebSub job enqueued",
        channelId: found.record.id,
      };
    }
    return upsertKick(found.record, channel, this.subscriptions);
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
    let record = await this.youtube.setActive(id, active);
    if (!record) throw new HttpException(404, `No YouTube subscription for ${id}`);
    return { [this.youtube.key(id)]: record };
  }

  async setYouTubePolling(id: string, enabled: boolean) {
    requireYouTubeId(id);
    let record = await this.youtube.setPolling(id, enabled);
    if (!record) throw new HttpException(404, `No YouTube subscription for ${id}`);
    if (record.polling === true) await this.pollJob.poll(id);
    return { [this.youtube.key(id)]: record };
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

async function upsertKick(
  found: Subscription,
  channel: string | undefined,
  subscriptions: SubscriptionsService,
): Promise<Record<string, Subscription>> {
  let existing = await subscriptions.get<Subscription>("kick", found.id);
  let record: Subscription = { id: found.id, slug: found.slug, active: true };
  record.channel = channel || found.channel || existing?.channel;
  record.links = found.links || existing?.links;
  record.mentions = found.mentions || existing?.mentions;
  if (!record.channel) delete record.channel;
  if (!record.links) delete record.links;
  if (!record.mentions) delete record.mentions;
  await subscriptions.save("kick", record);
  return { [subscriptions.key("kick", record.id)]: record };
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
