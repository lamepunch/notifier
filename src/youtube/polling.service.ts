import { DI_TOKENS, Transient, inject } from "stratal/di";
import type { StratalEnv } from "stratal";

import type {
  YouTubePlaylistItem,
  YouTubePlaylistItemsResponse,
  YouTubeVideo,
} from "@/types/youtube";

const YOUTUBE_PLAYLIST_ITEMS_URL =
  "https://www.googleapis.com/youtube/v3/playlistItems";

@Transient()
export class YouTubePollingService {
  constructor(@inject(DI_TOKENS.CloudflareEnv) private readonly env: StratalEnv) {}

  async fetchUploadsPlaylistVideos(channelId: string): Promise<YouTubeVideo[]> {
    if (!this.env.YOUTUBE_TOKEN) throw new Error("YOUTUBE_TOKEN is not set");
    let params = new URLSearchParams({
      part: "snippet,contentDetails",
      maxResults: "3",
      playlistId: `UU${channelId.slice(2)}`,
      key: this.env.YOUTUBE_TOKEN,
    });
    let response = await fetch(`${YOUTUBE_PLAYLIST_ITEMS_URL}?${params}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        `YouTube playlistItems.list failed: ${response.status} ${await response.text()}`,
      );
    }
    let data = (await response.json()) as YouTubePlaylistItemsResponse;
    return this.videosFromPlaylistItems(data.items ?? []);
  }

  private videosFromPlaylistItems(items: YouTubePlaylistItem[]): YouTubeVideo[] {
    return items.flatMap((item) => {
      let videoId =
        item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
      let title = item.snippet?.title;
      let channelId = item.snippet?.channelId;
      let published =
        item.contentDetails?.videoPublishedAt ??
        item.snippet?.publishedAt ??
        "";
      if (!videoId || !title || !channelId) return [];
      return [
        {
          videoId,
          title,
          channelId,
          published,
          updated: published,
          channelName: item.snippet?.channelTitle ?? "YouTube",
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        },
      ];
    });
  }
}
