import { SetupError } from './errors.js';
import { ComponentType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import type { Config } from './config.js';

export const VERIFY_CUSTOM_ID = 'dvc:verify:v1';
export const MEMBER_CUSTOM_ID_PREFIX = 'dvc:member:v1:';
export const VERIFICATION_AUDIT_REASON = 'dvc.services: member completed button verification';
export const BULLETIN_CUSTOM_ID_PREFIX = 'dvc:bulletin:';
export const BULLETIN_JOIN_REASON = 'dvc.services: member opted in to Bulletin pings';
export const BULLETIN_LEAVE_REASON = 'dvc.services: member opted out of Bulletin pings';
// Role changes the bot already reports itself; their native audit entries stay in the console.
export const OWN_ROLE_AUDIT_REASONS: ReadonlySet<string> = new Set([
  VERIFICATION_AUDIT_REASON, BULLETIN_JOIN_REASON, BULLETIN_LEAVE_REASON,
]);

export type AccessRoles = Pick<Config, 'verificationRoleId' | 'adminRoleId'>;

// The admin role is recognised as existing access, never as a role to assign.
export function serverAccessRole(roles: { has(id: string): boolean }, config: AccessRoles): string | undefined {
  if (roles.has(config.verificationRoleId)) return config.verificationRoleId;
  if (config.adminRoleId && roles.has(config.adminRoleId)) return config.adminRoleId;
  return undefined;
}

export function bulletinActionId(userId: string, subscribe: boolean): string {
  return `${BULLETIN_CUSTOM_ID_PREFIX}v2:${userId}:${subscribe ? 'join' : 'leave'}`;
}

export function parseBulletinAction(customId: string): { userId: string; subscribe: boolean } | null {
  const match = /^dvc:bulletin:v2:(\d{17,20}):(join|leave)$/.exec(customId);
  return match ? { userId: match[1]!, subscribe: match[2] === 'join' } : null;
}

// Supports both the old action row and the nested action row in a V2 container.
export function hasVerificationButton(components: readonly unknown[]): boolean {
  return components.some(component => {
    if (!component || typeof component !== 'object') return false;
    if ('type' in component && component.type === ComponentType.Button
      && 'custom_id' in component && component.custom_id === VERIFY_CUSTOM_ID) return true;
    return 'components' in component && Array.isArray(component.components)
      && hasVerificationButton(component.components);
  });
}

interface VerificationContext {
  guildId: string | null;
  channelId: string | null;
  authorId: string;
  messageId: string;
  customId: string;
}

interface ExpectedPanel {
  guildId: string;
  channelId: string;
  botId: string;
  messageId: string | undefined;
}

function isTrustedVerificationPanel(
  context: VerificationContext,
  expected: ExpectedPanel,
): boolean {
  return context.guildId === expected.guildId
    && context.channelId === expected.channelId
    && context.authorId === expected.botId
    && context.messageId === expected.messageId;
}

export function isTrustedVerificationButton(context: VerificationContext, expected: ExpectedPanel): boolean {
  return isTrustedVerificationPanel(context, expected) && context.customId === VERIFY_CUSTOM_ID;
}

const elevatedPermissions = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.PinMessages,
  PermissionFlagsBits.BypassSlowmode,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers,
];

// Roles the bot hands out on a click (verification, Bulletin) must never carry staff powers.
export function assertSafeMemberRole(role: {
  id: string;
  managed: boolean;
  permissions: PermissionsBitField;
}, guildId: string, label = 'verification'): void {
  if (role.id === guildId || role.managed) {
    throw new SetupError(`The ${label} role must be a normal member role, not @everyone or an integration role.`);
  }
  if (elevatedPermissions.some(permission => role.permissions.has(permission))) {
    throw new SetupError(`The ${label} role must not grant administrative or moderation permissions.`);
  }
}

// Bounded and lazy-expiring: no per-user timers or unbounded member cache.
export class Cooldown {
  private readonly entries = new Map<string, number>();

  constructor(private readonly durationMs = 5_000, private readonly now = Date.now) {}

  take(key: string): boolean {
    const now = this.now();
    for (const [id, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(id);
      else break;
    }
    if ((this.entries.get(key) ?? 0) > now) return false;
    if (this.entries.size >= 5_000) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, now + this.durationMs);
    return true;
  }
}
