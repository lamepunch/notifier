import type { YouTubeLookup } from "@/types/youtube";

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

export type Provider = "kick" | "youtube";

export interface KickLookup {
  provider: "kick";
  record: Subscription;
}

export type LookupResult = KickLookup | YouTubeLookup;

export interface KickChannelResponse {
  user_id?: number;
  slug?: string;
}
