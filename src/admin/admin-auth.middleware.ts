import { DI_TOKENS, Transient, inject } from "stratal/di";
import type { StratalEnv } from "stratal";
import { HttpException } from "stratal/errors";
import type { Middleware, Next, RouterContext } from "stratal/router";

@Transient()
export class AdminAuthMiddleware implements Middleware {
  constructor(@inject(DI_TOKENS.CloudflareEnv) private readonly env: StratalEnv) {}

  async handle(ctx: RouterContext, next: Next): Promise<Response | void> {
    if (!authorize(ctx.c.req.raw, this.env.ADMIN_TOKEN)) {
      throw new HttpException(401, "Unauthorized");
    }
    return next();
  }
}

function authorize(request: Request, adminToken?: string): boolean {
  if (!adminToken) return false;
  let header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  let encoder = new TextEncoder();
  let provided = encoder.encode(header.slice("Bearer ".length));
  let expected = encoder.encode(adminToken);
  if (provided.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(provided, expected);
}
