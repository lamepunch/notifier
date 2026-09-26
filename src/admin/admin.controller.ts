import { z, type infer as Infer } from "stratal/validation";
import { inject } from "stratal/di";
import { Controller, Get, Post, type RouterContext } from "stratal/router";
import { AdminService } from "@/admin/admin.service";

const addSubscriptionBody = z.object({
  alias: z.string().trim().min(1),
  channel: z.string().trim().min(1).optional(),
});

const pollSubscriptionBody = z.object({
  polling: z.boolean(),
});

@Controller("/admin", { security: ["bearerAuth"] })
export class AdminController {
  constructor(@inject(AdminService) private readonly service: AdminService) {}

  @Get("/subscriptions", {
    summary: "List subscriptions",
    description: "List all stored Kick and YouTube subscriptions.",
  })
  async list(ctx: RouterContext) {
    return ctx.json(await this.service.list());
  }

  @Get("/subscriptions/:provider", {
    params: z.object({ provider: z.string() }),
    summary: "List provider subscriptions",
    description: "List stored subscriptions for a provider.",
  })
  async listProvider(ctx: RouterContext) {
    return ctx.json(await this.service.list(ctx.param("provider")));
  }

  @Get("/subscriptions/youtube/hub", {
    summary: "Check YouTube hub status",
    description: "Read WebSub hub state and lease expiry for all active YouTube channels.",
  })
  async hubStatus(ctx: RouterContext) {
    return ctx.json(await this.service.youtubeHubStatus());
  }

  @Post("/subscriptions/youtube/resync", {
    summary: "Resync YouTube subscriptions",
    description: "Enqueue WebSub subscription jobs for all active YouTube channels.",
  })
  async resync(ctx: RouterContext) {
    return ctx.json(await this.service.resyncYouTube());
  }

  @Post("/subscriptions/youtube/:id/poll", {
    params: z.object({ id: z.string() }),
    body: pollSubscriptionBody,
    summary: "Set YouTube polling",
    description: "Enable or disable polling fallback for a YouTube channel.",
  })
  async setPolling(ctx: RouterContext) {
    let body = await ctx.body<Infer<typeof pollSubscriptionBody>>();
    return ctx.json(await this.service.setYouTubePolling(ctx.param("id"), body.polling));
  }

  @Post("/subscriptions/:provider", {
    params: z.object({ provider: z.string() }),
    body: addSubscriptionBody,
    summary: "Add subscription",
    description: "Look up a provider alias and store a new active subscription.",
  })
  async add(ctx: RouterContext) {
    let body = await ctx.body<Infer<typeof addSubscriptionBody>>();
    return ctx.json(
      await this.service.add(ctx.param("provider"), body.alias, body.channel),
    );
  }

  @Post("/subscriptions/:provider/:id/status/:state", {
    params: z.object({
      provider: z.string(),
      id: z.string(),
      state: z.enum(["activate", "deactivate"]),
    }),
    summary: "Set subscription status",
    description: "Mark a stored subscription as active or inactive.",
  })
  async setStatus(ctx: RouterContext) {
    return ctx.json(
      await this.service.setActive(
        ctx.param("provider"),
        ctx.param("id"),
        ctx.param("state") === "activate",
      ),
    );
  }
}
