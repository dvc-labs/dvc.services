import { MessageFlags, PermissionFlagsBits, roleMention, userMention, type ButtonInteraction,
  type ChatInputCommandInteraction, type Interaction } from 'discord.js';
import type { AuditLog } from './audit.js';
import type { Config } from './config.js';
import { SetupError } from './errors.js';
import { errorSummary, type Logger } from './logger.js';
import { MemberLookupLimiter, memberCard, parseMemberNavigation, type MemberReport } from './member.js';
import { Cooldown, isTrustedVerificationButton, MEMBER_CUSTOM_ID_PREFIX, VERIFY_CUSTOM_ID } from './policy.js';
import { aboutCard, card } from './ui.js';
import { DVC_EMOJI } from './version.js';
import type { VerificationResult, VerificationService } from './verification.js';

export interface RouterDependencies {
  config: Config;
  botId: () => string;
  isReady: () => boolean;
  panelId: () => string | undefined;
  refreshPanel: () => Promise<{ id: string; created: boolean }>;
  verification: () => VerificationService;
  memberReport: (userId: string) => Promise<MemberReport | null>;
  audit: AuditLog;
  logger: Logger;
}

const verificationReplies: Record<VerificationResult, [string, string]> = {
  awarded: ['You’re verified', 'Welcome to dvc.labs! Your member role has been added and the community is now unlocked.'],
  already_verified: ['Already verified', 'You already have access to dvc.labs. Make yourself at home.'],
  screening_pending: ['One more step', 'Please accept Discord’s server rules first, then press Verify again.'],
  bot: ['Members only', 'This verification step is for human members.'],
  processing: ['Verification in progress', 'Your first request is still being processed. Give it a moment.'],
  cooldown: ['Just a moment', 'Please wait a few seconds before trying again.'],
};

export class InteractionRouter {
  private readonly commandCooldown = new Cooldown();
  private readonly memberLookupLimiter = new MemberLookupLimiter();
  constructor(private readonly deps: RouterDependencies) {}

  async handle(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
    // Ignore unrelated components if more features are added later.
    if (interaction.isButton() && interaction.customId !== VERIFY_CUSTOM_ID
      && !interaction.customId.startsWith(MEMBER_CUSTOM_ID_PREFIX)) return;
    try {
      if (interaction.isChatInputCommand()) await this.command(interaction);
      else if (interaction.customId.startsWith(MEMBER_CUSTOM_ID_PREFIX)) await this.memberPage(interaction);
      else await this.verify(interaction);
    } catch (error) {
      this.deps.logger.write('error', 'interaction_failed', {
        error: error instanceof SetupError ? error.message : errorSummary(error),
      });
      await this.respond(interaction, 'Something went wrong',
        'Please try again shortly. If this continues, let the dvc.labs team know so they can check the bot.');
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
            await this.respond(interaction, 'Member not found', 'That account is not currently a member of dvc.labs.');
            return;
          }
          await interaction.editReply(memberCard(report, interaction.user.id, 0));
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
          discord: outcome !== 'cooldown' && outcome !== 'rate_limited',
          ...(targetUserId ? { targetUserId } : {}),
          ...(detail ? { detail } : {}) });
      }
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
        channelId: interaction.channelId });
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
      const report = await this.deps.memberReport(navigation.userId);
      if (!report) {
        outcome = 'member_not_found';
        await this.respond(interaction, 'Member not found', 'That account is no longer a member of dvc.labs.');
        return;
      }
      await interaction.editReply(memberCard(report, interaction.user.id, navigation.page));
      outcome = 'success';
    } finally {
      permit.release();
      audit.record({ event: 'member_lookup_page', title: 'Member details viewed', outcome, userId: interaction.user.id,
        targetUserId: navigation.userId, channelId: interaction.channelId, discord: false });
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
        detail: error instanceof SetupError ? error.message : errorSummary(error) });
      throw error;
    }
    audit.record({
      event: result === 'awarded' ? 'verification_succeeded' : 'verification_attempt',
      title: result === 'awarded' ? `${DVC_EMOJI} Member verified` : 'Verification attempt',
      outcome: result, userId: interaction.user.id, channelId: interaction.channelId,
      discord: result !== 'cooldown' && result !== 'processing',
      ...(result === 'awarded' ? { roleId: config.verificationRoleId } : {}),
    });
    const [title, description] = verificationReplies[result];
    // Reply failures cannot undo the role or produce a false verification-failure log.
    await this.respond(interaction, result === 'awarded' ? `${DVC_EMOJI} Member verified` : title,
      result === 'awarded' ? `Welcome to dvc.labs, ${userMention(interaction.user.id)}! Your ${roleMention(config.verificationRoleId)} role has been added and the community is now unlocked.` : description);
  }
}
