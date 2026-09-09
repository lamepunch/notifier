import type {
  LivestreamStatusUpdated,
  YouTubeSubscribeJob,
  YouTubeSubscription,
} from "./types.d.ts";

import { processWebhook } from "./events/kick";
import { queue, scheduled } from "./scheduled";
import {
  handleWebSubVerification,
  parseYouTubeFeed,
  processYouTubeUpload,
} from "./events/youtube";
import { youtubeKey } from "./kv";

const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // Handle WebSub subscription verification
    if (request.method === "GET") {
      return handleWebSubVerification(request);
    }

    // Deny everything else besides POST requests
    if (request.method !== "POST") {
      return new Response(null, { status: 404 });
    }

    let payload = await request.text();
    let eventType = request.headers.get("Kick-Event-Type");
    let contentType = request.headers.get("Content-Type") || "";

    // Verify webhook signature
    // TODO!

    if (eventType === "livestream.status.updated") {
      let data = JSON.parse(payload) as LivestreamStatusUpdated;

      // We only care when the stream is actually going live (not when it's ending).
      if (data.is_live) {
        try {
          ctx.waitUntil(processWebhook(data));
        } catch (error) {
          // Encountered an error, log it and return a success response
          // since we don't want Kick to stop sending us events.
          console.error(error);
        }
      }

      return new Response();
    }

    // YouTube PubSubHubbub sends Atom feed notifications
    if (contentType.includes("xml") || contentType.includes("atom")) {
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

        let isSubscribed = !!sub?.active;

        // Pings also fire for edits of old videos and are retried by the
        // hub, so "new upload" means: published recently AND not already
        // sent (tracked in KV).
        let isRecent =
          Date.now() - new Date(video.published).getTime() < ONE_DAY_IN_MS;

        let sentKey = `youtube_video_sent:${video.videoId}`;

        let alreadySent =
          isSubscribed && isRecent
            ? (await env.SUBSCRIPTIONS.get(sentKey)) !== null
            : false;

        // Only accept videos where we can find a matching subscription
        // and we haven't sent a notification yet.
        let accepted = isSubscribed && isRecent && !alreadySent;

        console.log({
          message: accepted
            ? "Video accepted, sending notification"
            : "Video skipped",
          videoId: video.videoId,
          channelId: video.channelId,
          published: video.published,
          updated: video.updated,
          isSubscribed,
          isRecent,
          alreadySent,
        });

        if (accepted && sub) {
          // ponytail: KV is eventually consistent, so pings landing in
          // different colos within ~60s could double-send; a Durable
          // Object would make this exactly-once if that ever matters.
          await env.SUBSCRIPTIONS.put(sentKey, video.published, {
            expirationTtl: 7 * 24 * 60 * 60,
          });
          try {
            ctx.waitUntil(processYouTubeUpload(video, sub));
          } catch (error) {
            console.error(error);
          }
        }
      }

      return new Response();
    }

    console.log({
      message: "POST request matched no handler",
      eventType,
      contentType,
      payload,
    });
    return new Response();
  },

  scheduled,
  queue,
} satisfies ExportedHandler<Env, YouTubeSubscribeJob>;
