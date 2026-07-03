import type { DiscordConfig } from "./discord-integration";
import type { DiscordPlugin } from "./discord-plugin";

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleDiscordPluginEndpoint(
  plugin: DiscordPlugin,
  request: Request,
  path: string,
): Promise<Response | null> {
  if ((path === "/status" || path === "/bot-status") && request.method === "GET") {
    const runtimeConfig = await plugin.buildRuntimeConfig();
    const status = await plugin.getBotStatus();
    return jsonResponse({
      enabled: plugin.isEnabled(),
      connected: status.connected,
      error: status.error,
      summary: status.summary,
      lastActivity: status.lastActivity,
      botUsername: runtimeConfig?.botUsername || null,
      guildId: runtimeConfig?.guildId || null,
      channelIds: runtimeConfig?.channelIds || [],
      defaultChannelId: runtimeConfig?.defaultChannelId || null,
      allowedUserIds: runtimeConfig?.allowedUserIds || [],
      autoStart: runtimeConfig?.autoStart ?? false,
    });
  }

  if (path === "/start" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body && typeof body === "object" && "config" in body) {
      await plugin.updateConfig((body as { config: Record<string, unknown> }).config);
    }

    const result = await plugin.startBot();
    return jsonResponse(result, result.success ? 200 : 400);
  }

  if (path === "/stop" && request.method === "POST") {
    const result = await plugin.stopBot();
    return jsonResponse(result, result.success ? 200 : 400);
  }

  if ((path === "/test" || path === "/test-connection") && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const runtimeConfig = await plugin.buildRuntimeConfig(
      (body || {}) as Partial<DiscordConfig>,
    );

    if (!runtimeConfig) {
      return jsonResponse(
        {
          success: false,
          error: "Discord bot token and client ID are required",
        },
        400,
      );
    }

    const result = await plugin.testConnection(runtimeConfig);
    return jsonResponse(
      {
        ...result,
        connected: result.success,
        username: result.botInfo?.username,
        userId: result.botInfo?.id,
      },
      result.success ? 200 : 400,
    );
  }

  return null;
}
