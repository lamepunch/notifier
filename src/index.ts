import { AutoRouter, type IRequest } from "itty-router";

import type {
  LivestreamStatusUpdated,
  YouTubeSubscribeJob,
  YouTubeSubscription,
} from "./types.d.ts";

import { youtubeKey, youtubeVideoSentKey } from "./kv";
import { queue, scheduled } from "./scheduled";
import {
  handleWebSubVerification,
  parseYouTubeFeed,
  processYouTubeUpload,
} from "./events/youtube";

import admin from "./admin";
import processWebhook from "./events/kick";

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;
const VIDEO_SENT_TTL_IN_S = 7 * 24 * 60 * 60;

const router = AutoRouter<IRequest, [Env, ExecutionContext]>({
  missing: () => new Response(null, { status: 404 }),
});

router
  .all("/admin/*", admin.fetch)
  .get("*", (request) => handleWebSubVerification(request))
  .post("*", handleWebhookPost);

async function handleWebhookPost(
  request: IRequest,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let payload = await request.text();
  let eventType = request.headers.get("Kick-Event-Type");
  let contentType = request.headers.get("Content-Type") || "";

  // @TODO: verify webhook signature

  let isKickLivestream = eventType === "livestream.status.updated";
  let isYouTubeFeed =
    contentType.includes("xml") || contentType.includes("atom");

  if (isKickLivestream) {
    let data = JSON.parse(payload) as LivestreamStatusUpdated;
    let isGoingLive = data.is_live;

    if (isGoingLive) {
      try {
        ctx.waitUntil(processWebhook(data));
      } catch (error) {
        console.error({
          message: "Kick webhook processing failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return new Response();
  } else if (isYouTubeFeed) {
    console.log({
      message: "YouTube notification received",
      contentType,
      payload,
    });

    let videos = parseYouTubeFeed(payload);

    console.log({
      message: "YouTube notification parsed",
      videoCount: videos.length,
    });

    for (let video of videos) {
      let sub = await env.SUBSCRIPTIONS.get<YouTubeSubscription>(
        youtubeKey(video.channelId),
        { type: "json" },
      );

      let isSubscribed: boolean = !!sub?.active;

      // Pings also fire for edits of old videos and are retried by the
      // hub, so "new upload" means: published recently AND not already
      // sent (tracked in KV).
      let isRecent: boolean =
        Date.now() - new Date(video.published).getTime() < ONE_DAY_IN_MS;

      let sentKey = youtubeVideoSentKey(video.videoId);

      let hasAlreadySent: boolean =
        isSubscribed && isRecent
          ? (await env.SUBSCRIPTIONS.get(sentKey)) !== null
          : false;

      let isAccepted: boolean = isSubscribed && isRecent && !hasAlreadySent;

      console.log({
        message: isAccepted
          ? "Video accepted, sending notification"
          : "Video skipped",
        videoId: video.videoId,
        channelId: video.channelId,
        published: video.published,
        updated: video.updated,
        isSubscribed,
        isRecent,
        hasAlreadySent,
      });

      if (isAccepted && sub) {
        // ponytail: KV is eventually consistent, so pings landing in
        // different colos within ~60s could double-send; a Durable
        // Object would make this exactly-once if that ever matters.
        await env.SUBSCRIPTIONS.put(sentKey, video.published, {
          expirationTtl: VIDEO_SENT_TTL_IN_S,
        });
        try {
          ctx.waitUntil(processYouTubeUpload(video, sub));
        } catch (error) {
          console.error({
            message: "YouTube upload processing failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return new Response();
  } else {
    console.log({
      message: "POST request matched no handler",
      eventType,
      contentType,
      payload,
    });
    return new Response();
  }
}

export default {
  ...router,
  scheduled,
  queue,
} satisfies ExportedHandler<Env, YouTubeSubscribeJob>;
