export function buildDiscordGatewayThreadId(input: {
  channelId: string;
  guildId?: string;
}): string {
  return input.guildId
    ? `discord:guild:${input.guildId}:channel:${input.channelId}`
    : `discord:dm:channel:${input.channelId}`;
}

export function normalizeDiscordId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return undefined;
}

export function cleanDiscordMessageContent(options: {
  botUsername?: string;
  clientId: string;
  text: string;
}): string {
  const text = options.text
    .replace(new RegExp(`<@!?${options.clientId}>`, "g"), "")
    .replace(options.botUsername ? new RegExp(`@${options.botUsername}`, "gi") : /$^/, "")
    .trim();

  return text || options.text.trim();
}
