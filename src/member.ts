import {
  ActivityType, ButtonBuilder, ButtonStyle, PermissionFlagsBits, channelMention, roleMention, userMention,
  type Guild, type GuildMember, type User,
} from 'discord.js';
import type { Config } from './config.js';
import { MEMBER_CUSTOM_ID_PREFIX } from './policy.js';
import { brandedTitle, card, discordTime, displayText, humanise, type CardField } from './ui.js';

export interface MemberPage { title: string; fields: CardField[]; staffOnly?: boolean }
export interface MemberReport { userId: string; thumbnail: string; pages: MemberPage[]; emoji?: string }

function splitValues(values: string[], limit = 1_800): string[] {
  if (!values.length) return ['None'];
  const chunks: string[] = [];
  let current = '';
  for (const value of values) {
    if (current && current.length + value.length + 3 > limit) { chunks.push(current); current = ''; }
    current += `${current ? ' · ' : ''}${value}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

function yesNo(value: boolean | null): string { return value === null ? 'Not observed' : value ? 'Yes' : 'No'; }
function profileLink(label: string, url: string | null | undefined): string {
  return url ? `[${label}](${url})` : 'Not set';
}

export function buildMemberReport(member: GuildMember, user: User, config: Config): MemberReport {
  const pages: MemberPage[] = [];
  // Split by rendered length, not role count: even a 250-role member stays within V2 limits.
  function addPage(title: string, fields: CardField[], staffOnly = false): void {
    let part: CardField[] = [];
    let length = 0;
    for (const field of fields) {
      const size = field.name.length + field.value.length + 8;
      if (part.length && length + size > 2_400) { pages.push({ title, fields: part, staffOnly }); part = []; length = 0; }
      part.push(field); length += size;
    }
    if (part.length) pages.push({ title, fields: part, staffOnly });
  }

  addPage('Overview', [
    { name: 'Member', value: `${userMention(user.id)} · \`${user.id}\`` },
    { name: 'Username', value: displayText(user.tag, 100) },
    { name: 'Global display name', value: user.globalName ? displayText(user.globalName, 100) : 'Not set' },
    { name: 'Server display name', value: displayText(member.displayName, 100) },
    { name: 'Nickname', value: member.nickname ? displayText(member.nickname, 100) : 'Not set' },
    { name: 'Account type', value: user.system ? 'Discord system account' : user.bot ? 'Bot' : 'Member' },
    { name: 'Account created', value: discordTime(user.createdTimestamp) },
    { name: 'Joined dvc.labs', value: discordTime(member.joinedTimestamp) },
    { name: 'Verification', value: member.roles.cache.has(config.verificationRoleId) ? `Has ${roleMention(config.verificationRoleId)}` : 'Not verified' },
  ]);
  addPage('Server membership', [
    { name: 'Server owner', value: yesNo(member.guild.ownerId === user.id) },
    { name: 'Highest role', value: member.roles.highest.id === member.guild.id ? '@everyone' : roleMention(member.roles.highest.id) },
    { name: 'Boosting since', value: member.premiumSinceTimestamp ? discordTime(member.premiumSinceTimestamp) : 'Not boosting' },
    { name: 'Public account badges / flags', value: user.flags?.toArray().map(humanise).join(' · ') || 'None exposed' },
  ]);
  addPage('Staff membership', [
    { name: 'Rules screening', value: member.pending ? 'Pending' : 'No pending screening' },
    { name: 'Timeout', value: member.isCommunicationDisabled() ? discordTime(member.communicationDisabledUntilTimestamp) : 'Not timed out' },
    { name: 'Member flags', value: member.flags.toArray().map(humanise).join(' · ') || 'None' },
    { name: 'Bot hierarchy capabilities', value: `Manageable: ${yesNo(member.manageable)} · Kickable: ${yesNo(member.kickable)}\nBannable: ${yesNo(member.bannable)} · Can timeout: ${yesNo(member.moderatable)}\nThese describe the bot’s current permissions and role order.` },
  ], true);
  const roles = [...member.roles.cache.values()].filter(role => role.id !== member.guild.id)
    .sort((a, b) => b.comparePositionTo(a));
  const roleChunks = splitValues(roles.map(role => roleMention(role.id)));
  roleChunks.forEach((value, index) => addPage(`Roles ${index + 1}/${roleChunks.length}`, [
    { name: `Roles (${roles.length}, excluding @everyone)`, value },
  ]));
  const permissionChunks = splitValues(member.permissions.toArray().map(humanise));
  permissionChunks.forEach((value, index) => addPage(`Permissions ${index + 1}/${permissionChunks.length}`, [
    { name: 'Effective server permissions', value },
    { name: 'Channel access', value: 'Individual channel overrides still apply.' },
  ], true));

  const presence = member.presence;
  const activities = presence?.activities.map(activity => {
    const details = [displayText(activity.name, 100), activity.details && displayText(activity.details, 150),
      activity.state && displayText(activity.state, 150)].filter(Boolean).join(' — ');
    return `${humanise(ActivityType[activity.type] ?? 'Activity')}: ${details}`;
  }) ?? [];
  const activityChunks = splitValues(activities);
  addPage('Presence and voice', [
    { name: 'Presence', value: presence ? humanise(presence.status) : 'Not observed — may be offline, invisible, or outside the bounded cache' },
    { name: 'Devices', value: presence?.clientStatus ? Object.entries(presence.clientStatus)
      .map(([device, status]) => `${humanise(device)}: ${humanise(status)}`).join(' · ') || 'Not observed' : 'Not observed' },
    { name: 'Current activities', value: activities.length ? activityChunks[0]! : 'None observed' },
    { name: 'Voice channel', value: member.voice.channelId
      ? member.voice.channel?.permissionsFor(member.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)
        ? channelMention(member.voice.channelId) : 'Connected — restricted channel details omitted'
      : 'Not connected' },
    { name: 'Voice status', value: member.voice.channelId
      ? `Server muted: ${yesNo(member.voice.serverMute)} · Server deafened: ${yesNo(member.voice.serverDeaf)}\n`
        + `Self muted: ${yesNo(member.voice.selfMute)} · Self deafened: ${yesNo(member.voice.selfDeaf)}\n`
        + `Streaming: ${yesNo(member.voice.streaming)} · Camera: ${yesNo(member.voice.selfVideo)} · Stage suppressed: ${yesNo(member.voice.suppress)}`
      : 'Not connected' },
  ], true);
  // Additional activities get their own pages instead of silently dropping available data.
  activityChunks.slice(1).forEach(value => {
    addPage('More activities', [{ name: 'Current activities', value }], true);
  });
  const primary = user.primaryGuild;
  addPage('Profile and appearance', [
    { name: 'Account avatar', value: profileLink('Open avatar', user.displayAvatarURL({ size: 1024 })) },
    { name: 'Server avatar', value: profileLink('Open server avatar', member.avatarURL({ size: 1024 })) },
    { name: 'Account banner', value: profileLink('Open banner', user.bannerURL({ size: 1024 })) },
    { name: 'Server banner', value: profileLink('Open server banner', member.bannerURL({ size: 1024 })) },
    { name: 'Account accent / role colour', value: `${user.hexAccentColor ?? 'No account accent'} · ${member.displayHexColor}` },
    { name: 'Account / server decoration', value: `${profileLink('Account decoration', user.avatarDecorationURL())} · ${profileLink('Server decoration', member.avatarDecorationURL())}` },
    { name: 'Primary guild tag', value: primary?.identityEnabled
      ? `${displayText(primary.tag ?? 'No tag')} · Guild ID: \`${primary.identityGuildId}\`` : 'Not displayed' },
    { name: 'Nameplate', value: user.collectibles?.nameplate ? displayText(user.collectibles.nameplate.label) : 'Not set' },
  ]);
  return { userId: user.id, thumbnail: member.displayAvatarURL({ size: 128 }), pages, emoji: config.emoji };
}

export async function loadMemberReport(guild: Guild, config: Config, userId: string): Promise<MemberReport | null> {
  let member: GuildMember;
  try { member = await guild.members.fetch({ user: userId, cache: false, force: true }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 10007) return null;
    throw error;
  }
  const user = await guild.client.users.fetch(userId, { cache: false, force: true });
  return buildMemberReport(member, user, config);
}

export function memberNavigationId(ownerId: string, userId: string, page: number): string {
  return `${MEMBER_CUSTOM_ID_PREFIX}${ownerId}:${userId}:${page}`;
}

export function parseMemberNavigation(customId: string): { ownerId: string; userId: string; page: number } | null {
  const match = /^dvc:member:v1:(\d{17,20}):(\d{17,20}):(\d{1,2})$/.exec(customId);
  return match ? { ownerId: match[1]!, userId: match[2]!, page: Number(match[3]) } : null;
}

export function memberDetailsId(ownerId: string, userId: string): string {
  return `${MEMBER_CUSTOM_ID_PREFIX}${ownerId}:${userId}:details`;
}

export function parseMemberDetails(customId: string): { ownerId: string; userId: string } | null {
  const match = /^dvc:member:v1:(\d{17,20}):(\d{17,20}):details$/.exec(customId);
  return match ? { ownerId: match[1]!, userId: match[2]! } : null;
}

export function memberView(report: MemberReport, staff: boolean): MemberReport {
  return { ...report, pages: report.pages.filter(page => staff || !page.staffOnly) };
}

export function memberCard(report: MemberReport, ownerId: string, requestedPage: number,
  options: { staff?: boolean; snapshotAt?: number } = {}) {
  const view = memberView(report, options.staff ?? false);
  const index = Math.max(0, Math.min(requestedPage, view.pages.length - 1));
  const page = view.pages[index]!;
  const buttons = [
    new ButtonBuilder().setCustomId(memberNavigationId(ownerId, report.userId, Math.max(0, index - 1)))
      .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
    new ButtonBuilder().setCustomId(memberNavigationId(ownerId, report.userId, index + 1))
      .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(index === view.pages.length - 1),
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open profile').setURL(`https://discord.com/users/${report.userId}`),
  ];
  if (!options.staff) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel('Staff details')
    .setCustomId(memberDetailsId(ownerId, report.userId)));
  return card(brandedTitle(`Member · ${page.title}`, report.emoji ?? ''), userMention(report.userId), page.fields, {
    thumbnail: report.thumbnail,
    footer: `Page ${index + 1}/${view.pages.length}${options.staff ? ' · Private staff view' : ''}`
      + (options.snapshotAt ? ` · Snapshot <t:${Math.floor(options.snapshotAt / 1_000)}:R>` : ''),
    buttons,
  });
}

export interface MemberSnapshot {
  ownerId: string;
  guildId: string;
  channelId: string;
  report: MemberReport;
  staff: boolean;
  createdAt: number;
}

export class MemberReportCache {
  private readonly entries = new Map<string, MemberSnapshot>();
  constructor(private readonly now = Date.now, private readonly ttlMs = 120_000) {}

  put(messageId: string, entry: Omit<MemberSnapshot, 'createdAt'>): void {
    this.prune();
    this.entries.delete(messageId);
    if (this.entries.size >= 100) this.entries.delete(this.entries.keys().next().value!);
    // Never retain staff-only fields in a public message's snapshot.
    this.entries.set(messageId, { ...entry, report: structuredClone(memberView(entry.report, entry.staff)), createdAt: this.now() });
  }

  get(messageId: string): MemberSnapshot | undefined { this.prune(); return this.entries.get(messageId); }

  private prune(): void {
    for (const [id, entry] of this.entries) if (this.now() - entry.createdAt >= this.ttlMs) this.entries.delete(id);
  }
}

export type LookupPermit = { allowed: true; release: () => void } | { allowed: false; retryAfter: number };

// Shared REST budget: two requests in flight, five burst tokens, one refill per two seconds.
// Each report performs a target member fetch and a public user-profile fetch.
export class MemberLookupLimiter {
  private readonly members = new Map<string, number>();
  private tokens = 5;
  private active = 0;
  private refilledAt: number;

  constructor(private readonly now = Date.now) { this.refilledAt = now(); }

  acquire(userId: string, navigation = false): LookupPermit {
    const now = this.now();
    const key = `${navigation ? 'page' : 'query'}:${userId}`;
    const expiry = this.members.get(key) ?? 0;
    if (expiry > now) return { allowed: false, retryAfter: Math.ceil((expiry - now) / 1_000) };
    if (this.active >= 2) return { allowed: false, retryAfter: 2 };
    this.tokens = Math.min(5, this.tokens + Math.max(0, now - this.refilledAt) / 2_000);
    this.refilledAt = now;
    if (this.tokens < 1) return { allowed: false, retryAfter: Math.ceil((1 - this.tokens) * 2) };
    for (const [member, until] of this.members) if (until <= now) this.members.delete(member);
    if (this.members.size >= 5_000) this.members.delete(this.members.keys().next().value!);
    this.members.delete(key);
    this.members.set(key, now + (navigation ? 2_000 : 10_000));
    this.tokens--;
    this.active++;
    let released = false;
    return { allowed: true, release: () => { if (!released) { this.active--; released = true; } } };
  }
}
