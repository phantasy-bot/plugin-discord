import type { DiscordConfig } from "../discord-integration";
import {
  readBoolean,
  readNumber,
  readOptionalString,
  readRequiredString,
  readStringArray,
} from "./config-helpers";

export function buildDiscordRuntimeConfig(input: {
  overrides?: Partial<DiscordConfig>;
  snapshot: Partial<DiscordConfig>;
  stored: DiscordConfig | null;
}): DiscordConfig | null {
  const { overrides, snapshot, stored } = input;
  const runtimeConfig: DiscordConfig = {
    botToken: readRequiredString(
      overrides?.botToken,
      snapshot.botToken,
      stored?.botToken,
      stored?.token,
      process.env.DISCORD_BOT_TOKEN,
    ),
    token: readOptionalString(overrides?.token, snapshot.token, stored?.token),
    clientId: readRequiredString(
      overrides?.clientId,
      snapshot.clientId,
      stored?.clientId,
      process.env.DISCORD_APPLICATION_ID,
      process.env.DISCORD_CLIENT_ID,
    ),
    clientSecret: readOptionalString(
      overrides?.clientSecret,
      snapshot.clientSecret,
      stored?.clientSecret,
      process.env.DISCORD_CLIENT_SECRET,
    ),
    publicKey: readOptionalString(
      overrides?.publicKey,
      snapshot.publicKey,
      stored?.publicKey,
      process.env.DISCORD_PUBLIC_KEY,
    ),
    guildId: readOptionalString(
      overrides?.guildId,
      snapshot.guildId,
      stored?.guildId,
      process.env.DISCORD_GUILD_ID,
    ),
    channelIds: readStringArray(
      overrides?.channelIds,
      snapshot.channelIds,
      stored?.channelIds,
    ),
    defaultChannelId: readOptionalString(
      overrides?.defaultChannelId,
      snapshot.defaultChannelId,
      stored?.defaultChannelId,
    ),
    allowedUserIds: readStringArray(
      overrides?.allowedUserIds,
      snapshot.allowedUserIds,
      stored?.allowedUserIds,
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
    autoStart: readBoolean(overrides?.autoStart, snapshot.autoStart, stored?.autoStart),
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
