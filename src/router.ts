import { MessageFlags, PermissionFlagsBits, type ButtonInteraction,
  type ChatInputCommandInteraction, type Interaction } from 'discord.js';
import type { AuditLog } from './audit.js';
import type { Config } from './config.js';
import { errorSummary, type Logger } from './logger.js';
import { Cooldown, isTrustedVerificationButton, VERIFY_CUSTOM_ID } from './policy.js';
import { aboutEmbed, embed } from './ui.js';
import type { VerificationResult, VerificationService } from './verification.js';

export interface RouterDependencies {
  config: Config;
  botId: () => string;
  isReady: () => boolean;
  panelId: () => string | undefined;
  refreshPanel: () => Promise<{ id: string; created: boolean }>;
  verification: () => VerificationService;
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
  constructor(private readonly deps: RouterDependencies) {}

  async handle(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() && !interaction.isButton()) return;
    // Ignore unrelated components if more features are added later.
    if (interaction.isButton() && interaction.customId !== VERIFY_CUSTOM_ID) return;
    try {
      if (interaction.isChatInputCommand()) await this.command(interaction);
      else await this.verify(interaction);
    } catch (error) {
      this.deps.logger.write('error', 'interaction_failed', { error: errorSummary(error) });
      await this.privateReply(interaction, 'Something went wrong',
        'Please try again shortly. If this continues, let the dvc.labs team know so they can check the bot.');
    }
  }

  private async privateReply(interaction: ChatInputCommandInteraction | ButtonInteraction,
    title: string, description: string): Promise<void> {
    try {
      const payload = { embeds: [embed(title, description)], allowedMentions: { parse: [] as never[] } };
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
    } catch (error) {
      this.deps.logger.write('warn', 'interaction_reply_failed', { error: errorSummary(error) });
    }
  }

  private async command(interaction: ChatInputCommandInteraction): Promise<void> {
    const { config, audit } = this.deps;
    let outcome = 'error';
    try {
      if (interaction.guildId !== config.guildId) {
        outcome = 'denied_guild';
        await this.privateReply(interaction, 'dvc.labs only', 'This bot is configured for the dvc.labs server.');
        return;
      }
      if (!this.deps.isReady()) {
        outcome = 'not_ready';
        await this.privateReply(interaction, 'Starting up', 'The bot is getting ready. Please try again shortly.');
        return;
      }
      if (interaction.channelId !== config.commandsChannelId) {
        outcome = 'denied_channel';
        await this.privateReply(interaction, 'Commands channel', `Please use this command in <#${config.commandsChannelId}>.`);
        return;
      }
      if (interaction.commandName === 'verification'
        && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        outcome = 'denied_permission';
        await this.privateReply(interaction, 'Team command', 'You need Manage Server permission to refresh the verification panel.');
        return;
      }
      if (!this.commandCooldown.take(interaction.user.id)) {
        outcome = 'cooldown';
        await this.privateReply(interaction, 'Just a moment', 'Please wait a few seconds before using another command.');
        return;
      }
      if (interaction.commandName === 'about') {
        await interaction.reply({ embeds: [aboutEmbed(config, process.uptime())], allowedMentions: { parse: [] } });
        outcome = 'success';
      } else if (interaction.commandName === 'verification') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const panel = await this.deps.refreshPanel();
        audit.record({ event: 'verification_panel_updated', title: 'Verification panel ready',
          outcome: panel.created ? 'created' : 'updated', userId: interaction.user.id,
          channelId: config.verificationChannelId, detail: `Message ID: ${panel.id}` });
        outcome = 'success';
        await this.privateReply(interaction, 'Verification panel ready',
          `The panel has been ${panel.created ? 'created' : 'updated'} in <#${config.verificationChannelId}>.`);
      } else {
        outcome = 'unknown_command';
        await this.privateReply(interaction, 'Command unavailable', 'Please refresh Discord’s command list and try again.');
      }
    } finally {
      if (interaction.guildId === config.guildId) {
        audit.record({ event: 'command_used', title: 'Command used', outcome,
          userId: interaction.user.id, channelId: interaction.channelId, command: interaction.commandName });
      }
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
      await this.privateReply(interaction, 'Verification unavailable',
        `Please use the current verification panel in <#${config.verificationChannelId}> once the bot is online.`);
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let result: VerificationResult;
    try { result = await this.deps.verification().verify(interaction.user.id); }
    catch (error) {
      audit.record({ event: 'verification_failed', title: 'Verification failed', outcome: 'error',
        userId: interaction.user.id, channelId: interaction.channelId, detail: errorSummary(error) });
      throw error;
    }
    audit.record({
      event: result === 'awarded' ? 'verification_succeeded' : 'verification_attempt',
      title: result === 'awarded' ? 'Member verified — role awarded' : 'Verification attempt',
      outcome: result, userId: interaction.user.id, channelId: interaction.channelId,
      ...(result === 'awarded' ? { roleId: config.verificationRoleId } : {}),
    });
    const [title, description] = verificationReplies[result];
    // Reply failures cannot undo the role or produce a false verification-failure log.
    await this.privateReply(interaction, title, description);
  }
}
