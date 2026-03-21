import WebSocket from "ws";
import {
  AGENT_DEFAULTS,
  AgentService,
  createPluginModuleLogger,
  kvService,
  type ServerEnv,
} from "@phantasy/agent/plugin-runtime";
import type { DiscordConfig } from "../discord-integration";

const logger = createPluginModuleLogger("DiscordBotService");

/** Discord Gateway payload structure */
interface DiscordGatewayPayload {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

/** Discord Hello event data */
interface DiscordHelloData {
  heartbeat_interval: number;
}

/** Discord Ready event data */
interface DiscordReadyData {
  session_id: string;
  user: {
    username: string;
    discriminator: string;
    id: string;
  };
}

/** Discord Resume payload */
interface DiscordResumePayload {
  token: string;
  session_id: string;
  seq: number | null;
}

/** Agent data from KV store */
interface AgentKVData {
  name?: string;
  personality?: string;
}

/** Discord API message body */
interface DiscordMessageBody {
  content: string;
  message_reference?: { message_id: string };
}

export interface DiscordMessage {
  content: string;
  author: {
    id: string;
    username: string;
    bot: boolean;
  };
  channel_id: string;
  guild_id?: string;
  id: string;
  type: number;
}

export class DiscordBotService {
  private ws: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private sequenceNumber: number | null = null;
  private isConnected: boolean = false;
  private env: ServerEnv;
  private config: DiscordConfig;
  private agentService: AgentService;

  constructor(env: ServerEnv, config: DiscordConfig) {
    this.env = env;
    this.config = config;
    this.agentService = new AgentService(env);
  }

  async start(): Promise<void> {
    if (this.isConnected) {
      logger.info("Discord bot already connected");
      return;
    }

    try {
      await this.connect();
    } catch (error) {
      logger.error("Failed to start Discord bot:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.isConnected = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.ws) {
      this.ws.close(1000, "Bot shutting down");
      this.ws = null;
    }

    logger.info("Discord bot stopped");
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");

      this.ws.on("open", () => {
        logger.info("Discord WebSocket connected");
      });

      this.ws.on("message", async (data: string) => {
        const payload = JSON.parse(data);
        await this.handleMessage(payload);

        if (payload.op === 0 && payload.t === "READY") {
          resolve();
        }
      });

      this.ws.on("error", (error) => {
        logger.error("Discord WebSocket error:", error);
        reject(error);
      });

      this.ws.on("close", (code, reason) => {
        logger.info(`Discord WebSocket closed: ${code} - ${reason}`);
        this.isConnected = false;

        // Attempt to reconnect if not intentionally closed
        if (code !== 1000) {
          setTimeout(() => this.reconnect(), 5000);
        }
      });
    });
  }

  private async reconnect(): Promise<void> {
    if (this.isConnected) return;

    logger.info("Attempting to reconnect to Discord...");
    try {
      await this.connect();
    } catch (error) {
      logger.error("Reconnection failed:", error);
      setTimeout(() => this.reconnect(), 10000);
    }
  }

  private async handleMessage(payload: DiscordGatewayPayload): Promise<void> {
    const { op, d, s, t } = payload;

    if (s) {
      this.sequenceNumber = s;
    }

    switch (op) {
      case 10: // Hello
        await this.handleHello(d as DiscordHelloData);
        break;

      case 0: // Dispatch
        await this.handleDispatch(t as string, d);
        break;

      case 9: // Invalid Session
        logger.warn("Invalid session, reconnecting...");
        await this.reconnect();
        break;

      case 11: // Heartbeat ACK
        // Heartbeat acknowledged
        break;
    }
  }

  private async handleHello(data: DiscordHelloData): Promise<void> {
    const { heartbeat_interval } = data;

    // Start heartbeat
    this.startHeartbeat(heartbeat_interval);

    // Send identify
    await this.identify();
  }

  private startHeartbeat(interval: number): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, interval);
    this.heartbeatInterval.unref?.();

    // Send first heartbeat
    this.sendHeartbeat();
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        op: 1,
        d: this.sequenceNumber,
      }),
    );
  }

  private async identify(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const payload = {
      op: 2,
      d: {
        token: this.config.token || this.config.botToken,
        intents: 513 | 1024 | 2048 | 4096 | 8192, // Basic intents for messages
        properties: {
          os: "linux",
          browser: "phantasy-agent",
          device: "phantasy-agent",
        },
        presence: {
          status: "online",
          activities: [
            {
              name: "with AI magic ✨",
              type: 0, // Playing
            },
          ],
        },
      },
    };

    if (this.sessionId) {
      // Resume instead of identify
      const resumePayload = {
        op: 6,
        d: {
          token: this.config.token || this.config.botToken,
          session_id: this.sessionId,
          seq: this.sequenceNumber,
        } as DiscordResumePayload,
      };
      this.ws.send(JSON.stringify(resumePayload));
      return;
    }

    this.ws.send(JSON.stringify(payload));
  }

  private async handleDispatch(eventType: string, data: unknown): Promise<void> {
    switch (eventType) {
      case "READY": {
        const readyData = data as DiscordReadyData;
        this.sessionId = readyData.session_id;
        this.isConnected = true;
        logger.info(
          `Discord bot connected as ${readyData.user.username}#${readyData.user.discriminator}`,
        );
        break;
      }

      case "MESSAGE_CREATE":
        await this.handleMessageCreate(data as DiscordMessage);
        break;

      case "GUILD_CREATE": {
        const guildData = data as { name: string };
        logger.info(`Bot joined guild: ${guildData.name}`);
        break;
      }
    }
  }

  private async handleMessageCreate(message: DiscordMessage): Promise<void> {
    logger.info("🔥 DISCORD MESSAGE PROCESSING START", {
      author: message.author.username,
      channelId: message.channel_id,
      content: message.content,
      bot: message.author.bot,
      messageId: message.id,
    });

    // Ignore bot messages
    if (message.author.bot) {
      logger.info("🚫 Ignoring bot message from:", message.author.username);
      return;
    }

    logger.info("✅ Message is from human user, proceeding...");

    // Check if message is in a monitored channel
    if (
      this.config.channelIds.length > 0 &&
      !this.config.channelIds.includes(message.channel_id)
    ) {
      logger.info("🚫 Message not in monitored channel", {
        messageChannel: message.channel_id,
        monitoredChannels: this.config.channelIds,
      });
      return;
    }

    logger.info("✅ Channel check passed, proceeding...");

    // Handle commands first
    if (message.content.startsWith(this.config.commandPrefix || "!")) {
      logger.info("🎯 Processing as command:", message.content);
      await this.handleCommand(message);
      return;
    }

    logger.info("✅ Not a command, checking response triggers...");

    // Check if we should respond to this message
    const botMentioned = this.isBotMentioned(message.content);
    const shouldRespond = this.shouldRespondToMessage(message, botMentioned);

    logger.info("🔍 Response trigger analysis:", {
      botMentioned,
      shouldRespond,
      enableAutoReply: this.config.enableAutoReply,
      enableMentionOnly: this.config.enableMentionOnly || false,
      messageContent: message.content,
      containsBotId: message.content.includes(`<@${this.config.clientId}>`),
    });

    if (!shouldRespond) {
      logger.info("🚫 Not responding to this message based on configuration");
      return;
    }

    logger.info("✅ Should respond, processing message...");

    // Add delay if configured
    if (this.config.replyDelay > 0) {
      logger.info(`⏰ Adding ${this.config.replyDelay} second delay...`);
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.replyDelay * 1000),
      );
      logger.info("✅ Delay complete, proceeding to chat message handling...");
    }

    try {
      logger.info("🚀 Calling handleChatMessage...");
      await this.handleChatMessage(message, botMentioned);
      logger.info("✅ handleChatMessage completed successfully");
    } catch (error) {
      logger.error("💥 Error in handleChatMessage:", error);
      logger.error(
        "💥 Error stack:",
        error instanceof Error ? error.stack : "No stack",
      );
    }

    logger.info("🏁 DISCORD MESSAGE PROCESSING END");
  }

  private async handleCommand(message: DiscordMessage): Promise<void> {
    const [command, ...args] = message.content
      .slice(this.config.commandPrefix.length)
      .trim()
      .split(/\s+/);

    let response: string | null = null;

    switch (command.toLowerCase()) {
      case "help":
        response = `Available commands:
${this.config.commandPrefix}help - Show this help message
${this.config.commandPrefix}about - Learn about me
${this.config.commandPrefix}chat <message> - Chat with me`;
        break;

      case "about": {
        const agent = await kvService.get<AgentKVData>(AGENT_DEFAULTS.ID);
        response = agent
          ? `I'm ${agent.name}! ${agent.personality}`
          : "I'm an AI agent powered by Phantasy!";
        break;
      }

      case "chat":
        if (args.length === 0) {
          response = "Please provide a message to chat about!";
        } else {
          // Process as chat message
          const chatMessage = { ...message, content: args.join(" ") };
          await this.handleChatMessage(chatMessage);
          return;
        }
        break;

      default:
        response = `Unknown command. Use ${this.config.commandPrefix}help to see available commands.`;
    }

    if (response) {
      await this.sendMessage(message.channel_id, response);
    }
  }

  private isBotMentioned(content: string): boolean {
    // Check for @bot mention in various formats
    const mentionPatterns = [
      `<@${this.config.clientId}>`, // Standard mention
      `<@!${this.config.clientId}>`, // Nickname mention
      `@${this.config.botUsername}`, // @username mention
    ];

    return mentionPatterns.some((pattern) => content.includes(pattern));
  }

  private shouldRespondToMessage(
    message: DiscordMessage,
    botMentioned: boolean,
  ): boolean {
    // Always respond if not auto-reply enabled
    if (!this.config.enableAutoReply) {
      return false;
    }

    // If mention-only mode is enabled, only respond to mentions
    if (this.config.enableMentionOnly) {
      return botMentioned;
    }

    // Otherwise, respond to all messages (default behavior)
    return true;
  }

  private cleanMessageContent(content: string, botMentioned: boolean): string {
    if (!botMentioned) {
      return content;
    }

    // Remove bot mentions from the message content
    let cleanContent = content
      .replace(new RegExp(`<@!?${this.config.clientId}>`, "g"), "")
      .replace(new RegExp(`@${this.config.botUsername}`, "g"), "")
      .trim();

    // If the message is empty after removing mentions, provide context
    if (!cleanContent) {
      cleanContent = "Hello! (You mentioned me but didn't say anything else)";
    }

    return cleanContent;
  }

  private async handleChatMessage(
    message: DiscordMessage,
    botMentioned: boolean = false,
  ): Promise<void> {
    logger.info("🎯 HANDLE CHAT MESSAGE START", {
      author: message.author.username,
      messageId: message.id,
      platform: "discord",
      rawContent: message.content,
      botMentioned,
    });

    try {
      // Clean the message content (remove bot mentions)
      const cleanContent = this.cleanMessageContent(
        message.content,
        botMentioned,
      );

      logger.info("📝 Message content processing:", {
        originalContent: message.content,
        cleanedContent: cleanContent,
        botMentioned,
        contentChanged: message.content !== cleanContent,
      });

      // Get agent response
      const agentId = AGENT_DEFAULTS.ID;
      logger.info("🤖 Calling agentService.processMessage with:", {
        agentId,
        messageContent: cleanContent,
        context: {
          platform: "discord",
          userId: message.author.id,
          username: message.author.username,
          channelId: message.channel_id,
          mentioned: botMentioned,
        },
      });

      const response = await this.agentService.processMessage(
        agentId,
        cleanContent,
        {
          platform: "discord",
          userId: message.author.id,
          username: message.author.username,
          channelId: message.channel_id,
        },
      );

      logger.info("✅ Got response from agentService:", {
        responseLength: response.text?.length,
        hasResponse: !!response.text,
      });

      const replyText =
        response.text || "Sorry, I couldn't generate a response.";

      logger.info("📤 Sending Discord message:", {
        channelId: message.channel_id,
        replyLength: replyText.length,
      });

      await this.sendMessage(message.channel_id, replyText, {
        replyTo: message.id,
      });

      logger.info("✅ Discord message sent successfully");
    } catch (error) {
      logger.error("💥 Error in handleChatMessage:", error);
      logger.error("💥 Error details:", {
        message: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : "No stack",
        name: error instanceof Error ? error.name : "Unknown",
      });

      // Send error message to Discord
      try {
        await this.sendMessage(
          message.channel_id,
          "Sorry, I encountered an error processing your message.",
          {
            replyTo: message.id,
          },
        );
      } catch (sendError) {
        logger.error("💥 Failed to send error message to Discord:", sendError);
      }
    }

    logger.info("🏁 HANDLE CHAT MESSAGE END");
  }

  public async sendMessage(
    channelId: string,
    content: string,
    options?: { replyTo?: string },
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const body: DiscordMessageBody = { content };

    if (options?.replyTo) {
      body.message_reference = { message_id: options.replyTo };
    }

    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.config.token || this.config.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      logger.error("Failed to send Discord message:", { error, channelId });
      return { success: false, error };
    }

    const data = await response.json();
    return { success: true, messageId: data.id };
  }

  public isRunning(): boolean {
    return this.isConnected;
  }

  public getStatus(): { connected: boolean; username?: string } {
    return {
      connected: this.isConnected,
      username: this.config.botUsername,
    };
  }
}
