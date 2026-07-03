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

import { handleDiscordPluginEndpoint } from "./discord-plugin-endpoints";
import { DiscordIntegration, type DiscordConfig } from "./discord-integration";
import { DiscordBotService } from "./runtime/discord-bot-service";
import { syncDiscordGatewaySessionAfterSend } from "./runtime/discord-gateway-session";
import { buildDiscordRuntimeConfig } from "./runtime/discord-plugin-config";
import { readOptionalString } from "./runtime/config-helpers";

const log = createPluginModuleLogger("DiscordPlugin");

type DiscordPluginConfig = PluginConfig & Partial<DiscordConfig>;

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
      enabled: { type: "boolean", default: true, title: "Enabled" },
      autoStart: {
        type: "boolean",
        default: false,
        title: "Auto-start",
        description:
          "Reconnect the Discord bot automatically when this integration is enabled.",
      },
      botToken: { type: "string", title: "Bot token", format: "password" },
      clientId: { type: "string", title: "Application / client ID" },
      clientSecret: { type: "string", title: "Client secret", format: "password" },
      publicKey: { type: "string", title: "Public key" },
      guildId: { type: "string", title: "Guild ID" },
      channelIds: {
        type: "array",
        title: "Channel IDs",
        items: { type: "string" },
        default: [],
      },
      defaultChannelId: { type: "string", title: "Default channel ID" },
      allowedUserIds: {
        type: "array",
        title: "Allowed user IDs",
        items: { type: "string" },
        default: [],
      },
      commandPrefix: { type: "string", default: "!", title: "Command prefix" },
      enableCommands: { type: "boolean", default: false, title: "Enable commands" },
      enableAutoReply: { type: "boolean", default: false, title: "Enable auto-reply" },
      enableMentionOnly: {
        type: "boolean",
        default: false,
        title: "Mention-only in channels",
      },
      enableVoiceChat: { type: "boolean", default: false, title: "Enable voice chat" },
      replyDelay: { type: "number", default: 2, title: "Reply delay (seconds)" },
    },
  };

  private botService: DiscordBotService | null = null;
  private lastActivity?: Date;

  getTools(): PluginTool[] {
    return [];
  }

  override async onInit(
    _agentConfig: Record<string, unknown>,
    config?: DiscordPluginConfig,
  ): Promise<void> {
    await super.onInit(_agentConfig, config);
    const runtimeConfig = await this.buildRuntimeConfig();
    if (runtimeConfig) {
      await this.createIntegration().saveConfig(runtimeConfig);
    }

    if (this.isEnabled() && runtimeConfig?.autoStart && !this.botService) {
      const result = await this.startBot();
      if (!result.success) {
        log.warn("Discord auto-start failed", { message: result.message });
      }
    }
  }

  async startBot(): Promise<{ success: boolean; message?: string }> {
    const runtimeConfig = await this.buildRuntimeConfig();
    if (!runtimeConfig) {
      return {
        success: false,
        message: "Set a Discord bot token and client ID before starting the integration.",
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
      connected: true,
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
      message: nextConfig.botUsername
        ? `Connected to Discord as ${nextConfig.botUsername}`
        : "Connected to Discord",
    };
  }

  async stopBot(): Promise<{ success: boolean; message?: string }> {
    if (this.botService) {
      await this.botService.stop();
      this.botService = null;
    }

    const runtimeConfig = await this.buildRuntimeConfig();
    if (runtimeConfig) {
      await this.createIntegration().saveConfig({
        ...runtimeConfig,
        connected: false,
      });
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
    summary?: string;
    configuredChannels?: string[];
    recommendedActions?: string[];
  }> {
    const runtimeConfig = await this.buildRuntimeConfig();
    if (!runtimeConfig) {
      return {
        connected: false,
        streaming: false,
        autonomousPosting: false,
        lastActivity: this.lastActivity,
        error: "Discord bot token or client ID not configured",
        summary: "Needs bot token and client ID",
        recommendedActions: [
          "Add DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID.",
          "Set a default channel ID or channel allowlist before enabling operator workflows.",
        ],
      };
    }

    const configuredChannels = Array.from(
      new Set(
        [runtimeConfig.defaultChannelId, ...runtimeConfig.channelIds].filter(
          Boolean,
        ) as string[],
      ),
    );

    if (this.botService) {
      const status = this.botService.getStatus();
      return {
        connected: status.connected,
        streaming: false,
        autonomousPosting: false,
        lastActivity: this.lastActivity,
        summary: status.connected
          ? runtimeConfig.botUsername
            ? `Connected as ${runtimeConfig.botUsername}`
            : "Connected"
          : "Configured, reconnecting",
        configuredChannels,
        recommendedActions:
          configuredChannels.length === 0
            ? ["Add a default channel ID or explicit channel allowlist."]
            : [],
      };
    }

    const storedConfig = await this.createIntegration().getConfig();
    const connected = Boolean(storedConfig?.connected);
    return {
      connected,
      streaming: false,
      autonomousPosting: false,
      lastActivity: this.lastActivity,
      error: connected ? undefined : "Discord bot is not connected",
      summary: connected ? "Configured" : "Configured, not running",
      configuredChannels,
      recommendedActions: [
        "Start the integration after configuring Discord credentials.",
      ],
    };
  }

  async sendMessage(params: {
    content: string;
    channelId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const runtimeConfig = await this.buildRuntimeConfig();
    const channelId =
      params.channelId || runtimeConfig?.defaultChannelId || runtimeConfig?.channelIds[0];

    if (!runtimeConfig || !channelId) {
      return {
        success: false,
        error: "Discord default channel is not configured",
      };
    }

    const sessionId = readOptionalString(params.metadata?.sessionId);
    const gatewayThreadId = readOptionalString(
      params.metadata?.gatewayThreadId,
      params.metadata?.threadId,
    );
    const channelUserId = readOptionalString(params.metadata?.userId);
    const guildId = readOptionalString(params.metadata?.guildId);

    const result = this.botService
      ? await this.botService.sendMessage(channelId, params.content, {
          sessionId,
          gatewayThreadId,
          channelUserId,
          guildId,
        })
      : await this.createIntegration()
          .sendMessage(channelId, params.content, {
            replyTo:
              typeof params.metadata?.messageId === "string"
                ? params.metadata.messageId
                : undefined,
          })
          .then((success) => ({
            success,
            ...(success ? {} : { error: "Failed to send Discord message" }),
          }));

    if (result.success) {
      this.lastActivity = new Date();
      if (!this.botService) {
        await syncDiscordGatewaySessionAfterSend(channelId, {
          sessionId,
          gatewayThreadId,
          channelUserId,
          guildId,
        });
      }
    }

    return result;
  }

  async onConfigUpdated(newConfig: PluginConfig): Promise<void> {
    await super.onConfigUpdated(newConfig);
    const runtimeConfig = await this.buildRuntimeConfig();
    if (runtimeConfig) {
      await this.createIntegration().saveConfig(runtimeConfig);
    }
  }

  async handleCustomEndpoint(request: Request, path: string): Promise<Response | null> {
    try {
      return handleDiscordPluginEndpoint(this, request, path);
    } catch (error) {
      log.error("Discord plugin endpoint failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return new Response(
        JSON.stringify({ success: false, error: "Discord plugin request failed" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  async testConnection(config: Pick<DiscordConfig, "botToken" | "clientId">): Promise<{
    success: boolean;
    error?: string;
    botInfo?: { id?: string; username?: string };
  }> {
    return this.createIntegration().testConnection(config);
  }

  async buildRuntimeConfig(
    overrides?: Partial<DiscordConfig>,
  ): Promise<DiscordConfig | null> {
    const snapshot = (this.getConfig() || {}) as DiscordPluginConfig;
    const stored = await this.createIntegration().getConfig();
    return buildDiscordRuntimeConfig({ overrides, snapshot, stored });
  }

  private createIntegration(): DiscordIntegration {
    return new DiscordIntegration(this.getRuntimeEnv());
  }

  private getRuntimeEnv(): ServerEnv {
    return getPluginRuntimeEnv() as unknown as ServerEnv;
  }
}

export default DiscordPlugin;
