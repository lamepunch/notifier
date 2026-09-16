import { AutoRouter, type IRequest } from "itty-router";

import type {
  LivestreamStatusUpdated,
  YouTubePollJob,
  YouTubeSubscribeJob,
} from "./types.d.ts";

import {
  handleWebSubVerification,
  notifyIfNewYouTubeVideo,
  parseYouTubeFeed,
} from "./events/youtube";
import { queue, scheduled } from "./scheduled";

import admin from "./admin";
import processWebhook from "./events/kick";

const router = AutoRouter<IRequest, [Env, ExecutionContext]>({
  missing: () => new Response(null, { status: 404 }),
});

router
  .all("/admin/*", admin.fetch)
  .get("/webhooks/youtube", (request) => handleWebSubVerification(request))
  .post("/webhooks/youtube", handleYouTubeFeedPost)
  .get("/", (request) => handleWebSubVerification(request))
  .post("*", handleWebhookPost);

async function handleYouTubeFeedPost(
  request: IRequest,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  return processYouTubeNotification(
    await request.text(),
    request.headers.get("Content-Type") || "",
    ctx,
  );
}

async function processYouTubeNotification(
  payload: string,
  contentType: string,
  ctx: ExecutionContext,
): Promise<Response> {
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
    await notifyIfNewYouTubeVideo(video, ctx);
  }

  return new Response();
}

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
    return processYouTubeNotification(payload, contentType, ctx);
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
} satisfies ExportedHandler<Env, YouTubeSubscribeJob | YouTubePollJob>;
