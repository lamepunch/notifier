import { Module } from "stratal/module";
import { Router, type RouteConfigurable } from "stratal/router";

import { YouTubeModule } from "@/youtube/youtube.module";
import { AdminAuthMiddleware } from "@/admin/admin-auth.middleware";
import { AdminController } from "@/admin/admin.controller";
import { AdminService } from "@/admin/admin.service";

@Module({
  imports: [YouTubeModule],
  providers: [AdminService, AdminAuthMiddleware],
  controllers: [AdminController],
})
export class AdminModule implements RouteConfigurable {
  configureRoutes(router: Router): void {
    router.group([AdminController], (admin) =>
      admin.middleware(AdminAuthMiddleware),
    );
  }
}
