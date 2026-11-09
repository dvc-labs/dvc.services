import { ActivityType, Client, Events } from 'discord.js';
import { GuildActivity } from './activity.js';
import { AuditLog, discordAuditSink } from './audit.js';
import { BulletinService } from './bulletin.js';
import { syncCommands } from './commands.js';
import { clientOptions, intentFailureHint } from './client-options.js';
import { loadConfig, type Config } from './config.js';
import { discordPanelRepository, preflight } from './discord.js';
import { SetupError } from './errors.js';
import { HallClient } from './hall.js';
import { createHealthServer } from './health.js';
import { errorSummary, Logger } from './logger.js';
import { loadMemberReport } from './member.js';
import { ensureVerificationPanel } from './panel.js';
import { InteractionRouter } from './router.js';
import { VerificationService } from './verification.js';
import { VERSION } from './version.js';

let config: Config;
try { config = loadConfig(); }
catch (error) {
  console.error(JSON.stringify({ level: 'error', event: 'configuration_invalid',
    detail: error instanceof SetupError ? error.message : errorSummary(error) }));
  process.exit(1);
}

const logger = new Logger(config.logLevel, config.token);
const hall = config.hallWorkerUrl && config.hallApiKey ? new HallClient(config.hallWorkerUrl, config.hallApiKey) : undefined;
if (!hall && (config.hallWorkerUrl || config.hallApiKey)) {
  logger.write('warn', 'hall_setup_incomplete', { detail: `Set ${config.hallWorkerUrl ? 'HALLAI_API_KEY' : 'WORKER_URL'} to enable /ask and /forget.` });
}
const audit = new AuditLog(logger);
const client = new Client({
  ...clientOptions(),
  presence: { activities: [{ name: 'dvc.labs', type: ActivityType.Watching }], status: 'online' },
});

let operational = false;
let stopping = false;
let currentPanelId: string | undefined;
let verification: VerificationService | undefined;
let bulletin: BulletinService | undefined;
let refreshPanel: (() => Promise<{ id: string; created: boolean }>) | undefined;
const activity = new GuildActivity({ config, audit, isReady: () => operational && !stopping });
const health = createHealthServer(() => operational && !stopping && client.isReady());

async function shutdown(reason: string, code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  operational = false;
  activity.stop();
  hall?.close();
  const forcedExit = setTimeout(() => process.exit(code), 8_000);
  forcedExit.unref();
  audit.record({ event: 'bot_stopping', title: 'dvc.services stopping', outcome: reason, priority: 'critical' });
  try { await activity.flush(); await audit.flush(); }
  finally {
    await client.destroy();
    health.closeAllConnections();
    if (health.listening) await new Promise<void>(resolve => health.close(() => resolve()));
    clearTimeout(forcedExit);
    process.exit(code);
  }
}

async function initialise(readyClient: Client<true>): Promise<void> {
  const resources = await preflight(readyClient, config);
  audit.setSink(discordAuditSink(resources.logsChannel));
  const changed = await syncCommands(resources.guild);
  audit.record({ event: 'commands_synced', title: 'Slash commands ready', outcome: changed ? 'updated' : 'unchanged' });

  verification = new VerificationService(resources.gateway);
  if (resources.bulletinGateway) bulletin = new BulletinService(resources.bulletinGateway);
  const repository = discordPanelRepository(resources.verificationChannel, config);
  let panelTask: Promise<{ id: string; created: boolean }> | undefined;
  refreshPanel = () => {
    panelTask ??= ensureVerificationPanel(repository, readyClient.user.id, config.verificationMessageId)
      .then(panel => { currentPanelId = panel.id; return panel; })
      .finally(() => { panelTask = undefined; });
    return panelTask;
  };
  const panel = await refreshPanel();
  audit.record({ event: 'verification_panel_ready', title: 'Verification panel ready',
    outcome: panel.created ? 'created' : 'reused', channelId: config.verificationChannelId,
    detail: `Message ID: ${panel.id}` });
  if (stopping) return;
  operational = true;
  audit.record({ event: 'bot_online', title: 'dvc.services online', outcome: 'ready', priority: 'critical',
    detail: `v${VERSION} is ready in dvc.labs. Verification, member lookups, welcome DMs, and server activity logs are available.`
      + (bulletin ? ' /bulletin is enabled.' : '') + (hall ? ' /ask and /forget are configured.' : '') });
}

const router = new InteractionRouter({
  config, audit, logger,
  ...(hall ? { hall } : {}),
  botId: () => client.user?.id ?? '',
  isReady: () => operational && !stopping && client.isReady(),
  panelId: () => currentPanelId,
  memberReport: async userId => {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) throw new SetupError('The configured server is not available.');
    return loadMemberReport(guild, config, userId);
  },
  verification: () => {
    if (!verification) throw new SetupError('Verification has not initialised.');
    return verification;
  },
  bulletin: () => bulletin,
  refreshPanel: async () => {
    if (!refreshPanel) throw new SetupError('Verification panel has not initialised.');
    return refreshPanel();
  },
});

client.on(Events.InteractionCreate, interaction => { void router.handle(interaction); });
function observe(event: string, task: () => void): void {
  try { task(); }
  catch (error) { logger.write('warn', event, { error: errorSummary(error) }); }
}
client.on(Events.GuildMemberAdd, member => observe('member_join_log_failed', () => activity.joined(member)));
client.on(Events.GuildMemberRemove, member => observe('member_leave_log_failed', () => activity.left(member)));
client.on(Events.GuildMemberUpdate, (before, after) => observe('member_update_log_failed', () => activity.updated(before, after)));
client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => observe('server_audit_log_failed', () => activity.auditEntry(entry, guild)));
client.on(Events.VoiceStateUpdate, (before, after) => observe('voice_log_failed', () => activity.voiceChanged(before, after)));
client.once(Events.ClientReady, readyClient => {
  void initialise(readyClient).catch(error => {
    const detail = error instanceof SetupError ? error.message : errorSummary(error);
    logger.write('error', 'startup_failed', { detail });
    audit.record({ event: 'startup_failed', title: 'dvc.services startup failed', outcome: 'error', detail, priority: 'critical' });
    void shutdown('startup_failed', 1);
  });
});
client.on(Events.Error, error => logger.write('error', 'discord_client_error', { error: errorSummary(error) }));
client.on(Events.ShardError, error => logger.write('warn', 'discord_connection_error', { error: errorSummary(error) }));
client.on(Events.ShardDisconnect, (event, shardId) => logger.write('warn', 'discord_disconnected', {
  shardId, closeCode: event.code, detail: intentFailureHint(event),
}));
client.on(Events.ShardReconnecting, shardId => logger.write('info', 'discord_reconnecting', { shardId }));
client.on(Events.ShardResume, (shardId, replayedEvents) => logger.write('info', 'bot_reconnected', { outcome: 'resumed', shardId, replayedEvents }));
client.on(Events.ShardReady, shardId => logger.write('info', 'discord_connected', { outcome: 'identified', shardId }));
client.on(Events.Invalidated, () => { void shutdown('session_invalidated', 1); });
health.on('error', error => {
  logger.write('error', 'health_server_failed', { error: errorSummary(error) });
  void shutdown('health_server_failed', 1);
});
process.once('SIGTERM', () => { void shutdown('SIGTERM', 0); });
process.once('SIGINT', () => { void shutdown('SIGINT', 0); });
process.on('unhandledRejection', error => {
  logger.write('error', 'unhandled_rejection', { error: errorSummary(error) });
  void shutdown('unhandled_rejection', 1);
});
process.on('uncaughtException', error => {
  logger.write('error', 'uncaught_exception', { error: errorSummary(error) });
  void shutdown('uncaught_exception', 1);
});

health.listen(config.port, '0.0.0.0');
logger.write('info', 'bot_starting', { version: VERSION, guildId: config.guildId });
try { await client.login(config.token); }
catch (error) {
  logger.write('error', 'discord_login_failed', { error: errorSummary(error),
    detail: intentFailureHint(error) });
  await shutdown('discord_login_failed', 1);
}
