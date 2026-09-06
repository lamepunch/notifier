export const KICK_PREFIX = "kick:";
export const YOUTUBE_PREFIX = "youtube:";

export function kickKey(userId: number): string {
  return `${KICK_PREFIX}${userId}`;
}

export function youtubeKey(channelId: string): string {
  return `${YOUTUBE_PREFIX}${channelId}`;
}
