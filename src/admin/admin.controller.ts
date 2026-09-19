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

@Controller("/admin")
export class AdminController {
  constructor(@inject(AdminService) private readonly service: AdminService) {}

  @Get("/subscriptions")
  async list(ctx: RouterContext) {
    return ctx.json(await this.service.list());
  }

  @Get("/subscriptions/:provider", { params: z.object({ provider: z.string() }) })
  async listProvider(ctx: RouterContext) {
    return ctx.json(await this.service.list(ctx.param("provider")));
  }

  @Post("/subscriptions/youtube/resync")
  async resync(ctx: RouterContext) {
    return ctx.json(await this.service.resyncYouTube());
  }

  @Post("/subscriptions/youtube/:id/poll", {
    params: z.object({ id: z.string() }),
    body: pollSubscriptionBody,
  })
  async setPolling(ctx: RouterContext) {
    let body = await ctx.body<Infer<typeof pollSubscriptionBody>>();
    return ctx.json(await this.service.setYouTubePolling(ctx.param("id"), body.polling));
  }

  @Post("/subscriptions/:provider", {
    params: z.object({ provider: z.string() }),
    body: addSubscriptionBody,
  })
  async add(ctx: RouterContext) {
    let body = await ctx.body<Infer<typeof addSubscriptionBody>>();
    return ctx.json(
      await this.service.add(ctx.param("provider"), body.alias, body.channel),
    );
  }

  @Post("/subscriptions/:provider/:id/activate", {
    params: z.object({ provider: z.string(), id: z.string() }),
  })
  async activate(ctx: RouterContext) {
    return ctx.json(
      await this.service.setActive(ctx.param("provider"), ctx.param("id"), true),
    );
  }

  @Post("/subscriptions/:provider/:id/deactivate", {
    params: z.object({ provider: z.string(), id: z.string() }),
  })
  async deactivate(ctx: RouterContext) {
    return ctx.json(
      await this.service.setActive(ctx.param("provider"), ctx.param("id"), false),
    );
  }
}
