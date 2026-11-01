import { GatewayIntentBits, Options, Partials, type ClientOptions } from 'discord.js';

// Explicitly reviewed list: dependency updates must not silently widen our subscriptions.
export const REQUIRED_GATEWAY_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildPresences];

export function intentFailureHint(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return error.code === 'DisallowedIntents' || error.code === 4014
    ? 'Enable Server Members and Presence intents in the Developer Portal. Message Content is not required.' : undefined;
}

export function clientOptions(): ClientOptions {
  return {
    intents: REQUIRED_GATEWAY_INTENTS,
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
