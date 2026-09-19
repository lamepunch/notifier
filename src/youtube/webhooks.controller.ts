import { Controller, Get, Post, type RouterContext } from "stratal/router";
import { inject } from "stratal/di";
import { HttpException } from "stratal/errors";
import { z } from "stratal/validation";
import { WebSubService } from "@/youtube/websub.service";

const webSubVerification = z
  .object({
    "hub.mode": z.enum(["subscribe", "unsubscribe"]),
    "hub.topic": z.url(),
    "hub.challenge": z.string().min(1),
    "hub.lease_seconds": z.string().regex(/^\d+$/).optional(),
  })
  .refine(
    (query) =>
      query["hub.mode"] !== "subscribe" || query["hub.lease_seconds"] !== undefined,
    { message: "hub.lease_seconds is required when subscribing" },
  );

@Controller("/webhooks/youtube")
export class YouTubeWebhooksController {
  constructor(
    @inject(WebSubService)
    private readonly webSub: WebSubService,
  ) {}

  @Get("/", { query: webSubVerification })
  async verify(ctx: RouterContext): Promise<Response> {
    return this.webSub.verify(ctx);
  }

  @Post("/")
  async notify(ctx: RouterContext): Promise<Response> {
    return this.webSub.notify(ctx);
  }
}

@Controller("/")
/**
 * Fallback controller for verified callbacks that are still
 * pointed at the root endpoint.
 */
export class WebSubFallbackController {
  constructor(
    @inject(WebSubService)
    private readonly webSub: WebSubService,
  ) {}

  @Get("/")
  verify(ctx: RouterContext): Promise<Response> {
    // This request isn't a valid WebSub verification request, return a 404 instead
    if (!webSubVerification.safeParse(ctx.query()).success) {
      throw new HttpException(404, "Not found");
    }

    return this.webSub.verify(ctx);
  }

  @Post("/")
  async notify(ctx: RouterContext): Promise<Response> {
    return this.webSub.notify(ctx);
  }
}
