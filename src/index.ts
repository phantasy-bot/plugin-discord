import { BasePlugin, PluginManifest, PluginTool, PluginConfig } from "@phantasy/core";

export interface DiscordPluginConfig extends PluginConfig {
  botToken?: string;
  guildId?: string;
}

export class DiscordPlugin extends BasePlugin {
  readonly name = "discord";
  readonly version = "1.0.0";
  private config: DiscordPluginConfig = {};

  constructor(config: DiscordPluginConfig = {}) {
    super();
    this.config = config;
  }

  getManifest(): PluginManifest {
    return {
      name: this.name,
      version: this.version,
      description: "Discord bot integration - send messages, manage channels, and respond to commands",
      author: "Phantasy",
      license: "BUSL-1.1",
      repository: "https://github.com/phantasy-bot/plugin-discord",
      keywords: ["discord", "messaging", "bot", "platform"],
      category: "social",
      isPlatform: true,
      platformFeatures: { messaging: true, streaming: false, autonomous: true },
    };
  }

  getTools(): PluginTool[] {
    return [
      { name: "send_message", description: "Send a message to a Discord channel", parameters: { type: "object", properties: { channelId: { type: "string" }, content: { type: "string" } }, required: ["channelId", "content"] } },
      { name: "get_channel", description: "Get information about a Discord channel", parameters: { type: "object", properties: { channelId: { type: "string" } }, required: ["channelId"] } },
    ];
  }

  async initialize(): Promise<void> {
    console.log("[DiscordPlugin] Initialized (standalone mode)");
  }
}

export default DiscordPlugin;
