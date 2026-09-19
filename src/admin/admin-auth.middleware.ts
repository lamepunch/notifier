import { env } from "cloudflare:workers";
import { Transient } from "stratal/di";
import { HttpException } from "stratal/errors";
import type { Middleware, Next, RouterContext } from "stratal/router";

@Transient()
export class AdminAuthMiddleware implements Middleware {
  async handle(ctx: RouterContext, next: Next): Promise<Response | void> {
    if (!authorize(ctx.c.req.raw)) throw new HttpException(401, "Unauthorized");
    return next();
  }
}

function authorize(request: Request): boolean {
  if (!env.ADMIN_TOKEN) return false;
  let header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  let encoder = new TextEncoder();
  let provided = encoder.encode(header.slice("Bearer ".length));
  let expected = encoder.encode(env.ADMIN_TOKEN);
  if (provided.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(provided, expected);
}
