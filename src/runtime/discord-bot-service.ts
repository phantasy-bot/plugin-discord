import {
  AGENT_DEFAULTS,
  createPlatformConversationBridge,
  createPluginModuleLogger,
  importEsmModule,
  kvService,
  type PlatformConversationBridgeInboundEvent,
  type ServerEnv,
} from "@phantasy/agent/plugin-runtime";

import type { DiscordConfig } from "../discord-integration";
import {
  buildDiscordGatewayThreadId,
  cleanDiscordMessageContent,
  normalizeDiscordId,
} from "./discord-thread-helpers";

const logger = createPluginModuleLogger("DiscordBotService");

type DiscordBridge = ReturnType<typeof createPlatformConversationBridge>;

type ResolvedCommand = {
  content?: string;
  handled: boolean;
  responseText?: string;
} | null;

export class DiscordBotService {
  private bridge: DiscordBridge | null = null;
  private connected = false;
  private gatewayAbort: AbortController | null = null;

  constructor(
    private readonly env: ServerEnv,
    private readonly config: DiscordConfig,
  ) {}

  async start(): Promise<void> {
    if (this.connected) {
      return;
    }

    const bridge = this.getBridge();
    await bridge.initialize();
    this.connected = true;
    logger.info("Discord messaging bridge initialized");
  }

  async stop(): Promise<void> {
    this.gatewayAbort?.abort();
    this.gatewayAbort = null;

    if (this.bridge) {
      await this.bridge.shutdown();
      this.bridge = null;
    }

    this.connected = false;
    logger.info("Discord messaging bridge stopped");
  }

  getStatus(): { connected: boolean } {
    return { connected: this.connected };
  }

  async sendMessage(
    channelId: string,
    content: string,
    options: {
      channelUserId?: string;
      gatewayThreadId?: string;
      guildId?: string;
      sessionId?: string;
      threadId?: string;
    } = {},
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const bridge = this.getBridge();
    await bridge.initialize();
    const adapter = bridge.getAdapter();
    const discordThreadId = adapter.encodeThreadId({
      channelId,
      guildId: options.guildId || "@me",
      threadId: normalizeDiscordId(options.threadId),
    });

    return bridge.sendMessage({
      channelUserId: options.channelUserId,
      content,
      gatewayMetadata: {
        channelId,
        guildId: options.guildId,
      },
      gatewayThreadId:
        options.gatewayThreadId ||
        buildDiscordGatewayThreadId({
          channelId,
          guildId: options.guildId,
        }),
      sessionId: options.sessionId,
      threadId: discordThreadId,
    });
  }

  private getBridge(): DiscordBridge {
    if (this.bridge) {
      return this.bridge;
    }

    this.bridge = createPlatformConversationBridge({
      adapterKey: "discord",
      env: this.env,
      platform: "discord",
      registerDirectHandler: true,
      registerMentionHandler: true,
      registerMessageHandler:
        this.config.enableAutoReply && !this.config.enableMentionOnly,
      registerSubscribedHandler: true,
      replyDelayMs: Math.max(0, this.config.replyDelay) * 1000,
      stateKeyPrefix: "phantasy-chat-sdk:discord",
      userName: this.config.botUsername || "phantasy-discord",
      createAdapter: async () => {
        const { createDiscordAdapter } = await importEsmModule<{
          createDiscordAdapter: (config: Record<string, unknown>) => unknown;
        }>("@chat-adapter/discord");

        return createDiscordAdapter({
          applicationId: this.config.clientId,
          botToken: this.config.botToken || this.config.token,
          publicKey: this.config.publicKey,
          userName: this.config.botUsername || "phantasy-discord",
        }) as never;
      },
      normalizeInboundMessage: (event) => this.normalizeInboundMessage(event),
      onStart: async (bridge) => {
        const adapter = bridge.getAdapter() as {
          startGatewayListener?: (
            options?: Record<string, unknown>,
            callback?: unknown,
            signal?: AbortSignal,
          ) => Promise<void>;
        };
        this.gatewayAbort = new AbortController();
        void adapter.startGatewayListener?.({}, undefined, this.gatewayAbort.signal);
      },
      onStop: async () => {
        this.gatewayAbort?.abort();
        this.gatewayAbort = null;
      },
    });

    return this.bridge;
  }

  private async normalizeInboundMessage(event: PlatformConversationBridgeInboundEvent) {
    const authorId = normalizeDiscordId(event.message.author.userId);
    const authorName =
      normalizeDiscordId(event.message.author.userName) ||
      normalizeDiscordId(event.message.author.fullName) ||
      authorId;

    if (!authorId || !authorName) {
      return null;
    }

    if (
      this.config.allowedUserIds.length > 0 &&
      !this.config.allowedUserIds.includes(authorId)
    ) {
      return null;
    }

    const decodedThreadId = event.adapter.decodeThreadId(event.thread.id) as {
      channelId?: string;
      guildId?: string;
    };
    const guildId =
      decodedThreadId.guildId === "@me" ? undefined : decodedThreadId.guildId;
    const channelId = normalizeDiscordId(decodedThreadId.channelId);
    if (!channelId) {
      return null;
    }

    const monitoredChannels = new Set([
      ...this.config.channelIds,
      ...(this.config.defaultChannelId ? [this.config.defaultChannelId] : []),
    ]);
    if (monitoredChannels.size > 0 && !monitoredChannels.has(channelId)) {
      return null;
    }

    if (event.reason === "direct" && !this.config.enableAutoReply) {
      return null;
    }

    if (
      event.reason === "message" &&
      (!this.config.enableAutoReply || this.config.enableMentionOnly)
    ) {
      return null;
    }

    const rawText = String(event.message.text || "").trim();
    if (!rawText) {
      return null;
    }

    const command = await this.resolveCommand(rawText);
    if (command?.handled && !command.content) {
      return {
        autoSubscribe: false,
        channelId,
        channelUserId: authorId,
        content: rawText,
        gatewayMetadata: {
          channelId,
          guildId,
        },
        gatewayThreadId: buildDiscordGatewayThreadId({
          channelId,
          guildId,
        }),
        immediateResponseText: command.responseText,
        source: guildId ? "discord:guild" : "discord:dm",
        threadId: event.thread.id,
        userId: authorId,
        username: authorName,
      };
    }

    const content = cleanDiscordMessageContent({
      botUsername: this.config.botUsername,
      clientId: this.config.clientId,
      text: command?.content || rawText,
    });
    if (!content.trim()) {
      return null;
    }

    return {
      autoSubscribe: event.reason !== "message" || this.config.enableAutoReply,
      channelId,
      channelUserId: authorId,
      content,
      gatewayMetadata: {
        channelId,
        guildId,
      },
      gatewayThreadId: buildDiscordGatewayThreadId({
        channelId,
        guildId,
      }),
      source: guildId ? "discord:guild" : "discord:dm",
      threadId: event.thread.id,
      userId: authorId,
      username: authorName,
    };
  }

  private async resolveCommand(text: string): Promise<ResolvedCommand> {
    if (!this.config.enableCommands) {
      return null;
    }

    const prefix = this.config.commandPrefix || "!";
    if (!text.startsWith(prefix)) {
      return null;
    }

    const [rawCommand, ...args] = text.slice(prefix.length).trim().split(/\s+/);
    const command = rawCommand?.toLowerCase() || "";

    switch (command) {
      case "help":
        return {
          handled: true,
          responseText: `Available commands:
${prefix}help - Show this help message
${prefix}about - Learn about me
${prefix}chat <message> - Chat with me`,
        };
      case "about": {
        const agent = await kvService.get(AGENT_DEFAULTS.ID);
        const agentRecord =
          agent && typeof agent === "object"
            ? (agent as { name?: string; personality?: string })
            : null;
        return {
          handled: true,
          responseText: agentRecord?.name
            ? `I'm ${agentRecord.name}! ${agentRecord.personality || ""}`.trim()
            : "I'm an AI companion powered by Phantasy!",
        };
      }
      case "chat":
        if (args.length === 0) {
          return {
            handled: true,
            responseText: "Please provide a message to chat about!",
          };
        }
        return {
          content: args.join(" "),
          handled: true,
        };
      default:
        return {
          handled: true,
          responseText: `Unknown command. Use ${prefix}help to see available commands.`,
        };
    }
  }
}
