import { BasePlugin, type PluginTool } from "@phantasy/agent/plugins";

export class DiscordPlugin extends BasePlugin {
  name = "discord";
  version = "2.0.0";
  description = "Discord integration plugin for Phantasy companions.";

  protected displayName = "Discord";
  protected category = "social";
  protected tags = ["discord","community","messaging","bot"];
  protected permissions = ["internet"];
  protected workspace = "business" as const;
  protected extensionKind = "integration" as const;
  protected adminSurface =   {
    "tabId": "discord",
    "label": "Discord",
    "section": "business",
    "workspace": "business",
    "kind": "generic",
    "keywords": [
      "discord",
      "community",
      "messaging",
      "bot"
    ]
  } as const;
  protected configSchema =   {
    "type": "object",
    "properties": {
      "enabled": {
        "type": "boolean",
        "default": true
      }
    }
  };

  getTools(): PluginTool[] {
    return [];
  }
}

export default DiscordPlugin;
