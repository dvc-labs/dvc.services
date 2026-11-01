import { GatewayIntentBits, Options, Partials, type ClientOptions } from 'discord.js';

// Request every intent currently supported by the installed Discord API library.
// Numeric enums also contain reverse name mappings; only the numeric values are intents.
export const ALL_GATEWAY_INTENTS = Object.values(GatewayIntentBits).filter((value): value is number => typeof value === 'number');

export function clientOptions(): ClientOptions {
  return {
    intents: ALL_GATEWAY_INTENTS,
    partials: [Partials.Channel, Partials.GuildMember, Partials.User],
    allowedMentions: { parse: [], repliedUser: false },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      ReactionManager: 0,
      ReactionUserManager: 0,
      GuildMemberManager: { maxSize: 1_000, keepOverLimit: member => member.id === member.client.user.id },
      UserManager: { maxSize: 1_000, keepOverLimit: user => user.id === user.client.user.id },
      PresenceManager: 1_000,
    }),
    rest: { timeout: 10_000, retries: 1 },
  };
}
