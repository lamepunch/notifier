import type { YouTubePolling, YouTubeSubscription } from "@/types.d.ts";

/** `{ all, members }` when either flag is on; omitted from KV when both are false. */
function pollingFlags(
  all: boolean,
  members: boolean,
): YouTubePolling | undefined {
  if (!all && !members) return undefined;
  return { all, members };
}

export function setPollingFlags(
  sub: YouTubeSubscription,
  all: boolean,
  members: boolean,
): void {
  let polling = pollingFlags(all, members);
  if (polling) {
    sub.polling = polling;
  } else {
    delete sub.polling;
  }
}
