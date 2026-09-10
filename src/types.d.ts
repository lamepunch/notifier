export interface LivestreamStatusUpdated {
  broadcaster: {
    is_anonymous: boolean;
    user_id: number;
    username: string;
    is_verified: boolean | null;
    profile_picture: string;
    channel_slug: string;
    identity: unknown;
  };
  is_live: boolean;
  title: string;
  started_at: string;
  ended_at: string | null;
}

export interface Subscription {
  id: number;
  slug: string;
  active: boolean;
  channel?: string;
  links?: Record<string, string>;
  mentions?: string[];
}

export interface YouTubeSubscription {
  id: string;
  name: string;
  url: string;
  active: boolean;
  icon?: string;
  channel?: string;
  lastSubscribedAt?: string;
}

export interface YouTubeVideo {
  videoId: string;
  title: string;
  channelId: string;
  channelName: string;
  published: string;
  updated: string;
  videoUrl: string;
}

export interface YouTubeFeedEntry {
  "yt:videoId"?: string;
  "yt:channelId"?: string;
  title?: string;
  published?: string;
  updated?: string;
  author?: { name?: string };
}

export interface YouTubeFeed {
  feed?: { entry?: YouTubeFeedEntry | YouTubeFeedEntry[] };
}

export interface YouTubeSubscribeJob {
  channelId: string;
}

export type Provider = "kick" | "youtube";

export interface KickLookup {
  provider: "kick";
  record: Subscription;
}

export interface YouTubeLookup {
  provider: "youtube";
  record: YouTubeSubscription;
}

export type LookupResult = KickLookup | YouTubeLookup;

export interface YouTubeTarget {
  id?: string;
  handle?: string;
}

export interface YouTubeChannelThumbnails {
  default?: { url?: string };
  medium?: { url?: string };
  high?: { url?: string };
}

export interface YouTubeChannelSnippet {
  title?: string;
  customUrl?: string;
  thumbnails?: YouTubeChannelThumbnails;
}

export interface YouTubeChannelListItem {
  id?: string;
  snippet?: YouTubeChannelSnippet;
}

export interface YouTubeChannelListResponse {
  items?: YouTubeChannelListItem[];
}

export interface KickChannelResponse {
  user_id?: number;
  slug?: string;
}
