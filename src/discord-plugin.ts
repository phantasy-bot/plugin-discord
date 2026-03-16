import {
  BasePlugin,
  type PlatformCapability,
  type PluginConfig,
  type PluginTool,
} from "@phantasy/agent/plugins";
import {
  createPluginModuleLogger,
  getPluginRuntimeEnv,
  type ServerEnv,
} from "@phantasy/agent/plugin-runtime";

import {
  DiscordIntegration,
  type DiscordConfig,
} from "./discord-integration";
import { DiscordBotService } from "./runtime/discord-bot-service";

const log = createPluginModuleLogger("DiscordPlugin");

type DiscordPluginConfig = PluginConfig & Partial<DiscordConfig>;

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class DiscordPlugin extends BasePlugin implements PlatformCapability {
  name = "discord";
  version = "0.1.0";
  description = "Discord community and bot integration for Phantasy.";

  protected displayName = "Discord";
  protected category = "social";
  protected tags = ["discord", "community", "messaging", "bot"];
  protected permissions = ["internet"];
  protected workspace = "business" as const;
  protected extensionKind = "integration" as const;
  protected isPlatform = true;
  protected platformFeatures = {
    messaging: true,
    autonomous: false,
  } as const;
  protected adminSurface = {
    tabId: "discord",
    label: "Discord",
    section: "business",
    workspace: "business",
    kind: "generic",
    keywords: ["discord", "community", "messaging", "bot"],
    dashboardIcon: "discord",
  } as const;
  protected configSchema = {
    type: "object",
    properties: {
      enabled: { type: "boolean", default: true },
      botToken: { type: "string" },
      clientId: { type: "string" },
      clientSecret: { type: "string" },
      guildId: { type: "string" },
      channelIds: {
        type: "array",
        items: { type: "string" },
        default: [],
      },
      commandPrefix: { type: "string", default: "!" },
      enableCommands: { type: "boolean", default: false },
      enableAutoReply: { type: "boolean", default: false },
      enableMentionOnly: { type: "boolean", default: false },
      enableVoiceChat: { type: "boolean", default: false },
      replyDelay: { type: "number", default: 2 },
    },
  };

  private botService: DiscordBotService | null = null;
  private lastActivity?: Date;

  getTools(): PluginTool[] {
    return [];
  }

  async startBot(): Promise<{ success: boolean; message?: string }> {
    const runtimeConfig = await this.buildRuntimeConfig();
    if (!runtimeConfig) {
      return {
        success: false,
        message:
          "Set a Discord bot token and client ID before starting the integration.",
      };
    }

    const integration = this.createIntegration();
    const testResult = await integration.testConnection(runtimeConfig);
    if (!testResult.success) {
      return {
        success: false,
        message: testResult.error || "Failed to connect to Discord",
      };
    }

    const nextConfig = {
      ...runtimeConfig,
      botUsername: testResult.botInfo?.username || runtimeConfig.botUsername,
    };
    await integration.saveConfig(nextConfig);

    if (this.botService) {
      await this.botService.stop();
    }

    this.botService = new DiscordBotService(this.getRuntimeEnv(), nextConfig);
    await this.botService.start();
    this.lastActivity = new Date();

    return {
      success: true,
      message: testResult.botInfo?.username
        ? `Connected to Discord as ${testResult.botInfo.username}`
        : "Connected to Discord",
    };
  }

  async stopBot(): Promise<{ success: boolean; message?: string }> {
    if (this.botService) {
      await this.botService.stop();
      this.botService = null;
    }

    return {
      success: true,
      message: "Discord integration stopped",
    };
  }

  async getBotStatus(): Promise<{
    connected: boolean;
    streaming?: boolean;
    autonomousPosting?: boolean;
    lastActivity?: Date;
    error?: string;
  }> {
    const runtimeConfig = await this.buildRuntimeConfig();
    if (!runtimeConfig) {
      return {
        connected: false,
        streaming: false,
        autonomousPosting: false,
        lastActivity: this.lastActivity,
        error: "Discord bot token or client ID not configured",
      };
    }

    if (this.botService) {
      const status = this.botService.getStatus();
      return {
        connected: status.connected,
        streaming: false,
        autonomousPosting: false,
        lastActivity: this.lastActivity,
      };
    }

    const storedConfig = await this.createIntegration().getConfig();
    return {
      connected: Boolean(storedConfig?.connected),
      streaming: false,
      autonomousPosting: false,
      lastActivity: this.lastActivity,
      error: storedConfig?.connected
        ? undefined
        : "Discord bot is not connected",
    };
  }

  async onConfigUpdated(newConfig: PluginConfig): Promise<void> {
    await super.onConfigUpdated(newConfig);
    const runtimeConfig = await this.buildRuntimeConfig();
    if (runtimeConfig) {
      await this.createIntegration().saveConfig(runtimeConfig);
    }
  }

  async handleCustomEndpoint(
    request: Request,
    path: string,
  ): Promise<Response | null> {
    try {
      if (
        (path === "/status" || path === "/bot-status") &&
        request.method === "GET"
      ) {
        const runtimeConfig = await this.buildRuntimeConfig();
        const status = await this.getBotStatus();
        return jsonResponse({
          enabled: this.isEnabled(),
          connected: status.connected,
          error: status.error,
          lastActivity: status.lastActivity,
          botUsername: runtimeConfig?.botUsername || null,
          guildId: runtimeConfig?.guildId || null,
          channelIds: runtimeConfig?.channelIds || [],
        });
      }

      if (path === "/start" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (body && typeof body === "object" && body.config) {
          await this.updateConfig(body.config as Partial<DiscordPluginConfig>);
        }

        const result = await this.startBot();
        return jsonResponse(result, result.success ? 200 : 400);
      }

      if (path === "/stop" && request.method === "POST") {
        const result = await this.stopBot();
        return jsonResponse(result, result.success ? 200 : 400);
      }

      if (
        (path === "/test" || path === "/test-connection") &&
        request.method === "POST"
      ) {
        const body = await request.json().catch(() => ({}));
        const runtimeConfig = await this.buildRuntimeConfig(
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

        const result = await this.createIntegration().testConnection(runtimeConfig);
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
    } catch (error) {
      log.error("Discord plugin endpoint failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonResponse(
        { success: false, error: "Discord plugin request failed" },
        500,
      );
    }
  }

  private createIntegration(): DiscordIntegration {
    return new DiscordIntegration(this.getRuntimeEnv());
  }

  private getRuntimeEnv(): ServerEnv {
    return getPluginRuntimeEnv() as unknown as ServerEnv;
  }

  private getConfigSnapshot(): DiscordPluginConfig {
    return (this.getConfig() || {}) as DiscordPluginConfig;
  }

  private async buildRuntimeConfig(
    overrides?: Partial<DiscordConfig>,
  ): Promise<DiscordConfig | null> {
    const snapshot = this.getConfigSnapshot();
    const stored = await this.createIntegration().getConfig();
    const runtimeConfig: DiscordConfig = {
      botToken: readRequiredString(
        overrides?.botToken,
        snapshot.botToken,
        stored?.botToken,
        stored?.token,
      ),
      token: readOptionalString(overrides?.token, snapshot.token, stored?.token),
      clientId: readRequiredString(
        overrides?.clientId,
        snapshot.clientId,
        stored?.clientId,
      ),
      clientSecret: readOptionalString(
        overrides?.clientSecret,
        snapshot.clientSecret,
        stored?.clientSecret,
      ),
      guildId: readOptionalString(
        overrides?.guildId,
        snapshot.guildId,
        stored?.guildId,
      ),
      channelIds: readStringArray(
        overrides?.channelIds,
        snapshot.channelIds,
        stored?.channelIds,
      ),
      commandPrefix:
        readOptionalString(
          overrides?.commandPrefix,
          snapshot.commandPrefix,
          stored?.commandPrefix,
        ) || "!",
      enableCommands: readBoolean(
        overrides?.enableCommands,
        snapshot.enableCommands,
        stored?.enableCommands,
      ),
      enableAutoReply: readBoolean(
        overrides?.enableAutoReply,
        snapshot.enableAutoReply,
        stored?.enableAutoReply,
      ),
      enableMentionOnly: readBoolean(
        overrides?.enableMentionOnly,
        snapshot.enableMentionOnly,
        stored?.enableMentionOnly,
      ),
      enableVoiceChat: readBoolean(
        overrides?.enableVoiceChat,
        snapshot.enableVoiceChat,
        stored?.enableVoiceChat,
      ),
      replyDelay: readNumber(
        overrides?.replyDelay,
        snapshot.replyDelay,
        stored?.replyDelay,
        2,
      ),
      connected: stored?.connected,
      botUsername: readOptionalString(
        overrides?.botUsername,
        snapshot.botUsername,
        stored?.botUsername,
      ),
    };

    if (!runtimeConfig.botToken || !runtimeConfig.clientId) {
      return null;
    }

    return runtimeConfig;
  }
}

function readRequiredString(...values: Array<unknown>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "";
}

function readOptionalString(...values: Array<unknown>): string | undefined {
  const value = readRequiredString(...values);
  return value || undefined;
}

function readBoolean(...values: Array<unknown>): boolean {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }

  return false;
}

function readNumber(...values: Array<unknown>): number {
  const fallbackValue = values[values.length - 1];
  const candidates = values.slice(0, -1);

  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return typeof fallbackValue === "number" ? fallbackValue : 0;
}

function readStringArray(...values: Array<unknown>): string[] {
  for (const value of values) {
    if (!Array.isArray(value)) {
      continue;
    }

    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }

  return [];
}

export default DiscordPlugin;
