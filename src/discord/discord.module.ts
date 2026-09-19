import { Module } from "stratal/module";

import { DiscordService } from "@/discord/discord.service";

@Module({ providers: [DiscordService] })
export class DiscordModule {}
