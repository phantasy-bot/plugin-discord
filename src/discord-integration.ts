import {
  AGENT_DEFAULTS,
  createPluginModuleLogger,
  fetchWithTimeout,
  kvService,
} from "@phantasy/agent/plugin-runtime";

type IntegrationPluginPermissions = Record<string, unknown>;

const logger = createPluginModuleLogger("DiscordIntegration");

export interface DiscordConfig {
  botToken: string;
  token?: string; // Alternative token field name
  clientId: string;
  clientSecret?: string;
  guildId?: string; // Optional: specific server ID
  channelIds: string[]; // Channels to monitor/post in
  commandPrefix: string; // e.g., "!", "/", etc.
  enableCommands: boolean;
  enableAutoReply: boolean;
  enableMentionOnly?: boolean; // Only respond to @mentions
  enableVoiceChat: boolean;
  replyDelay: number; // Seconds before replying
  connected?: boolean;
  botUsername?: string;
  pluginPermissions?: IntegrationPluginPermissions;
}

export interface Env {}

/** Discord bot user info returned by /users/@me */
interface DiscordBotInfo {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  bot?: boolean;
  [key: string]: unknown;
}

/** Discord embed object */
interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  timestamp: string;
  footer: { text: string };
}

/** Discord slash command option */
interface DiscordCommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  choices?: Array<{ name: string; value: string | number }>;
}

/** Discord command handler context */
interface DiscordCommandContext {
  channelId: string;
  userId: string;
  guildId?: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getNestedRecord(
  value: unknown,
  key: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  const next = value[key];
  return isRecord(next) ? next : {};
}

function getTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function getDiscordIntegrationConfig(agent: unknown): Partial<DiscordConfig> | undefined {
  const integrations = getNestedRecord(agent, "integrations");
  const discord = getNestedRecord(integrations, "discord");
  if (Object.keys(discord).length === 0) {
    return undefined;
  }

  return {
    botToken: getTrimmedString(discord.botToken) || getTrimmedString(discord.token),
    token: getTrimmedString(discord.token),
    clientId: getTrimmedString(discord.clientId),
    clientSecret: getTrimmedString(discord.clientSecret),
    guildId: getTrimmedString(discord.guildId),
    channelIds: getStringArray(discord.channelIds),
    commandPrefix: getTrimmedString(discord.commandPrefix),
    enableCommands:
      typeof discord.enableCommands === "boolean" ? discord.enableCommands : undefined,
    enableAutoReply:
      typeof discord.enableAutoReply === "boolean" ? discord.enableAutoReply : undefined,
    enableMentionOnly:
      typeof discord.enableMentionOnly === "boolean" ? discord.enableMentionOnly : undefined,
    enableVoiceChat:
      typeof discord.enableVoiceChat === "boolean" ? discord.enableVoiceChat : undefined,
    replyDelay:
      typeof discord.replyDelay === "number" ? discord.replyDelay : undefined,
    connected:
      typeof discord.connected === "boolean" ? discord.connected : undefined,
    botUsername: getTrimmedString(discord.botUsername),
    pluginPermissions: isRecord(discord.pluginPermissions)
      ? (discord.pluginPermissions as IntegrationPluginPermissions)
      : undefined,
  };
}

function getLegacyDiscordMetadata(agent: unknown): Partial<DiscordConfig> | undefined {
  const metadata = getNestedRecord(agent, "metadata");
  const discord = getNestedRecord(metadata, "discord");
  if (Object.keys(discord).length === 0) {
    return undefined;
  }

  return {
    commandPrefix: getTrimmedString(discord.commandPrefix),
    enableCommands:
      typeof discord.enableCommands === "boolean" ? discord.enableCommands : undefined,
    enableAutoReply:
      typeof discord.enableAutoReply === "boolean" ? discord.enableAutoReply : undefined,
    channelIds: getStringArray(discord.channelIds),
  };
}

function normalizeDiscordConfig(config: Partial<DiscordConfig>): DiscordConfig {
  return {
    botToken:
      getTrimmedString(config.botToken) || getTrimmedString(config.token) || "",
    token: getTrimmedString(config.token),
    clientId: getTrimmedString(config.clientId) || "",
    clientSecret: getTrimmedString(config.clientSecret),
    guildId: getTrimmedString(config.guildId),
    channelIds: getStringArray(config.channelIds) || [],
    commandPrefix: getTrimmedString(config.commandPrefix) || "!",
    enableCommands:
      typeof config.enableCommands === "boolean" ? config.enableCommands : false,
    enableAutoReply:
      typeof config.enableAutoReply === "boolean" ? config.enableAutoReply : false,
    enableMentionOnly:
      typeof config.enableMentionOnly === "boolean"
        ? config.enableMentionOnly
        : false,
    enableVoiceChat:
      typeof config.enableVoiceChat === "boolean" ? config.enableVoiceChat : false,
    replyDelay:
      typeof config.replyDelay === "number" && Number.isFinite(config.replyDelay)
        ? config.replyDelay
        : 2,
    connected: typeof config.connected === "boolean" ? config.connected : undefined,
    botUsername: getTrimmedString(config.botUsername),
    pluginPermissions: isRecord(config.pluginPermissions)
      ? (config.pluginPermissions as IntegrationPluginPermissions)
      : undefined,
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
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async getConfig(): Promise<DiscordConfig | null> {
    try {
      const storedConfig = await kvService.get("integration:discord");
      const config =
        isRecord(storedConfig) && Object.keys(storedConfig).length > 0
          ? normalizeDiscordConfig(storedConfig as Partial<DiscordConfig>)
          : getStoredAgentDiscordConfig(await kvService.get(AGENT_DEFAULTS.ID));
      if (config) {
        // Check connection status
        config.connected = await this.checkConnection(config);
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

      // Validate config
      if (!normalizedConfig.botToken || !normalizedConfig.clientId) {
        throw new Error("Bot token and client ID are required");
      }

      // Save to KV
      await kvService.set("integration:discord", normalizedConfig);

      // Keep the canonical agent config in sync for reloads and exports.
      const agent = await kvService.get(AGENT_DEFAULTS.ID) as Record<string, unknown> | null;
      if (agent) {
        const integrations = getNestedRecord(agent, "integrations");
        agent.metadata = {
          ...(agent.metadata as Record<string, unknown> || {}),
          discord: {
            commandPrefix: normalizedConfig.commandPrefix,
            enableCommands: normalizedConfig.enableCommands,
            enableAutoReply: normalizedConfig.enableAutoReply,
            channelIds: normalizedConfig.channelIds,
          },
        };
        agent.integrations = {
          ...integrations,
          discord: {
            botToken: normalizedConfig.botToken,
            token: normalizedConfig.token,
            clientId: normalizedConfig.clientId,
            clientSecret: normalizedConfig.clientSecret,
            guildId: normalizedConfig.guildId,
            channelIds: normalizedConfig.channelIds,
            commandPrefix: normalizedConfig.commandPrefix,
            enableCommands: normalizedConfig.enableCommands,
            enableAutoReply: normalizedConfig.enableAutoReply,
            enableMentionOnly: normalizedConfig.enableMentionOnly,
            enableVoiceChat: normalizedConfig.enableVoiceChat,
            replyDelay: normalizedConfig.replyDelay,
            botUsername: normalizedConfig.botUsername,
            pluginPermissions: normalizedConfig.pluginPermissions,
          },
        };
        await kvService.set(AGENT_DEFAULTS.ID, agent);
      }

      logger.info("Discord config saved successfully");
      return true;
    } catch (error) {
      logger.error("Failed to save Discord config:", error);
      return false;
    }
  }

  async testConnection(
    providedConfig?: Partial<DiscordConfig>,
  ): Promise<{ success: boolean; error?: string; botInfo?: DiscordBotInfo }> {
    try {
      // Use provided config or get from storage
      let config: DiscordConfig | null = null;
      let isTemporaryConfig = false;

      if (
        providedConfig &&
        providedConfig.botToken &&
        providedConfig.clientId
      ) {
        // Create a temporary config for testing
        config = {
          botToken: providedConfig.botToken,
          clientId: providedConfig.clientId,
          clientSecret: providedConfig.clientSecret || "",
          channelIds: [],
          commandPrefix: "!",
          enableCommands: false,
          enableAutoReply: false,
          enableVoiceChat: false,
          replyDelay: 0,
        };
        isTemporaryConfig = true;
      } else {
        // Fall back to saved config
        config = await this.getConfig();
        if (!config) {
          return { success: false, error: "No configuration found" };
        }
      }

      // Test connection by getting bot info
      const botInfo = await this.getBotInfo(config);
      if (botInfo) {
        // Only update saved config if not a temporary test
        if (!isTemporaryConfig) {
          config.botUsername = botInfo.username;
          await this.saveConfig(config);
        }
        return { success: true, botInfo };
      }

      return { success: false, error: "Failed to authenticate" };
    } catch (error) {
      logger.error("Discord connection test failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }

  private async checkConnection(config: DiscordConfig): Promise<boolean> {
    try {
      if (!config.botToken) {
        return false;
      }

      // Check Discord bot connection
      const response = await fetchWithTimeout("https://discord.com/api/v10/users/@me", {
        timeout: 10000,
        headers: {
          Authorization: `Bot ${config.botToken}`,
        },
      });

      return response.ok;
    } catch (error) {
      logger.error("Discord connection check failed:", error);
      return false;
    }
  }

  private async getBotInfo(config: DiscordConfig): Promise<DiscordBotInfo | null> {
    try {
      if (!config.botToken) {
        return null;
      }

      const response = await fetchWithTimeout("https://discord.com/api/v10/users/@me", {
        timeout: 10000,
        headers: {
          Authorization: `Bot ${config.botToken}`,
        },
      });

      if (response.ok) {
        return await response.json() as DiscordBotInfo;
      }

      return null;
    } catch (error) {
      logger.error("Failed to get Discord bot info:", error);
      return null;
    }
  }

  async sendMessage(
    channelId: string,
    content: string,
    options?: {
      embed?: DiscordEmbed;
      replyTo?: string;
      mentions?: string[];
    },
  ): Promise<boolean> {
    try {
      const config = await this.getConfig();
      if (!config) {
        logger.error("No Discord config found");
        return false;
      }

      const body: Record<string, unknown> = { content };

      if (options?.embed) {
        body.embeds = [options.embed];
      }

      if (options?.replyTo) {
        body.message_reference = { message_id: options.replyTo };
      }

      if (options?.mentions && options.mentions.length > 0) {
        body.allowed_mentions = { users: options.mentions };
      }

      const response = await fetchWithTimeout(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          timeout: 10000,
          method: "POST",
          headers: {
            Authorization: `Bot ${config.botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      if (response.ok) {
        logger.info("Discord message sent successfully");
        return true;
      } else {
        const error = await response.text();
        logger.error("Failed to send Discord message:", error);
        return false;
      }
    } catch (error) {
      logger.error("Failed to send Discord message:", error);
      return false;
    }
  }

  async createEmbed(
    title: string,
    description: string,
    color?: number,
  ): Promise<DiscordEmbed> {
    return {
      title,
      description,
      color: color || 0x0099ff, // Default blue color
      timestamp: new Date().toISOString(),
      footer: {
        text: "AI Agent",
      },
    };
  }

  async registerSlashCommands(
    commands: Array<{
      name: string;
      description: string;
      options?: DiscordCommandOption[];
    }>,
  ): Promise<boolean> {
    try {
      const config = await this.getConfig();
      if (!config || !config.enableCommands) {
        return false;
      }

      const url = config.guildId
        ? `https://discord.com/api/v10/applications/${config.clientId}/guilds/${config.guildId}/commands`
        : `https://discord.com/api/v10/applications/${config.clientId}/commands`;

      const response = await fetchWithTimeout(url, {
        timeout: 15000,
        method: "PUT",
        headers: {
          Authorization: `Bot ${config.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(commands),
      });

      if (response.ok) {
        logger.info("Discord slash commands registered successfully");
        return true;
      } else {
        const error = await response.text();
        logger.error("Failed to register slash commands:", error);
        return false;
      }
    } catch (error) {
      logger.error("Failed to register slash commands:", error);
      return false;
    }
  }

  async joinVoiceChannel(channelId: string, guildId: string): Promise<boolean> {
    try {
      const config = await this.getConfig();
      if (!config || !config.enableVoiceChat) {
        return false;
      }

      logger.info(
        "Discord voice chat is disabled in the HTTP integration runtime; use the Discord.js runtime for voice support",
      );
      return false;
    } catch (error) {
      logger.error("Failed to join voice channel:", error);
      return false;
    }
  }

  async handleCommand(
    command: string,
    args: string[],
    context: DiscordCommandContext,
  ): Promise<string | null> {
    try {
      const config = await this.getConfig();
      if (!config || !config.enableCommands) {
        return null;
      }

      // Handle basic commands
      switch (command.toLowerCase()) {
        case "help":
          return "Available commands: !help, !about, !chat <message>";

        case "about": {
          const agent = await kvService.get(AGENT_DEFAULTS.ID) as Record<string, unknown> | null;
          return agent
            ? `I'm ${agent.name}! ${agent.personality}`
            : "I'm an AI agent!";
        }

        case "chat":
          return args.length > 0
            ? null
            : "Please provide a message to chat about!";

        default:
          return null;
      }
    } catch (error) {
      logger.error("Failed to handle command:", error);
      return "Sorry, I encountered an error processing that command.";
    }
  }

  static async test(
    agent: unknown,
  ): Promise<{ success: boolean; error?: string; botInfo?: DiscordBotInfo }> {
    try {
      const botToken = getDiscordBotToken(agent);

      if (!botToken) {
        return { success: false, error: "No Discord bot token configured" };
      }

      // Test Discord API connection
      const response = await fetchWithTimeout("https://discord.com/api/v10/users/@me", {
        timeout: 10000,
        headers: {
          Authorization: `Bot ${botToken}`,
        },
      });

      if (response.ok) {
        const botInfo = await response.json() as DiscordBotInfo;
        return { success: true, botInfo };
      } else {
        const error = await response.text();
        return { success: false, error: `Discord API error: ${error}` };
      }
    } catch (error) {
      logger.error("Discord test failed:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Connection failed",
      };
    }
  }
}

function getDiscordBotToken(agent: unknown): string | undefined {
  const integrations = getNestedRecord(agent, "integrations");
  const discord = getNestedRecord(integrations, "discord");
  return getTrimmedString(discord.botToken) || getTrimmedString(discord.token);
}
