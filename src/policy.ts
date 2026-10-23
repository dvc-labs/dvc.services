import { SetupError } from './errors.js';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';

export const VERIFY_CUSTOM_ID = 'dvc:verify:v1';

export interface ButtonContext {
  guildId: string | null;
  channelId: string | null;
  authorId: string;
  messageId: string;
  customId: string;
}

export function isTrustedVerificationButton(
  context: ButtonContext,
  expected: { guildId: string; channelId: string; botId: string; messageId: string | undefined },
): boolean {
  return context.guildId === expected.guildId
    && context.channelId === expected.channelId
    && context.authorId === expected.botId
    && context.messageId === expected.messageId
    && context.customId === VERIFY_CUSTOM_ID;
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
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers,
];

export function assertSafeVerificationRole(role: {
  id: string;
  managed: boolean;
  permissions: PermissionsBitField;
}, guildId: string): void {
  if (role.id === guildId || role.managed) {
    throw new SetupError('The verification role must be a normal member role, not @everyone or an integration role.');
  }
  if (elevatedPermissions.some(permission => role.permissions.has(permission))) {
    throw new SetupError('The verification role must not grant administrative or moderation permissions.');
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
