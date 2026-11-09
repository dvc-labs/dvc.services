import { SetupError } from './errors.js';
import { DVC_EMOJI } from './version.js';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  readonly token: string;
  readonly guildId: string;
  readonly applicationId: string;
  readonly verificationRoleId: string;
  readonly adminRoleId: string | undefined;
  readonly verificationChannelId: string;
  readonly commandsChannelId: string;
  readonly logsChannelId: string;
  readonly verificationMessageId: string | undefined;
  // Optional self-service news-ping role managed through /bulletin.
  readonly bulletinRoleId: string | undefined;
  readonly hallWorkerUrl: string | undefined;
  readonly hallApiKey: string | undefined;
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

function workerOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new SetupError('WORKER_URL must be the Hall Worker HTTPS origin, without credentials, a path, or query parameters.');
  }
  return url.origin;
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
    adminRoleId: env.ADMIN_ROLE_ID?.trim() ? snowflake(env, 'ADMIN_ROLE_ID') : undefined,
    verificationChannelId: snowflake(env, 'VERIFICATION_CHANNEL_ID'),
    commandsChannelId: snowflake(env, 'COMMANDS_CHANNEL_ID'),
    logsChannelId: snowflake(env, 'LOGS_CHANNEL_ID'),
    verificationMessageId: env.VERIFICATION_MESSAGE_ID?.trim()
      ? snowflake(env, 'VERIFICATION_MESSAGE_ID') : undefined,
    bulletinRoleId: env.BULLETIN_ROLE_ID?.trim() ? snowflake(env, 'BULLETIN_ROLE_ID') : undefined,
    hallWorkerUrl: workerOrigin(env.WORKER_URL?.trim()),
    hallApiKey: env.HALLAI_API_KEY?.trim() || undefined,
    port,
    logLevel: logLevel as LogLevel,
    emoji,
  };
  if (config.verificationRoleId === config.guildId) {
    throw new SetupError('VERIFICATION_ROLE_ID cannot be the @everyone role.');
  }
  if (config.bulletinRoleId
    && (config.bulletinRoleId === config.guildId || config.bulletinRoleId === config.verificationRoleId)) {
    throw new SetupError('BULLETIN_ROLE_ID must be its own role, not @everyone or VERIFICATION_ROLE_ID.');
  }
  if (config.adminRoleId && [config.guildId, config.verificationRoleId, config.bulletinRoleId].includes(config.adminRoleId)) {
    throw new SetupError('ADMIN_ROLE_ID must be its own role, not @everyone, VERIFICATION_ROLE_ID, or BULLETIN_ROLE_ID.');
  }
  if (new Set([config.verificationChannelId, config.commandsChannelId, config.logsChannelId]).size !== 3) {
    throw new SetupError('Use separate verification, commands, and private logs channels.');
  }
  return Object.freeze(config);
}
