export const KICK_PREFIX = "kick:";
export const YOUTUBE_PREFIX = "youtube:";
export const YOUTUBE_VIDEO_SENT_PREFIX = "youtube_video_sent:";

export function youtubeVideoSentKey(videoId: string): string {
  return `${YOUTUBE_VIDEO_SENT_PREFIX}${videoId}`;
}
