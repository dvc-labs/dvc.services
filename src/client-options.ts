import { GatewayIntentBits, Options, Partials, type ClientOptions } from 'discord.js';

// Explicitly reviewed list: dependency updates must not silently widen our subscriptions.
export const REQUIRED_GATEWAY_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildPresences,
  GatewayIntentBits.GuildMessages];

export function intentFailureHint(error: unknown, messageLogContent = true): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  if (error.code !== 'DisallowedIntents' && error.code !== 4014) return undefined;
  return 'Enable Server Members and Presence intents in the Developer Portal.'
    + (messageLogContent
      ? ' Enable Message Content to copy chat text into edit/delete logs, or set MESSAGE_LOG_CONTENT=false for metadata-only logs.'
      : '');
}

export function clientOptions(messageLogContent = true): ClientOptions {
  return {
    intents: messageLogContent ? [...REQUIRED_GATEWAY_INTENTS, GatewayIntentBits.MessageContent] : REQUIRED_GATEWAY_INTENTS,
    partials: [Partials.Channel, Partials.GuildMember, Partials.User, Partials.Message],
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
