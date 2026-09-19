export interface YouTubeSubscription {
  id: string;
  name: string;
  url: string;
  active: boolean;
  icon?: string;
  channel?: string;
  lastSubscribedAt?: string;
  lastVerifiedAt?: string;
  polling?: boolean;
}

export interface YouTubeLookup {
  provider: "youtube";
  record: YouTubeSubscription;
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

export interface WebSubJob {
  channelId: string;
}

export interface YouTubePollJob {
  channelId: string;
}

export interface YouTubePlaylistItem {
  snippet?: {
    title?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    resourceId?: { videoId?: string };
  };
  contentDetails?: {
    videoId?: string;
    videoPublishedAt?: string;
  };
}

export interface YouTubePlaylistItemsResponse {
  items?: YouTubePlaylistItem[];
}

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
