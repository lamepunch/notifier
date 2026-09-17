import { AutoRouter, type IRequest } from "itty-router";

import type {
  LivestreamStatusUpdated,
  YouTubePollJob,
  YouTubeSubscribeJob,
} from "./types.d.ts";

import {
  handleYouTubeVerification,
  parseYouTubeFeed,
} from "./events/youtube/webhooks";
import { notifyIfNewYouTubeVideo } from "./events/youtube/notifications";
import { queue, scheduled } from "./scheduled";

import admin from "./admin";
import processWebhook from "./events/kick";

const router = AutoRouter<IRequest, [Env, ExecutionContext]>({
  missing: () => new Response(null, { status: 404 }),
});

router
  .all("/admin/*", admin.fetch)
  .get("/webhooks/youtube", handleYouTubeVerification)
  .post("/webhooks/youtube", handleYouTubeNotification)
  .post("/webhooks/kick", handleKickNotification);

async function handleYouTubeNotification(
  request: IRequest,
  _env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let payload = await request.text();
  let contentType = request.headers.get("Content-Type") || "";

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
    await notifyIfNewYouTubeVideo(video, ctx, true);
  }

  return new Response();
}

async function handleKickNotification(
  request: IRequest,
  _env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let payload = await request.text();
  let eventType = request.headers.get("Kick-Event-Type");

  // @TODO: verify webhook signature

  let isKickLivestream = eventType === "livestream.status.updated";

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
  }

  return new Response();
}

export default {
  ...router,
  scheduled,
  queue,
} satisfies ExportedHandler<Env, YouTubeSubscribeJob | YouTubePollJob>;
