import {
  ButtonBuilder, ButtonStyle, LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  TextInputBuilder, TextInputStyle, userMention, type ButtonInteraction, type ChatInputCommandInteraction,
  type ModalSubmitInteraction, type TextChannel,
} from 'discord.js';
import type { AuditLog } from './audit.js';
import type { Config } from './config.js';
import { errorSummary } from './logger.js';
import { Cooldown, hasEnabledButton, serverAccessRole } from './policy.js';
import { card, discordTime } from './ui.js';

export const CHERRY_MODAL_ID = 'dvc:cherry:v1:request';
export const CHERRY_REVIEW_PREFIX = 'dvc:cherry:v1:review:';
const USERNAME_FIELD = 'java_username';
const JAVA_USERNAME = /^[A-Za-z0-9_]{3,16}$/;
const SERVER = 'play.cherrycreek.app';
const WEBSITE = 'https://cherrycreek.app/';
const CHERRY_COLOR = 0xffb7c5;

interface CherryRequest { applicantId: string; username: string }
type Decision = 'accepted' | 'declined';
type Review = { decision: Decision; moderatorId: string; at: number; notification?: string };
type CherryInteraction = ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction;

function reviewId(request: CherryRequest, decision: Decision): string {
  return CHERRY_REVIEW_PREFIX + decision + ':' + request.applicantId + ':' + request.username;
}

function parseReview(customId: string): (CherryRequest & { decision: Decision }) | undefined {
  const match = /^dvc:cherry:v1:review:(accepted|declined):(\d{17,20}):([A-Za-z0-9_]{3,16})$/.exec(customId);
  if (!match || !JAVA_USERNAME.test(match[3]!)) return undefined;
  return { decision: match[1] as Decision, applicantId: match[2]!, username: match[3]! };
}

function requestCard(request: CherryRequest, review?: Review) {
  const code = (value: string) => '`' + value + '`';
  return card('Cherry Creek · Whitelist request',
    review ? 'This request has been reviewed.' : 'If accepting, first add the Java account in the Paper console. Click **Accept** only after the console confirms it.', [
      { name: 'Applicant', value: userMention(request.applicantId) },
      { name: 'Java username', value: code(request.username) },
      { name: 'Status', value: review ? review.decision === 'accepted' ? 'Accepted' : 'Declined' : 'Awaiting review' },
      ...(review ? [
        { name: 'Reviewed by', value: userMention(review.moderatorId) + ' · ' + discordTime(review.at) },
        ...(review.notification ? [{ name: 'Minecraft notification', value: review.notification }] : []),
      ] : [{ name: 'Paper console', value: code('whitelist add ' + request.username) }]),
    ], { accentColor: CHERRY_COLOR, ...(review ? {} : { buttons: [
      new ButtonBuilder().setCustomId(reviewId(request, 'accepted')).setLabel('Accept').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(reviewId(request, 'declined')).setLabel('Decline').setStyle(ButtonStyle.Danger),
    ] }) });
}

function approvalCard(applicantId: string) {
  return {
    ...card('Welcome to Cherry Creek!',
      userMention(applicantId) + ', your Minecraft Java account has been whitelisted. Add the server in **Multiplayer** and come say hi!', [
        { name: 'Java server address', value: '`' + SERVER + '`' },
      ], { accentColor: CHERRY_COLOR, buttons: [
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Cherry Creek website').setURL(WEBSITE),
      ] }),
    allowedMentions: { parse: [], users: [applicantId], repliedUser: false },
  } as const;
}

function requestForm() {
  return new ModalBuilder().setCustomId(CHERRY_MODAL_ID).setTitle('Join Cherry Creek')
    .addLabelComponents(new LabelBuilder().setLabel('Minecraft Java username')
      .setDescription('Use your in-game Java name. Your Discord account and username go to the moderation team.')
      .setTextInputComponent(new TextInputBuilder().setCustomId(USERNAME_FIELD)
        .setStyle(TextInputStyle.Short).setPlaceholder('e.g. CherryMiner').setRequired(true)
        .setMinLength(3).setMaxLength(16)));
}

export class CherryCreek {
  private readonly submissionCooldown: Cooldown;
  private readonly submitting = new Set<string>();
  private readonly reviewing = new Set<string>();

  constructor(private readonly config: Config, private readonly mod: TextChannel, private readonly minecraft: TextChannel,
    private readonly audit: AuditLog, private readonly now = Date.now) {
    this.submissionCooldown = new Cooldown(60_000, now);
  }

  private acceptsChannel(channelId: string | null): boolean {
    return channelId === this.minecraft.id || channelId === this.config.commandsChannelId;
  }

  private eligible(interaction: ChatInputCommandInteraction | ModalSubmitInteraction): boolean {
    const { member } = interaction;
    if (interaction.guildId !== this.config.guildId || !this.acceptsChannel(interaction.channelId)
      || !member || member.pending || interaction.user.bot) return false;
    const roles = Array.isArray(member.roles) ? new Set(member.roles) : member.roles.cache;
    return !!serverAccessRole(roles, this.config);
  }

  async open(interaction: ChatInputCommandInteraction): Promise<string> {
    if (!this.eligible(interaction)) {
      await this.reply(interaction, 'Verify first', 'Verify in dvc.labs before requesting access to Cherry Creek.');
      return 'denied_access';
    }
    await interaction.showModal(requestForm());
    return 'form_opened';
  }

  async submit(interaction: ModalSubmitInteraction): Promise<void> {
    if (!this.eligible(interaction)) {
      await this.reply(interaction, 'Request unavailable', 'Verify in dvc.labs, then open a new /cherrycreek form.');
      return;
    }
    const username = interaction.fields.getTextInputValue(USERNAME_FIELD).trim();
    if (!JAVA_USERNAME.test(username)) {
      await this.reply(interaction, 'Check your Java username', 'Use 3–16 letters, numbers, or underscores. Run /cherrycreek to try again.');
      return;
    }
    const applicantId = interaction.user.id;
    if (this.submitting.has(applicantId) || this.submitting.size >= 5 || !this.submissionCooldown.take(applicantId)) {
      await this.reply(interaction, 'Please wait', 'Give your request a minute before submitting another one.');
      return;
    }
    this.submitting.add(applicantId);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let messageId: string;
      try {
        const message = await this.mod.send({ ...requestCard({ applicantId, username }), nonce: 'ccr' + interaction.id, enforceNonce: true });
        messageId = message.id;
      } catch (error) {
        this.audit.record({ event: 'cherry_request_failed', title: 'Cherry Creek request could not be posted',
          outcome: 'delivery_unconfirmed', userId: applicantId, channelId: this.mod.id, detail: errorSummary(error), priority: 'critical' });
        await this.reply(interaction, 'Request delivery unconfirmed',
          'The bot couldn’t confirm delivery. Please ask a moderator to check before submitting again.');
        return;
      }
      this.audit.record({ event: 'cherry_request_submitted', title: 'Cherry Creek request submitted', outcome: 'pending',
        userId: applicantId, channelId: this.mod.id, priority: 'important', fields: [this.requestLink(messageId)] });
      await this.reply(interaction, 'Request sent', 'The Cherry Creek team will review your request. If accepted, you’ll be tagged in the Minecraft channel.');
    } finally { this.submitting.delete(applicantId); }
  }

  async review(interaction: ButtonInteraction, botId: string): Promise<void> {
    const action = parseReview(interaction.customId);
    const staff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      || interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers);
    const messageId = interaction.message.id;
    if (!action || interaction.guildId !== this.config.guildId || interaction.channelId !== this.mod.id
      || interaction.message.author.id !== botId || interaction.user.bot || !staff) {
      if (interaction.guildId === this.config.guildId) this.audit.record({ event: 'cherry_review_denied',
        title: 'Cherry Creek review denied', outcome: 'invalid_source_or_permission', actorId: interaction.user.id,
        channelId: interaction.channelId, discord: false });
      await this.reply(interaction, 'Staff review only', 'Use the buttons on a pending request in the moderation channel.');
      return;
    }
    if (this.reviewing.has(messageId) || this.reviewing.size >= 5) {
      await this.reply(interaction, 'Review in progress', 'Give the bot a moment, then check the request card.');
      return;
    }
    this.reviewing.add(messageId);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let message;
      try { message = await this.mod.messages.fetch({ message: messageId, cache: false, force: true }); }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 10008) throw error;
      }
      if (!message || message.author.id !== botId
        || !hasEnabledButton(message.components.map(component => component.toJSON()), interaction.customId)) {
        await this.reply(interaction, 'Request already closed', 'This request was already reviewed or removed.');
        return;
      }
      const review: Review = { decision: action.decision, moderatorId: interaction.user.id, at: this.now(),
        ...(action.decision === 'accepted' ? { notification: 'Delivery not confirmed yet. Check the Minecraft channel before notifying manually.' } : {}) };
      // Save the final decision to Discord and remove both buttons before an outbound ping.
      // A restart or a later click cannot reopen an accepted request.
      try { await this.mod.messages.edit(messageId, requestCard(action, review)); }
      catch (error) {
        this.audit.record({ event: 'cherry_review_failed', title: 'Cherry Creek review could not be saved', outcome: 'decision_unconfirmed',
          actorId: review.moderatorId, targetUserId: action.applicantId, channelId: this.mod.id,
          fields: [this.requestLink(messageId)], priority: 'critical', detail: errorSummary(error) });
        await this.reply(interaction, 'Review not confirmed', 'Check the moderation card before trying again. No announcement was attempted.');
        return;
      }
      this.audit.record({ event: 'cherry_request_reviewed', title: 'Cherry Creek request reviewed', outcome: review.decision,
        actorId: review.moderatorId, targetUserId: action.applicantId, channelId: this.mod.id,
        fields: [this.requestLink(messageId)], priority: 'important' });
      if (review.decision === 'declined') {
        await this.reply(interaction, 'Request declined', 'The moderation card has been updated.');
        return;
      }
      let announcementId: string;
      try {
        const announcement = await this.minecraft.send({
          ...approvalCard(action.applicantId), nonce: 'cca' + messageId, enforceNonce: true,
        });
        announcementId = announcement.id;
      } catch (error) {
        this.audit.record({ event: 'cherry_notice_failed', title: 'Cherry Creek approval notice unconfirmed',
          outcome: 'delivery_unconfirmed', actorId: review.moderatorId, targetUserId: action.applicantId,
          channelId: this.minecraft.id, fields: [this.requestLink(messageId)], priority: 'critical', detail: errorSummary(error) });
        await this.reply(interaction, 'Accepted · notification unconfirmed',
          'The decision is saved. Check the Minecraft channel before sending a notification yourself.');
        return;
      }
      const link = '[View approval](https://discord.com/channels/' + this.config.guildId + '/' + this.minecraft.id + '/' + announcementId + ')';
      try { await this.mod.messages.edit(messageId, requestCard(action, { ...review, notification: link })); }
      catch (error) {
        this.audit.record({ event: 'cherry_receipt_failed', title: 'Cherry Creek receipt could not be updated', outcome: 'error',
          channelId: this.mod.id, fields: [this.requestLink(messageId), { name: 'Announcement', value: link }],
          priority: 'critical', detail: errorSummary(error) });
      }
      this.audit.record({ event: 'cherry_notice_sent', title: 'Cherry Creek applicant notified', outcome: 'sent',
        actorId: review.moderatorId, targetUserId: action.applicantId, channelId: this.minecraft.id,
        fields: [this.requestLink(messageId), { name: 'Announcement', value: link }], priority: 'important' });
      await this.reply(interaction, 'Request accepted', 'The applicant was notified in the Minecraft channel. ' + link);
    } finally { this.reviewing.delete(messageId); }
  }

  private requestLink(id: string) {
    return { name: 'Request', value: '[Open moderation card](https://discord.com/channels/' + this.config.guildId + '/' + this.mod.id + '/' + id + ')' };
  }

  private async reply(interaction: CherryInteraction, title: string, description: string): Promise<void> {
    const payload = card(title, description, [], { accentColor: CHERRY_COLOR });
    if (interaction.deferred) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: payload.flags | MessageFlags.Ephemeral });
  }
}
