import {
  AuditLogEvent, channelMention, roleMention, type Guild, type GuildAuditLogsEntry,
  type GuildMember, type PartialGuildMember, type VoiceState,
} from 'discord.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuditLog } from './audit.js';
import type { Config } from './config.js';
import { errorSummary } from './logger.js';
import { Cooldown, OWN_ROLE_AUDIT_REASONS } from './policy.js';
import { brandedTitle, discordTime, displayText, humanise, welcomeMessage, type CardField } from './ui.js';

interface ActivityDependencies {
  config: Config;
  audit: AuditLog;
  isReady: () => boolean;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function changedRoles(entry: GuildAuditLogsEntry, key: '$add' | '$remove'): string | undefined {
  const value = entry.changes.find(change => change.key === key)?.new;
  if (!Array.isArray(value)) return undefined;
  const roles = value.flatMap(role => role && typeof role === 'object'
    && 'id' in role && typeof role.id === 'string' && /^\d{17,20}$/.test(role.id) ? [role.id] : []);
  return roles.length ? roles.slice(0, 40).map(roleMention).join(' · ')
    + (roles.length > 40 ? ` · and ${roles.length - 40} more` : '') : undefined;
}

export class GuildActivity {
  private readonly recentJoins = new Map<string, number | null>();
  private readonly auditIds = new Cooldown(3_600_000);
  private readonly welcomeQueue: GuildMember[] = [];
  private draining: Promise<void> | undefined;
  private stopped = false;
  private readonly welcomeStop = new AbortController();
  private readonly now: () => number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private nextWelcomeAt = 0;

  constructor(private readonly deps: ActivityDependencies) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  private title(text: string): string { return brandedTitle(text, this.deps.config.emoji); }

  private accepts(guildId: string): boolean {
    return !this.stopped && this.deps.isReady() && guildId === this.deps.config.guildId;
  }

  joined(member: GuildMember): void {
    if (!this.accepts(member.guild.id)) return;
    if (this.recentJoins.has(member.id) && this.recentJoins.get(member.id) === member.joinedTimestamp) return;
    if (this.recentJoins.size >= 1_000) this.recentJoins.delete(this.recentJoins.keys().next().value!);
    this.recentJoins.set(member.id, member.joinedTimestamp);
    this.deps.audit.record({ event: 'member_joined', title: this.title('Member joined'),
      outcome: 'joined', userId: member.id, fields: [
        { name: 'Account created', value: discordTime(member.user.createdTimestamp) },
        { name: 'Joined', value: discordTime(member.joinedTimestamp) },
        { name: 'Server members', value: String(member.guild.memberCount) },
      ] });
    if (member.user.bot) return;
    if (this.welcomeQueue.length >= 50) {
      this.deps.audit.record({ event: 'welcome_dm', title: 'Welcome DM not sent', outcome: 'queue_full', userId: member.id, discord: false });
      return;
    }
    this.welcomeQueue.push(member);
    this.startDrain();
  }

  private startDrain(): void {
    this.draining ??= this.drainWelcomes().finally(() => {
      this.draining = undefined;
      if (this.welcomeQueue.length && !this.stopped) this.startDrain();
    });
  }

  private async drainWelcomes(): Promise<void> {
    while (this.welcomeQueue.length && !this.stopped) {
      const member = this.welcomeQueue.shift()!;
      const waitMs = Math.max(0, this.nextWelcomeAt - this.now());
      if (waitMs) {
        try { await this.wait(waitMs, this.welcomeStop.signal); }
        catch (error) {
          if (!this.stopped) this.deps.audit.record({ event: 'welcome_dm', title: 'Welcome DM not sent',
            outcome: 'pacing_failed', userId: member.id, detail: errorSummary(error), discord: false });
          return;
        }
      }
      if (this.stopped) return;
      if (!this.recentJoins.has(member.id) || this.recentJoins.get(member.id) !== member.joinedTimestamp) continue;
      this.nextWelcomeAt = this.now() + 1_500;
      try {
        await member.send(welcomeMessage(this.deps.config, member.id));
        this.deps.audit.record({ event: 'welcome_dm', title: 'Welcome DM sent', outcome: 'sent', userId: member.id, discord: false });
      } catch (error) {
        // A member's DM/privacy settings must never interrupt startup or verification.
        this.deps.audit.record({ event: 'welcome_dm', title: 'Welcome DM not delivered', outcome: 'not_delivered',
          userId: member.id, detail: errorSummary(error), discord: false });
      }
    }
  }

  left(member: GuildMember | PartialGuildMember): void {
    if (!this.accepts(member.guild.id)) return;
    this.recentJoins.delete(member.id);
    this.deps.audit.record({ event: 'member_left', title: this.title('Member left'), outcome: 'left',
      userId: member.id, fields: [{ name: 'Server members', value: String(member.guild.memberCount) }] });
  }

  updated(before: GuildMember | PartialGuildMember, after: GuildMember): void {
    if (!this.accepts(after.guild.id)) return;
    if (before.partial) {
      this.deps.audit.record({ event: 'member_updated', title: this.title('Member state observed'),
        outcome: 'snapshot', userId: after.id, detail: 'Previous state was not cached; these are current values, not inferred changes.',
        fields: [
          { name: 'Nickname', value: displayText(after.nickname ?? 'Not set', 100) },
          { name: 'Rules screening', value: after.pending ? 'Pending' : 'No pending screening' },
          { name: 'Server boost', value: after.premiumSinceTimestamp ? discordTime(after.premiumSinceTimestamp) : 'Not boosting' },
          { name: 'Timeout', value: after.isCommunicationDisabled() ? discordTime(after.communicationDisabledUntilTimestamp) : 'Not timed out' },
        ] });
      return;
    }
    const fields: CardField[] = [];
    if (before.nickname !== after.nickname) fields.push({ name: 'Nickname',
      value: `${displayText(before.nickname ?? 'Not set', 100)} → ${displayText(after.nickname ?? 'Not set', 100)}` });
    if (before.pending !== after.pending) fields.push({ name: 'Rules screening', value: after.pending ? 'Pending' : 'Completed' });
    if (before.premiumSinceTimestamp !== after.premiumSinceTimestamp) fields.push({ name: 'Server boost',
      value: after.premiumSinceTimestamp ? `Boosting since ${discordTime(after.premiumSinceTimestamp)}` : 'No longer boosting' });
    if (before.communicationDisabledUntilTimestamp !== after.communicationDisabledUntilTimestamp) fields.push({ name: 'Timeout',
      value: after.isCommunicationDisabled() ? discordTime(after.communicationDisabledUntilTimestamp) : 'Removed or expired' });
    if (fields.length) this.deps.audit.record({ event: 'member_updated', title: this.title('Member updated'),
      outcome: 'updated', userId: after.id, fields });
  }

  auditEntry(entry: GuildAuditLogsEntry, guild: Guild): void {
    if (!this.accepts(guild.id) || !this.auditIds.take(entry.id)) return;
    const action = humanise(AuditLogEvent[entry.action] ?? `Action ${entry.action}`);
    const fields: CardField[] = [{ name: 'Action', value: action }, { name: 'Audit entry', value: `\`${entry.id}\`` }];
    if (entry.reason) fields.push({ name: 'Reason', value: displayText(entry.reason, 600) });
    for (const [key, name] of [['$add', 'Roles added'], ['$remove', 'Roles removed']] as const) {
      const value = changedRoles(entry, key);
      if (value) fields.push({ name, value });
    }
    const changed = entry.changes.filter(change => !['$add', '$remove'].includes(change.key)).map(change => humanise(change.key));
    if (changed.length) fields.push({ name: 'Changed fields', value: changed.join(' · ').slice(0, 300) });
    const messageUser = entry.targetType === 'Message' && entry.action !== AuditLogEvent.MessageBulkDelete;
    const userId = entry.targetType === 'User' || messageUser ? entry.targetId : null;
    const roleId = entry.targetType === 'Role' ? entry.targetId : null;
    let channelId = entry.targetType === 'Channel' || entry.targetType === 'Thread'
      || entry.action === AuditLogEvent.MessageBulkDelete ? entry.targetId : null;
    const extra = entry.extra;
    if (!channelId && extra && typeof extra === 'object' && 'channel' in extra) {
      const channel = extra.channel;
      if (channel && typeof channel === 'object' && 'id' in channel && typeof channel.id === 'string') channelId = channel.id;
    }
    if (entry.targetId && !userId && !roleId && !channelId) {
      fields.push({ name: 'Target ID', value: `\`${entry.targetId}\` (${humanise(entry.targetType)})` });
    }
    if (entry.target && 'name' in entry.target && typeof entry.target.name === 'string') {
      fields.push({ name: 'Recorded target name', value: displayText(entry.target.name, 150) });
    }
    this.deps.audit.record({ event: 'server_audit_entry', title: this.title('Server audit'), outcome: 'recorded', fields,
      ...(entry.executorId ? { actorId: entry.executorId } : {}),
      ...(userId ? { userId } : {}), ...(roleId ? { roleId } : {}), ...(channelId ? { channelId } : {}),
      // Verification and Bulletin results already record our own role changes; keep this trace in the console.
      discord: !(entry.action === AuditLogEvent.MemberRoleUpdate && entry.executorId === this.deps.config.applicationId
        && OWN_ROLE_AUDIT_REASONS.has(entry.reason ?? '')) });
  }

  voiceChanged(before: VoiceState, after: VoiceState): void {
    if (!this.accepts(after.guild.id) || before.channelId === after.channelId) return;
    this.deps.audit.record({ event: 'voice_channel_changed', title: this.title('Voice activity'),
      outcome: after.channelId ? before.channelId ? 'moved' : 'joined' : 'left', userId: after.id,
      ...(after.channelId ? { channelId: after.channelId } : {}),
      fields: before.channelId ? [{ name: 'Previous channel', value: channelMention(before.channelId) }] : [] });
  }

  stop(): void { this.stopped = true; this.welcomeQueue.length = 0; this.welcomeStop.abort(); }
  async flush(): Promise<void> { while (this.draining) await this.draining; }
}
