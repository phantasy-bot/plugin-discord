import { describe, expect, it } from "vitest";

import {
  buildDiscordGatewayThreadId,
  cleanDiscordMessageContent,
  normalizeDiscordId,
} from "./discord-thread-helpers";

describe("discord-thread-helpers", () => {
  it("builds stable gateway thread ids for guild and dm channels", () => {
    expect(buildDiscordGatewayThreadId({ channelId: "chan-1", guildId: "guild-1" })).toBe(
      "discord:guild:guild-1:channel:chan-1",
    );
    expect(buildDiscordGatewayThreadId({ channelId: "chan-2" })).toBe(
      "discord:dm:channel:chan-2",
    );
  });

  it("strips bot mentions from inbound content", () => {
    expect(
      cleanDiscordMessageContent({
        clientId: "123",
        botUsername: "phantasy",
        text: "<@!123> hello @phantasy world",
      }),
    ).toBe("hello  world");
  });

  it("normalizes discord ids and rejects empty values", () => {
    expect(normalizeDiscordId(" user-1 ")).toBe("user-1");
    expect(normalizeDiscordId("")).toBeUndefined();
    expect(normalizeDiscordId(null)).toBeUndefined();
  });
});
