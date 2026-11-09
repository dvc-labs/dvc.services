import { MessageFlags, PermissionFlagsBits, roleMention, userMention, type ButtonInteraction,
  type ChatInputCommandInteraction, type Interaction } from 'discord.js';
import type { AuditLog } from './audit.js';
import type { BulletinResult, BulletinService } from './bulletin.js';
import type { Config } from './config.js';
import { SetupError } from './errors.js';
import { HallError, MAX_HALL_PROMPT, type HallCommands, type HallScope } from './hall.js';
import { hallCards } from './hall-ui.js';
import { errorSummary, type Logger } from './logger.js';
import { MemberLookupLimiter, MemberReportCache, memberCard, memberView, parseMemberDetails,
  parseMemberNavigation, type MemberReport } from './member.js';
import { BULLETIN_CUSTOM_ID_PREFIX, Cooldown, isTrustedVerificationButton, MEMBER_CUSTOM_ID_PREFIX, parseBulletinAction,
  VERIFY_CUSTOM_ID } from './policy.js';
import { aboutCard, brandedTitle, bulletinCard, card } from './ui.js';
import type { VerificationResult, VerificationService } from './verification.js';

export interface RouterDependencies {
  config: Config;
  botId: () => string;
  isReady: () => boolean;
  panelId: () => string | undefined;
  refreshPanel: () => Promise<{ id: string; created: boolean }>;
  verification: () => VerificationService;
  // Absent or returning undefined when BULLETIN_ROLE_ID is not configured.
  bulletin?: () => BulletinService | undefined;
  hall?: HallCommands;
  memberReport: (userId: string) => Promise<MemberReport | null>;
  audit: AuditLog;
  logger: Logger;
  now?: () => number;
}

// 'awarded' is built in verify() because it mentions the member and the role.
const verificationReplies: Record<Exclude<VerificationResult, 'awarded'>, [string, string]> = {
  already_verified: ['Already verified', 'You already have access to dvc.labs. Make yourself at home.'],
  screening_pending: ['One more step', 'Please accept Discord’s server rules first, then press Verify again.'],
  bot: ['Members only', 'This verification step is for human members.'],
  processing: ['Verification in progress', 'Your first request is still being processed. Give it a moment.'],
  cooldown: ['Just a moment', 'Please wait a few seconds before trying again.'],
};

type ButtonRoute = 'verify' | 'member_page' | 'member_details' | 'bulletin';

function buttonRoute(customId: string): ButtonRoute | undefined {
  if (customId === VERIFY_CUSTOM_ID) return 'verify';
  if (customId.startsWith(BULLETIN_CUSTOM_ID_PREFIX)) return 'bulletin';
  if (parseMemberDetails(customId)) return 'member_details';
  return customId.startsWith(MEMBER_CUSTOM_ID_PREFIX) ? 'member_page' : undefined;
}

export class InteractionRouter {
  private readonly commandCooldown: Cooldown;
  private readonly memberLookupLimiter: MemberLookupLimiter;
  private readonly memberReports: MemberReportCache;
  private readonly now: () => number;
  constructor(private readonly deps: RouterDependencies) {
    this.now = deps.now ?? Date.now;
    this.commandCooldown = new Cooldown(5_000, this.now);
    this.memberLookupLimiter = new MemberLookupLimiter(this.now);
    this.memberReports = new MemberReportCache(this.now);
  }

  async handle(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
    // Ignore unrelated components if more features are added later.
    const route = interaction.isButton() ? buttonRoute(interaction.customId) : undefined;
    if (interaction.isButton() && !route) return;
    try {
      if (interaction.isChatInputCommand()) await this.command(interaction);
      else if (route === 'member_details') await this.memberDetails(interaction);
      else if (route === 'member_page') await this.memberPage(interaction);
      else if (route === 'bulletin') await this.bulletin(interaction);
      else await this.verify(interaction);
    } catch (error) {
      this.deps.logger.write('error', 'interaction_failed', {
        error: error instanceof SetupError ? error.message : errorSummary(error),
      });
      await this.failure(interaction, 'Something went wrong',
        'Please try again shortly. If this continues, let the dvc.labs team know so they can check the bot.');
    }
  }

  private async failure(interaction: ChatInputCommandInteraction | ButtonInteraction,
    title: string, description: string): Promise<void> {
    if (!interaction.deferred || interaction.ephemeral) {
      await this.respond(interaction, title, description);
      return;
    }
    const publicCommand = interaction.isChatInputCommand();
    // Discord treats a first follow-up immediately after a defer as an edit and
    // ignores its ephemeral flag. Complete the defer with a valid non-empty V2 response.
    if (publicCommand) {
      try {
        await interaction.editReply(card(interaction.commandName === 'member' ? 'Lookup finished' : 'Request finished'));
      } catch (error) {
        this.deps.logger.write('warn', 'interaction_cleanup_failed', { error: errorSummary(error) });
        try { await interaction.deleteReply(); } catch { /* Best-effort removal of a failed placeholder. */ }
        return; // Do not risk a supposedly private follow-up inheriting public visibility.
      }
    }
    try {
      await interaction.followUp({ ...card(title, description), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    } catch (error) { this.deps.logger.write('warn', 'interaction_reply_failed', { error: errorSummary(error) }); }
    finally {
      if (publicCommand) {
        try { await interaction.deleteReply(); }
        catch (error) { this.deps.logger.write('warn', 'interaction_cleanup_failed', { error: errorSummary(error) }); }
      }
    }
  }

  private async respond(interaction: ChatInputCommandInteraction | ButtonInteraction,
    title: string, description: string): Promise<void> {
    try {
      const payload = card(title, description);
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    } catch (error) {
      this.deps.logger.write('warn', 'interaction_reply_failed', { error: errorSummary(error) });
    }
  }

  private async command(interaction: ChatInputCommandInteraction): Promise<void> {
    const { config, audit } = this.deps;
    let outcome = 'error';
    let detail: string | undefined;
    let targetUserId: string | undefined;
    try {
      if (interaction.guildId !== config.guildId) {
        outcome = 'denied_guild';
        await this.respond(interaction, 'dvc.labs only', 'This bot is configured for the dvc.labs server.');
        return;
      }
      if (!this.deps.isReady()) {
        outcome = 'not_ready';
        await this.respond(interaction, 'Starting up', 'The bot is getting ready. Please try again shortly.');
        return;
      }
      if (interaction.channelId !== config.commandsChannelId) {
        outcome = 'denied_channel';
        await this.respond(interaction, 'Commands channel', `Please use this command in <#${config.commandsChannelId}>.`);
        return;
      }
      if (interaction.commandName === 'verification'
        && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        outcome = 'denied_permission';
        await this.respond(interaction, 'Team command', 'You need Manage Server permission to use this command.');
        return;
      }
      if (!this.commandCooldown.take(interaction.user.id)) {
        outcome = 'cooldown';
        await this.respond(interaction, 'Just a moment', 'Please wait a few seconds before using another command.');
        return;
      }
      if (interaction.commandName === 'about') {
        await interaction.reply(aboutCard(config, process.uptime()));
        outcome = 'success';
      } else if (interaction.commandName === 'member') {
        targetUserId = interaction.options.getUser('user', true).id;
        if (!interaction.options.getMember('user')) {
          outcome = 'member_not_found';
          await this.respond(interaction, 'Member not found', 'That account is not currently a member of dvc.labs.');
          return;
        }
        const permit = this.memberLookupLimiter.acquire(interaction.user.id);
        if (!permit.allowed) {
          outcome = 'rate_limited';
          await this.respond(interaction, 'Just a moment', `Please try /member again in ${permit.retryAfter} seconds.`);
          return;
        }
        try {
          await interaction.deferReply({});
          const report = await this.deps.memberReport(targetUserId);
          if (!report) {
            outcome = 'member_not_found';
            await this.failure(interaction, 'Member not found', 'That account is not currently a member of dvc.labs.');
            return;
          }
          const publicReport = memberView(report, false);
          const message = await interaction.editReply(memberCard(publicReport, interaction.user.id, 0, { snapshotAt: this.now() }));
          this.memberReports.put(message.id, { ownerId: interaction.user.id, guildId: config.guildId,
            channelId: config.commandsChannelId, report: publicReport, staff: false });
          outcome = 'success';
        } finally { permit.release(); }
      } else if (interaction.commandName === 'verification') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const panel = await this.deps.refreshPanel();
        audit.record({ event: 'verification_panel_updated', title: 'Verification panel ready',
          outcome: panel.created ? 'created' : 'updated', userId: interaction.user.id,
          channelId: config.verificationChannelId, detail: `Message ID: ${panel.id}` });
        outcome = 'success';
        await this.respond(interaction, 'Verification panel ready',
          `The panel has been ${panel.created ? 'created' : 'updated'} in <#${config.verificationChannelId}>.`);
      } else if (interaction.commandName === 'bulletin') {
        const service = this.deps.bulletin?.();
        const roleId = config.bulletinRoleId;
        if (!service || !roleId) {
          outcome = 'not_configured';
          await this.respond(interaction, 'Bulletin unavailable', 'Bulletin pings are not enabled on this server.');
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const status = await service.status(interaction.user.id);
        await interaction.editReply(bulletinCard(status, interaction.user.id, roleId, config));
        outcome = 'success';
      } else if (interaction.commandName === 'ask' || interaction.commandName === 'forget') {
        outcome = await this.hallCommand(interaction);
      } else {
        outcome = 'unknown_command';
        await this.respond(interaction, 'Command unavailable', 'Please refresh Discord’s command list and try again.');
      }
    } catch (error) {
      detail = error instanceof SetupError ? error.message : errorSummary(error);
      throw error;
    } finally {
      if (interaction.guildId === config.guildId) {
        audit.record({ event: 'command_used', title: 'Command used', outcome,
          userId: interaction.user.id, channelId: interaction.channelId, command: interaction.commandName,
          discord: !['ask', 'forget', 'bulletin'].includes(interaction.commandName)
            && outcome !== 'cooldown' && outcome !== 'rate_limited',
          priority: outcome === 'error' ? 'critical' : 'routine',
          ...(targetUserId ? { targetUserId } : {}),
          ...(detail ? { detail } : {}) });
      }
    }
  }

  private async hallCommand(interaction: ChatInputCommandInteraction): Promise<string> {
    const { hall, config, logger } = this.deps;
    if (!hall) {
      await this.respond(interaction, 'hallAI unavailable', 'The Hall connection is not configured on this server.');
      return 'not_configured';
    }
    const asking = interaction.commandName === 'ask';
    const prompt = asking ? interaction.options.getString('prompt', true).trim() : '';
    if (asking && (!prompt || prompt.length > MAX_HALL_PROMPT)) {
      await this.respond(interaction, 'Question needed', `Enter a question of up to ${MAX_HALL_PROMPT.toLocaleString('en')} characters.`);
      return 'invalid_question';
    }
    const scope: HallScope = { guildId: config.guildId, channelId: interaction.channelId, userId: interaction.user.id,
      private: interaction.options.getBoolean('private') === true };
    await interaction.deferReply(!asking || scope.private ? { flags: MessageFlags.Ephemeral } : {});
    try {
      if (asking) {
        const answer = await hall.ask(scope, prompt, interaction.options.getBoolean('reset') === true);
        const [first, ...continuations] = hallCards(prompt, answer, config.emoji);
        await interaction.editReply(first!);
        try {
          for (const page of continuations) {
            await interaction.followUp({ ...page, flags: page.flags | (scope.private ? MessageFlags.Ephemeral : 0) });
          }
        } catch (error) {
          // A failed continuation should never remove the answer already delivered.
          logger.write('warn', 'hall_delivery_incomplete', { error: errorSummary(error) });
          return 'partial_reply';
        }
      } else {
        await hall.forget(scope);
        await this.respond(interaction, 'Hall context cleared',
          `Your ${scope.private ? 'private' : 'public'} conversation context for this channel was cleared. Existing Discord messages stay in place.`);
      }
      return 'success';
    } catch (error) {
      if (!(error instanceof HallError)) throw error;
      const message = {
        busy: 'Hall is still working on other requests. Please try again in a moment.',
        rate_limited: 'Please wait a little before using Hall again.',
        access_denied: 'The Hall connection was refused. Let the dvc.labs team know so they can check the setup.',
        unavailable: 'Hall could not complete this request. Please try again shortly.',
      }[error.kind];
      if (error.kind === 'access_denied' || error.kind === 'unavailable') {
        logger.write('warn', 'hall_request_failed', { outcome: error.kind, status: error.status, reference: error.reference });
      }
      await this.failure(interaction, 'hallAI unavailable', message + (error.reference ? `\nReference: ${error.reference}` : ''));
      return error.kind;
    }
  }

  private async memberPage(interaction: ButtonInteraction): Promise<void> {
    const { config, audit } = this.deps;
    const navigation = parseMemberNavigation(interaction.customId);
    if (!navigation || navigation.ownerId !== interaction.user.id
      || interaction.guildId !== config.guildId || interaction.channelId !== config.commandsChannelId
      || interaction.message.author.id !== this.deps.botId() || !this.deps.isReady()) {
      await this.respond(interaction, 'Member lookup unavailable', 'Use /member in the commands channel to open your own lookup.');
      if (interaction.guildId === config.guildId) audit.record({ event: 'member_lookup_denied',
        title: 'Member lookup denied', outcome: 'invalid_navigation', userId: interaction.user.id,
        channelId: interaction.channelId, discord: false });
      return;
    }
    const snapshot = this.memberReports.get(interaction.message.id);
    if (!snapshot) {
      await this.expiredMemberCard(interaction);
      return;
    }
    if (snapshot.ownerId !== navigation.ownerId || snapshot.report.userId !== navigation.userId
      || snapshot.guildId !== interaction.guildId || snapshot.channelId !== interaction.channelId
      || (snapshot.staff && !this.isStaff(interaction))) {
      await this.respond(interaction, 'Member lookup unavailable', 'Use /member in the commands channel to open your own lookup.');
      if (interaction.guildId === config.guildId) audit.record({ event: 'member_lookup_denied',
        title: 'Member lookup denied', outcome: 'invalid_or_expired_navigation', userId: interaction.user.id,
        channelId: interaction.channelId, discord: false });
      return;
    }
    const permit = this.memberLookupLimiter.acquire(interaction.user.id, true);
    if (!permit.allowed) {
      await this.respond(interaction, 'Just a moment', `Please wait ${permit.retryAfter} seconds before changing pages again.`);
      return;
    }
    let outcome = 'error';
    try {
      await interaction.deferUpdate();
      await interaction.editReply(memberCard(snapshot.report, interaction.user.id, navigation.page,
        { staff: snapshot.staff, snapshotAt: snapshot.createdAt }));
      outcome = 'success';
    } finally {
      permit.release();
      audit.record({ event: 'member_lookup_page', title: 'Member details viewed', outcome, userId: interaction.user.id,
        targetUserId: navigation.userId, channelId: interaction.channelId, discord: false });
    }
  }

  private isStaff(interaction: ButtonInteraction): boolean {
    return !!interaction.memberPermissions?.any(PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ModerateMembers);
  }

  private async expiredMemberCard(interaction: ButtonInteraction): Promise<void> {
    await this.respond(interaction, 'Member card expired', 'This card has expired. Run /member again for fresh details.');
    this.deps.audit.record({ event: 'member_lookup_denied', title: 'Member card expired', outcome: 'expired_navigation',
      userId: interaction.user.id, channelId: interaction.channelId, discord: false });
  }

  private async memberDetails(interaction: ButtonInteraction): Promise<void> {
    const { config, audit } = this.deps;
    const target = parseMemberDetails(interaction.customId)!;
    const snapshot = this.memberReports.get(interaction.message.id);
    if (this.deps.isReady() && interaction.guildId === config.guildId && interaction.channelId === config.commandsChannelId
      && interaction.message.author.id === this.deps.botId() && this.isStaff(interaction) && !snapshot) {
      await this.expiredMemberCard(interaction);
      return;
    }
    if (!this.deps.isReady() || interaction.guildId !== config.guildId || interaction.channelId !== config.commandsChannelId
      || interaction.message.author.id !== this.deps.botId() || !snapshot || snapshot.staff
      || snapshot.ownerId !== target.ownerId || snapshot.report.userId !== target.userId
      || snapshot.guildId !== interaction.guildId || snapshot.channelId !== interaction.channelId || !this.isStaff(interaction)) {
      await this.respond(interaction, 'Private staff details', 'A current lookup and Manage Server or Moderate Members permission are required.');
      if (interaction.guildId === config.guildId) audit.record({ event: 'member_lookup_denied', title: 'Member lookup denied',
        outcome: 'private_details_denied', userId: interaction.user.id, targetUserId: target.userId,
        channelId: interaction.channelId, discord: false });
      return;
    }
    const permit = this.memberLookupLimiter.acquire(interaction.user.id, true);
    if (!permit.allowed) {
      await this.respond(interaction, 'Just a moment', `Please wait ${permit.retryAfter} seconds before opening staff details again.`);
      return;
    }
    let outcome = 'error';
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const report = await this.deps.memberReport(target.userId);
      if (!report) {
        outcome = 'member_not_found';
        await this.failure(interaction, 'Member not found', 'That account is no longer a member of dvc.labs.');
        return;
      }
      const message = await interaction.editReply(memberCard(report, interaction.user.id, 0,
        { staff: true, snapshotAt: this.now() }));
      this.memberReports.put(message.id, { ownerId: interaction.user.id, guildId: config.guildId,
        channelId: config.commandsChannelId, report, staff: true });
      outcome = 'success';
    } finally {
      permit.release();
      audit.record({ event: 'member_private_view', title: 'Private member details viewed', outcome,
        userId: interaction.user.id, targetUserId: target.userId, channelId: interaction.channelId, discord: false });
    }
  }

  private async verify(interaction: ButtonInteraction): Promise<void> {
    const { config, audit } = this.deps;
    if (!this.deps.isReady() || !isTrustedVerificationButton({
      guildId: interaction.guildId, channelId: interaction.channelId,
      authorId: interaction.message.author.id, messageId: interaction.message.id, customId: interaction.customId,
    }, { guildId: config.guildId, channelId: config.verificationChannelId,
      botId: this.deps.botId(), messageId: this.deps.panelId() })) {
      if (interaction.guildId === config.guildId) {
        audit.record({ event: 'verification_denied', title: 'Verification not accepted',
          outcome: 'not_ready_or_invalid_panel', userId: interaction.user.id, channelId: interaction.channelId });
      }
      await this.respond(interaction, 'Verification unavailable',
        `Please use the current verification panel in <#${config.verificationChannelId}> once the bot is online.`);
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let result: VerificationResult;
    try { result = await this.deps.verification().verify(interaction.user.id); }
    catch (error) {
      audit.record({ event: 'verification_failed', title: 'Verification failed', outcome: 'error',
        userId: interaction.user.id, channelId: interaction.channelId,
        priority: 'critical',
        detail: error instanceof SetupError ? error.message : errorSummary(error) });
      throw error;
    }
    const verifiedTitle = brandedTitle('Member verified', config.emoji);
    audit.record({
      event: result === 'awarded' ? 'verification_succeeded' : 'verification_attempt',
      title: result === 'awarded' ? verifiedTitle : 'Verification attempt',
      outcome: result, userId: interaction.user.id, channelId: interaction.channelId,
      discord: result !== 'cooldown' && result !== 'processing' && result !== 'already_verified',
      priority: result === 'awarded' ? 'important' : 'routine',
      ...(result === 'awarded' ? { roleId: config.verificationRoleId } : {}),
    });
    const [title, description] = result === 'awarded'
      ? [verifiedTitle, `Welcome to dvc.labs, ${userMention(interaction.user.id)}! Your ${roleMention(config.verificationRoleId)} role has been added and the community is now unlocked.`]
      : verificationReplies[result];
    // Reply failures cannot undo the role or produce a false verification-failure log.
    await this.respond(interaction, title, description);
  }

  private async bulletin(interaction: ButtonInteraction): Promise<void> {
    const { config, audit } = this.deps;
    const service = this.deps.bulletin?.();
    const roleId = config.bulletinRoleId;
    const action = parseBulletinAction(interaction.customId);
    // Old verification receipts and other people's cards cannot manage roles.
    if (!service || !roleId || !this.deps.isReady() || interaction.guildId !== config.guildId
      || interaction.channelId !== config.commandsChannelId || interaction.message.author.id !== this.deps.botId()
      || !interaction.message.flags.has(MessageFlags.Ephemeral) || action?.userId !== interaction.user.id) {
      if (interaction.guildId === config.guildId) {
        audit.record({ event: 'bulletin_denied', title: 'Bulletin request not accepted',
          outcome: 'not_ready_or_invalid_message', userId: interaction.user.id, channelId: interaction.channelId, discord: false });
      }
      await this.respond(interaction, 'Bulletin unavailable', `Use /bulletin in <#${config.commandsChannelId}> to open your own preferences.`);
      return;
    }
    // Edit the private card in place so the button always offers the next action.
    await interaction.deferUpdate();
    let result: BulletinResult;
    try { result = await service.set(interaction.user.id, action.subscribe); }
    catch (error) {
      audit.record({ event: 'bulletin_failed', title: 'Bulletin update failed', outcome: 'error',
        userId: interaction.user.id, channelId: interaction.channelId, roleId, priority: 'critical',
        detail: error instanceof SetupError ? error.message : errorSummary(error) });
      throw error;
    }
    const { outcome, status } = result;
    const changed = outcome === 'subscribed' || outcome === 'unsubscribed';
    audit.record({
      event: changed ? 'bulletin_updated' : 'bulletin_attempt',
      title: changed ? brandedTitle(outcome === 'subscribed' ? 'Bulletin subscribed' : 'Bulletin unsubscribed', config.emoji) : 'Bulletin attempt',
      outcome, userId: interaction.user.id, channelId: interaction.channelId, roleId,
      discord: changed,
    });
    // A reply failure cannot undo the role change or produce a false failure log.
    try {
      if (status) {
        await interaction.editReply(bulletinCard(status, interaction.user.id, roleId, config,
          outcome === 'unsubscribed' && status === 'not_verified' ? 'Bulletin pings are off.' : ''));
      } else {
        await interaction.followUp({ ...card('Just a moment', 'Please wait a few seconds before changing Bulletin pings again.'),
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
      }
    }
    catch (error) { this.deps.logger.write('warn', 'interaction_reply_failed', { error: errorSummary(error) }); }
  }
}
