import {
  AGENT_DEFAULTS,
  createPluginModuleLogger,
  fetchWithTimeout,
  kvService,
  type ServerEnv,
} from "@phantasy/agent/plugin-runtime";

import {
  readBoolean,
  readNumber,
  readOptionalString,
  readStringArray,
} from "./runtime/config-helpers";

const logger = createPluginModuleLogger("DiscordIntegration");

export interface DiscordConfig {
  botToken: string;
  token?: string;
  clientId: string;
  clientSecret?: string;
  publicKey?: string;
  guildId?: string;
  channelIds: string[];
  defaultChannelId?: string;
  allowedUserIds: string[];
  commandPrefix: string;
  enableCommands: boolean;
  enableAutoReply: boolean;
  enableMentionOnly: boolean;
  enableVoiceChat: boolean;
  replyDelay: number;
  autoStart?: boolean;
  connected?: boolean;
  botUsername?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNestedRecord(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  const next = value[key];
  return isRecord(next) ? next : {};
}

function getLegacyDiscordMetadata(agent: unknown): Partial<DiscordConfig> | undefined {
  const metadata = getNestedRecord(agent, "metadata");
  const discord = getNestedRecord(metadata, "discord");
  if (Object.keys(discord).length === 0) {
    return undefined;
  }

  return {
    commandPrefix: readOptionalString(discord.commandPrefix),
    enableCommands:
      typeof discord.enableCommands === "boolean" ? discord.enableCommands : undefined,
    enableAutoReply:
      typeof discord.enableAutoReply === "boolean" ? discord.enableAutoReply : undefined,
    channelIds: readStringArray(discord.channelIds),
    defaultChannelId: readOptionalString(discord.defaultChannelId),
    allowedUserIds: readStringArray(discord.allowedUserIds),
  };
}

function getDiscordIntegrationConfig(agent: unknown): Partial<DiscordConfig> | undefined {
  const integrations = getNestedRecord(agent, "integrations");
  const discord = getNestedRecord(integrations, "discord");
  if (Object.keys(discord).length === 0) {
    return undefined;
  }

  return {
    botToken: readOptionalString(discord.botToken) || readOptionalString(discord.token),
    token: readOptionalString(discord.token),
    clientId:
      readOptionalString(discord.clientId) || readOptionalString(discord.applicationId),
    clientSecret: readOptionalString(discord.clientSecret),
    publicKey: readOptionalString(discord.publicKey),
    guildId: readOptionalString(discord.guildId),
    channelIds: readStringArray(discord.channelIds),
    defaultChannelId: readOptionalString(discord.defaultChannelId),
    allowedUserIds: readStringArray(discord.allowedUserIds),
    commandPrefix: readOptionalString(discord.commandPrefix),
    enableCommands:
      typeof discord.enableCommands === "boolean" ? discord.enableCommands : undefined,
    enableAutoReply:
      typeof discord.enableAutoReply === "boolean" ? discord.enableAutoReply : undefined,
    enableMentionOnly:
      typeof discord.enableMentionOnly === "boolean"
        ? discord.enableMentionOnly
        : undefined,
    enableVoiceChat:
      typeof discord.enableVoiceChat === "boolean" ? discord.enableVoiceChat : undefined,
    replyDelay: typeof discord.replyDelay === "number" ? discord.replyDelay : undefined,
    autoStart: typeof discord.autoStart === "boolean" ? discord.autoStart : undefined,
    connected: typeof discord.connected === "boolean" ? discord.connected : undefined,
    botUsername: readOptionalString(discord.botUsername),
  };
}

function normalizeDiscordConfig(config: Partial<DiscordConfig>): DiscordConfig {
  return {
    botToken:
      readOptionalString(config.botToken) || readOptionalString(config.token) || "",
    token: readOptionalString(config.token),
    clientId: readOptionalString(config.clientId) || "",
    clientSecret: readOptionalString(config.clientSecret),
    publicKey: readOptionalString(config.publicKey),
    guildId: readOptionalString(config.guildId),
    channelIds: readStringArray(config.channelIds),
    defaultChannelId: readOptionalString(config.defaultChannelId),
    allowedUserIds: readStringArray(config.allowedUserIds),
    commandPrefix: readOptionalString(config.commandPrefix) || "!",
    enableCommands: readBoolean(config.enableCommands),
    enableAutoReply: readBoolean(config.enableAutoReply),
    enableMentionOnly: readBoolean(config.enableMentionOnly),
    enableVoiceChat: readBoolean(config.enableVoiceChat),
    replyDelay: readNumber(config.replyDelay, 2),
    autoStart: readBoolean(config.autoStart),
    connected: readBoolean(config.connected),
    botUsername: readOptionalString(config.botUsername),
  };
}

function getStoredAgentDiscordConfig(agent: unknown): DiscordConfig | null {
  const integrationConfig = getDiscordIntegrationConfig(agent);
  const legacyMetadata = getLegacyDiscordMetadata(agent);
  if (!integrationConfig && !legacyMetadata) {
    return null;
  }

  return normalizeDiscordConfig({
    ...legacyMetadata,
    ...integrationConfig,
  });
}

export class DiscordIntegration {
  constructor(private readonly env: ServerEnv) {}

  async getConfig(): Promise<DiscordConfig | null> {
    try {
      const storedConfig = await kvService.get("integration:discord");
      const config =
        isRecord(storedConfig) && Object.keys(storedConfig).length > 0
          ? normalizeDiscordConfig(storedConfig as Partial<DiscordConfig>)
          : getStoredAgentDiscordConfig(await kvService.get(AGENT_DEFAULTS.ID));

      if (!config?.botToken || !config.clientId) {
        return null;
      }

      return config;
    } catch (error) {
      logger.error("Failed to get Discord config:", error);
      return null;
    }
  }

  async saveConfig(config: DiscordConfig): Promise<boolean> {
    try {
      const normalizedConfig = normalizeDiscordConfig(config);
      if (!normalizedConfig.botToken || !normalizedConfig.clientId) {
        throw new Error("Discord bot token and client ID are required");
      }

      await kvService.set("integration:discord", normalizedConfig);

      const agent = (await kvService.get(AGENT_DEFAULTS.ID)) as Record<
        string,
        unknown
      > | null;
      if (agent) {
        const integrations = getNestedRecord(agent, "integrations");
        agent.metadata = {
          ...(isRecord(agent.metadata) ? agent.metadata : {}),
          discord: {
            commandPrefix: normalizedConfig.commandPrefix,
            enableCommands: normalizedConfig.enableCommands,
            enableAutoReply: normalizedConfig.enableAutoReply,
            channelIds: normalizedConfig.channelIds,
            defaultChannelId: normalizedConfig.defaultChannelId,
            allowedUserIds: normalizedConfig.allowedUserIds,
          },
        };
        agent.integrations = {
          ...integrations,
          discord: normalizedConfig,
        };
        await kvService.set(AGENT_DEFAULTS.ID, agent);
      }

      return true;
    } catch (error) {
      logger.error("Failed to save Discord config:", error);
      return false;
    }
  }

  async testConnection(config: Pick<DiscordConfig, "botToken" | "clientId">): Promise<{
    success: boolean;
    error?: string;
    botInfo?: { id?: string; username?: string };
  }> {
    try {
      const response = await fetchWithTimeout(
        "https://discord.com/api/v10/users/@me",
        {
          headers: {
            Authorization: `Bot ${config.botToken}`,
          },
        },
        10_000,
      );

      if (!response.ok) {
        return {
          success: false,
          error: `Discord API returned ${response.status}`,
        };
      }

      const botInfo = (await response.json()) as { id?: string; username?: string };
      return {
        success: true,
        botInfo,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async sendMessage(
    channelId: string,
    content: string,
    options: { replyTo?: string } = {},
  ): Promise<boolean> {
    const config = await this.getConfig();
    if (!config) {
      logger.error("No Discord config found");
      return false;
    }

    try {
      const body: Record<string, unknown> = { content };
      if (options.replyTo) {
        body.message_reference = { message_id: options.replyTo };
      }

      const response = await fetchWithTimeout(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${config.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        10_000,
      );

      return response.ok;
    } catch (error) {
      logger.error("Failed to send Discord message:", error);
      return false;
    }
  }
}
