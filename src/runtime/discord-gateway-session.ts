import {
  createPluginModuleLogger,
  PhantasyGatewayService,
} from "@phantasy/agent/plugin-runtime";

const log = createPluginModuleLogger("DiscordGatewaySession");

export async function syncDiscordGatewaySessionAfterSend(
  channelId: string,
  options: {
    channelUserId?: string;
    gatewayThreadId?: string;
    guildId?: string;
    sessionId?: string;
  },
): Promise<void> {
  try {
    if (options.sessionId) {
      await PhantasyGatewayService.touchSession(options.sessionId, {
        metadata: {
          channelId,
          guildId: options.guildId,
        },
      });
      return;
    }

    if (!options.gatewayThreadId) {
      return;
    }

    await PhantasyGatewayService.ensureSession({
      channel: "discord",
      channelUserId: options.channelUserId,
      threadId: options.gatewayThreadId,
      metadata: {
        channelId,
        guildId: options.guildId,
      },
    });
  } catch (error) {
    log.warn("Failed to update Discord gateway session after outbound send", {
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
