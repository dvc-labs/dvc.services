import {
  ButtonBuilder, ButtonStyle, LabelBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  TextInputBuilder, TextInputStyle, userMention, type ButtonInteraction, type ChatInputCommandInteraction,
  type ModalSubmitInteraction, type TextChannel,
} from 'discord.js';
import type { AuditLog } from './audit.js';
import type { Config } from './config.js';
import { SetupError } from './errors.js';
import { errorSummary } from './logger.js';
import { Cooldown, hasEnabledButton, hasMatchingButton, serverAccessRole } from './policy.js';
import type { CherryApproval, CherryApprovalStore } from './state.js';
import { card, discordTime } from './ui.js';

export const CHERRY_MODAL_ID = 'dvc:cherry:v1:request';
export const CHERRY_REVIEW_PREFIX = 'dvc:cherry:v1:review:';
const USERNAME_FIELD = 'java_username';
const JAVA_USERNAME = /^[A-Za-z0-9_]{3,16}$/;
const SERVER = 'play.cherrycreek.app';
const WEBSITE = 'https://cherrycreek.app/';
const CHERRY_COLOR = 0xffb7c5;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_CHECK_BUDGET_MS = 20_000;

interface CherryRequest { applicantId: string; username: string }
export interface MinecrafterGateway {
  readonly roleId: string;
  prepareAward(userId: string): Promise<() => Promise<void>>;
  hasRole(userId: string, roleId: string): Promise<boolean>;
}
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
    private readonly audit: AuditLog, private readonly approvals: CherryApprovalStore,
    private readonly minecrafter: MinecrafterGateway, private readonly now = Date.now) {
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

  private async hasPendingRequest(applicantId: string): Promise<boolean> {
    const deadline = this.now() + HISTORY_CHECK_BUDGET_MS;
    const assertCanCheck = () => {
      if (this.now() >= deadline) throw new SetupError('Cherry Creek moderation history check exceeded its time budget.');
      // Discord can return an empty page for missing Read Message History.
      if (!this.mod.permissionsFor(this.config.applicationId)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        throw new SetupError('Cherry Creek needs View Channel and Read Message History in MOD_CHANNEL_ID to check pending requests.');
      }
    };
    let before: string | undefined;
    assertCanCheck();
    for (;;) {
      const messages = await this.mod.messages.fetch({ limit: HISTORY_PAGE_SIZE, cache: false, ...(before ? { before } : {}) });
      assertCanCheck();
      if (messages.some(message => message.author.id === this.config.applicationId
        && hasMatchingButton(message.components.map(component => component.toJSON()),
          (id, disabled) => !disabled && parseReview(id)?.applicantId === applicantId))) return true;
      if (messages.size < HISTORY_PAGE_SIZE) return false;
      const next = messages.lastKey()!;
      if (before && BigInt(next) >= BigInt(before)) throw new SetupError('Cherry Creek moderation history pagination did not advance.');
      before = next;
    }
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
      let pending: boolean;
      try { pending = await this.hasPendingRequest(applicantId); }
      catch (error) {
        this.audit.record({ event: 'cherry_pending_check_failed', title: 'Cherry Creek pending request check failed',
          outcome: 'history_unconfirmed', userId: applicantId, channelId: this.mod.id, discord: false,
          detail: error instanceof SetupError ? error.message : errorSummary(error) });
        await this.reply(interaction, 'Request not sent', 'The bot couldn’t check for a pending request. Please try again later or ask a moderator.');
        return;
      }
      if (pending) {
        this.audit.record({ event: 'cherry_request_blocked', title: 'Cherry Creek request already pending',
          outcome: 'already_pending', userId: applicantId, channelId: this.mod.id, discord: false });
        await this.reply(interaction, 'Request already pending', 'You already have an open Cherry Creek request. Please wait for the team to review it.');
        return;
      }
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
    if (this.reviewing.has(messageId)) {
      await this.reply(interaction, 'Review in progress', 'Give the bot a moment, then check the request card.');
      return;
    }
    if (this.reviewing.size >= 5) {
      await this.reply(interaction, 'Review queue busy', 'The bot is handling other requests. Please try again shortly.');
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
      const key = { guildId: this.config.guildId, requestId: messageId };
      let approval: CherryApproval | undefined;
      try {
        const existing = this.approvals.get(key);
        if (existing && (existing.applicantId !== action.applicantId
          || (action.decision === 'accepted' && existing.roleId !== this.minecrafter.roleId))) {
          await this.reply(interaction, 'Approval requires staff attention',
            'The saved approval no longer matches this card or the configured Minecrafter role. Ask the server owner to reconcile it.');
          return;
        }
        if (existing?.announcementId) {
          await this.reply(interaction, 'Request already accepted', 'This approval and its Minecraft announcement were already saved.');
          return;
        }
        if (action.decision === 'declined' && existing) {
          let roleHeld = existing.roleConfirmed;
          if (!roleHeld) {
            try { roleHeld = await this.minecrafter.hasRole(existing.applicantId, existing.roleId); }
            catch (error) {
              this.logRoleFailure(interaction, existing, 'decline_check_failed', error);
              await this.reply(interaction, 'Could not check Minecrafter',
                'Discord did not confirm the applicant’s roles. Try Decline again in a moment.');
              return;
            }
          }
          if (roleHeld) {
            await this.reply(interaction, 'Approval cannot be declined',
              'The Minecrafter role was confirmed or is already held. Ask the server owner to reconcile the role and Paper whitelist.');
            return;
          }
          this.approvals.cancelUnconfirmed(key);
        }
        if (action.decision === 'accepted') {
          approval = existing ?? { ...key, applicantId: action.applicantId, moderatorId: interaction.user.id,
            roleId: this.minecrafter.roleId, approvedAt: this.now() };
          let grant: () => Promise<void>;
          try { grant = await this.minecrafter.prepareAward(action.applicantId); }
          catch (error) {
            this.logRoleFailure(interaction, approval, 'preflight_failed', error);
            await this.reply(interaction, 'Applicant could not be approved',
              'Check that the applicant is still verified and that the bot can assign Minecrafter. Try Accept again or use Decline if the request should be closed.');
            return;
          }
          if (!existing) this.approvals.begin(approval);
          try { await grant(); }
          catch (error) {
            this.logRoleFailure(interaction, approval, 'role_unconfirmed', error);
            await this.reply(interaction, 'Minecrafter role not confirmed',
              'No announcement was sent. Retry Accept, or use Decline if the role was not granted and the request should be closed.');
            return;
          }
          this.approvals.confirmRole(key);
        }
      } catch (error) {
        this.audit.record({ event: 'cherry_approval_storage_failed', title: 'Cherry Creek approval could not be saved',
          outcome: 'storage_unconfirmed', actorId: interaction.user.id, targetUserId: action.applicantId,
          channelId: this.mod.id, priority: 'critical', detail: errorSummary(error), fields: [this.requestLink(messageId)] });
        await this.reply(interaction, 'Approval save not confirmed',
          'No announcement was sent. Ask the server owner to check the bot’s storage before trying again.');
        return;
      }
      const review: Review = { decision: action.decision, moderatorId: approval?.moderatorId ?? interaction.user.id,
        at: approval?.approvedAt ?? this.now(),
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
        ...(approval ? { roleId: approval.roleId } : {}),
        fields: [this.requestLink(messageId)], priority: 'important' });
      if (review.decision === 'declined') {
        await this.reply(interaction, 'Request declined',
          'The moderation card is closed. If you already whitelisted this Java account in Paper, remove it there too.');
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
      try { this.approvals.recordNotice(key, announcementId); }
      catch (error) {
        this.audit.record({ event: 'cherry_notice_record_failed', title: 'Cherry Creek notice record could not be saved',
          outcome: 'error', channelId: this.minecraft.id, fields: [this.requestLink(messageId), { name: 'Announcement', value: link }],
          priority: 'critical', detail: errorSummary(error) });
      }
      try { await this.mod.messages.edit(messageId, requestCard(action, { ...review, notification: link })); }
      catch (error) {
        this.audit.record({ event: 'cherry_receipt_failed', title: 'Cherry Creek receipt could not be updated', outcome: 'error',
          channelId: this.mod.id, fields: [this.requestLink(messageId), { name: 'Announcement', value: link }],
          priority: 'critical', detail: errorSummary(error) });
      }
      this.audit.record({ event: 'cherry_notice_sent', title: 'Cherry Creek applicant notified', outcome: 'sent',
        actorId: review.moderatorId, targetUserId: action.applicantId, channelId: this.minecraft.id,
        fields: [this.requestLink(messageId), { name: 'Announcement', value: link }], priority: 'important' });
      await this.reply(interaction, 'Request accepted', 'The Minecrafter role is set and the applicant was notified in the Minecraft channel. ' + link);
    } finally { this.reviewing.delete(messageId); }
  }

  private logRoleFailure(interaction: ButtonInteraction, approval: CherryApproval, outcome: string, error: unknown): void {
    this.audit.record({ event: 'cherry_role_failed', title: 'Minecrafter role could not be confirmed', outcome,
      actorId: interaction.user.id, targetUserId: approval.applicantId, roleId: approval.roleId, channelId: this.mod.id,
      priority: 'critical', detail: error instanceof SetupError ? error.message : errorSummary(error),
      fields: [this.requestLink(approval.requestId)] });
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
