export interface LivestreamStatusUpdated {
  broadcaster: {
    is_anonymous: boolean;
    user_id: number;
    username: string;
    is_verified: boolean | null;
    profile_picture: string;
    channel_slug: string;
    identity: any;
  };
  is_live: boolean;
  title: string;
  started_at: string;
  ended_at: string | null;
}

export interface Subscription {
  id: number;
  channel?: string;
  links?: Record<string, string>;
  mentions?: string[];
}
