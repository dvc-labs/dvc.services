import { SetupError } from './errors.js';
import { DVC_EMOJI } from './version.js';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  readonly token: string;
  readonly guildId: string;
  readonly applicationId: string;
  readonly verificationRoleId: string;
  readonly verificationChannelId: string;
  readonly commandsChannelId: string;
  readonly logsChannelId: string;
  readonly verificationMessageId: string | undefined;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly emoji: string;
}

function snowflake(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value || !/^\d{17,20}$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new SetupError(`${key} must be a valid Discord ID (17–20 digits).`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env.DISCORD_TOKEN?.trim();
  if (!token || /\s/.test(token) || token.startsWith('Bot ')) {
    throw new SetupError('DISCORD_TOKEN must contain the bot token, without a Bot prefix or spaces.');
  }
  const portValue = env.PORT?.trim() || '8080';
  const port = Number(portValue);
  if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new SetupError('PORT must be an integer between 1 and 65535.');
  }
  const logLevel = env.LOG_LEVEL?.trim() || 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new SetupError('LOG_LEVEL must be debug, info, warn, or error.');
  }
  const emojiValue = env.DVC_EMOJI?.trim() || DVC_EMOJI;
  const emoji = emojiValue.toLowerCase() === 'none' ? '' : emojiValue;
  const emojiMatch = /^<a?:[a-zA-Z0-9_]{2,32}:(\d{17,20})>$/.exec(emoji);
  if (emoji && (!emojiMatch || BigInt(emojiMatch[1]!) > 18_446_744_073_709_551_615n)) {
    throw new SetupError('DVC_EMOJI must be a custom emoji such as <:dvc:1566457051465388194>, or none.');
  }
  const config: Config = {
    token,
    guildId: snowflake(env, 'GUILD_ID'),
    applicationId: snowflake(env, 'APPLICATION_ID'),
    verificationRoleId: snowflake(env, 'VERIFICATION_ROLE_ID'),
    verificationChannelId: snowflake(env, 'VERIFICATION_CHANNEL_ID'),
    commandsChannelId: snowflake(env, 'COMMANDS_CHANNEL_ID'),
    logsChannelId: snowflake(env, 'LOGS_CHANNEL_ID'),
    verificationMessageId: env.VERIFICATION_MESSAGE_ID?.trim()
      ? snowflake(env, 'VERIFICATION_MESSAGE_ID') : undefined,
    port,
    logLevel: logLevel as LogLevel,
    emoji,
  };
  if (config.verificationRoleId === config.guildId) {
    throw new SetupError('VERIFICATION_ROLE_ID cannot be the @everyone role.');
  }
  if (new Set([config.verificationChannelId, config.commandsChannelId, config.logsChannelId]).size !== 3) {
    throw new SetupError('Use separate verification, commands, and private logs channels.');
  }
  return Object.freeze(config);
}
