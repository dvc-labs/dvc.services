import { ChannelType, PermissionFlagsBits, RESTJSONErrorCodes, Routes,
  type Client, type Guild, type Message, type RESTGetAPIGuildMemberResult, type TextChannel } from 'discord.js';
import type { Config } from './config.js';
import { SetupError } from './errors.js';
import type { PanelMessage, PanelRepository } from './panel.js';
import type { BulletinGateway } from './bulletin.js';
import { assertSafeMemberRole, BULLETIN_JOIN_REASON, BULLETIN_LEAVE_REASON, BULLETIN_PANEL_BUTTON, hasEnabledButton, hasMatchingButton,
  MINECRAFTER_ROLE_REASON, serverAccessRole, VERIFICATION_AUDIT_REASON, VERIFY_CUSTOM_ID, type AccessRoles } from './policy.js';
import { verificationPanel } from './ui.js';
import type { MinecrafterGateway } from './cherry-creek.js';
import type { VerificationGateway } from './verification.js';

// Shared by every role the bot hands out: it exists, is safe to self-assign, and sits below the bot.
async function assertRoleAssignable(guild: Guild, roleId: string, envName: string, label: string) {
  const role = await guild.roles.fetch(roleId, { force: true });
  if (!role) throw new SetupError(`${envName} does not exist in GUILD_ID.`);
  assertSafeMemberRole(role, guild.id, label);
  const me = await guild.members.fetchMe({ force: true, cache: false });
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new SetupError('Give the bot Manage Roles permission.');
  }
  if (me.roles.highest.comparePositionTo(role) <= 0) {
    throw new SetupError(`Move the dvc.services bot role above the ${label} role.`);
  }
  return role;
}

export class DiscordVerificationGateway implements VerificationGateway {
  constructor(private readonly guild: Guild, private readonly config: Config) {}

  async getMember(userId: string) {
    // Fetch only the clicking member; never download the member list for verification.
    const member = await this.guild.members.fetch({ user: userId, force: true, cache: false });
    return { hasAccess: serverAccessRole(member.roles.cache, this.config) !== undefined,
      pending: member.pending ?? false, bot: member.user.bot };
  }

  async assertRoleAssignable(): Promise<void> {
    await assertRoleAssignable(this.guild, this.config.verificationRoleId, 'VERIFICATION_ROLE_ID', 'verification');
  }

  async addRole(userId: string): Promise<void> {
    // A single-role PUT preserves every other role the member already has.
    await this.guild.members.addRole({
      user: userId, role: this.config.verificationRoleId,
      reason: VERIFICATION_AUDIT_REASON,
    });
  }
}

export class DiscordBulletinGateway implements BulletinGateway {
  constructor(private readonly guild: Guild, private readonly config: AccessRoles,
    private readonly roleId: string) {}

  async getMember(userId: string) {
    // Fetch only the clicking member; the flags come from the same single request.
    const member = await this.guild.members.fetch({ user: userId, force: true, cache: false });
    return { verified: serverAccessRole(member.roles.cache, this.config) !== undefined,
      subscribed: member.roles.cache.has(this.roleId), bot: member.user.bot };
  }

  async assertRoleAssignable(): Promise<void> {
    await assertRoleAssignable(this.guild, this.roleId, 'BULLETIN_ROLE_ID', 'Bulletin');
  }

  async setRole(userId: string, subscribed: boolean): Promise<void> {
    // Single-role PUT/DELETE calls leave every other role the member has untouched.
    const options = { user: userId, role: this.roleId,
      reason: subscribed ? BULLETIN_JOIN_REASON : BULLETIN_LEAVE_REASON };
    if (subscribed) await this.guild.members.addRole(options);
    else await this.guild.members.removeRole(options);
  }
}

export class DiscordMinecrafterGateway implements MinecrafterGateway {
  constructor(private readonly guild: Guild, private readonly config: AccessRoles, readonly roleId: string,
    private readonly moderationChannel: TextChannel) {}

  async assertRoleAssignable(): Promise<void> {
    const role = await assertRoleAssignable(this.guild, this.roleId, 'MINECRAFTER_ROLE_ID', 'Minecrafter');
    if (this.moderationChannel.permissionsFor(role).has(PermissionFlagsBits.ViewChannel)) {
      throw new SetupError('Keep MOD_CHANNEL_ID private: remove View Channel from the Minecrafter role.');
    }
  }

  private async readMember(userId: string): Promise<RESTGetAPIGuildMemberResult | null> {
    // Read the role IDs from Discord, including roles that aren't in discord.js's cache.
    try {
      return await this.guild.client.rest.get(Routes.guildMember(this.guild.id, userId)) as RESTGetAPIGuildMemberResult;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === RESTJSONErrorCodes.UnknownMember) return null;
      throw error;
    }
  }

  async prepareAward(userId: string): Promise<() => Promise<void>> {
    await this.assertRoleAssignable();
    const member = await this.readMember(userId);
    if (!member || member.user.bot || member.pending || !serverAccessRole(new Set(member.roles), this.config)) {
      throw new SetupError('The applicant must still have access to dvc.labs before receiving the Minecrafter role.');
    }
    return async () => {
      if (member.roles.includes(this.roleId)) return;
      await this.guild.members.addRole({ user: userId, role: this.roleId, reason: MINECRAFTER_ROLE_REASON });
    };
  }

  async hasRole(userId: string, roleId: string): Promise<boolean> {
    return (await this.readMember(userId))?.roles.includes(roleId) ?? false;
  }
}

function panelMessage(message: Message): PanelMessage {
  const components = message.components.map(component => component.toJSON());
  return {
    id: message.id,
    authorId: message.author.id,
    kind: hasEnabledButton(components, VERIFY_CUSTOM_ID) ? 'verification'
      : hasMatchingButton(components, id => id === BULLETIN_PANEL_BUTTON) ? 'bulletin' : undefined,
  };
}

export function discordPanelRepository(channel: TextChannel, config: Pick<Config, 'emoji' | 'bulletinRoleId'>): PanelRepository {
  const payload = () => verificationPanel(config.emoji, !!config.bulletinRoleId);
  return {
    async get(id) {
      try { return panelMessage(await channel.messages.fetch({ message: id, cache: false, force: true })); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 10008) return null;
        throw error;
      }
    },
    async list(before) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}), cache: false });
      return [...messages.values()].map(panelMessage);
    },
    async update(id) {
      // Discord requires clearing legacy fields when converting an existing panel to V2.
      await channel.messages.edit(id, { ...payload(), content: null, embeds: [] });
    },
    async create() { return (await channel.send(payload())).id; },
    async retireBulletin(id) {
      try { await channel.messages.delete(id); }
      catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 10008) throw error;
      }
    },
  };
}

export async function preflight(client: Client<true>, config: Config) {
  if (client.application.id !== config.applicationId) {
    throw new SetupError('APPLICATION_ID does not match DISCORD_TOKEN.');
  }
  const guild = await client.guilds.fetch(config.guildId);
  const gateway = new DiscordVerificationGateway(guild, config);
  await gateway.assertRoleAssignable();
  if (config.adminRoleId && !await guild.roles.fetch(config.adminRoleId, { force: true })) {
    throw new SetupError('ADMIN_ROLE_ID does not exist in GUILD_ID.');
  }
  let bulletinGateway: DiscordBulletinGateway | undefined;
  if (config.bulletinRoleId) {
    bulletinGateway = new DiscordBulletinGateway(guild, config, config.bulletinRoleId);
    await bulletinGateway.assertRoleAssignable();
  }
  const me = await guild.members.fetchMe();
  if (!me.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    throw new SetupError('Give the bot View Audit Log permission for v0.2.0 server activity logging.');
  }

  async function channel(id: string, label: string): Promise<TextChannel> {
    const result = await guild.channels.fetch(id);
    if (result?.type !== ChannelType.GuildText) {
      throw new SetupError(`${label} must be a standard text channel in GUILD_ID.`);
    }
    const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
    if (!result.permissionsFor(me).has(permissions)) {
      throw new SetupError(`The bot needs View Channel, Send Messages, Embed Links, and Read Message History in ${label}.`);
    }
    return result;
  }

  const verificationChannel = await channel(config.verificationChannelId, 'VERIFICATION_CHANNEL_ID');
  await channel(config.commandsChannelId, 'COMMANDS_CHANNEL_ID');
  const logsChannel = await channel(config.logsChannelId, 'LOGS_CHANNEL_ID');
  let cherryChannels: { mod: TextChannel; minecraft: TextChannel } | undefined;
  if (config.modChannelId && config.minecraftChannelId) {
    const mod = await channel(config.modChannelId, 'MOD_CHANNEL_ID');
    const minecraft = await channel(config.minecraftChannelId, 'MINECRAFT_CHANNEL_ID');
    const memberRoles = [config.verificationRoleId, config.bulletinRoleId]
      .flatMap(id => id ? guild.roles.cache.get(id) ?? [] : []);
    if ([guild.roles.everyone, ...memberRoles].some(role => mod.permissionsFor(role).has(PermissionFlagsBits.ViewChannel))) {
      throw new SetupError('Keep MOD_CHANNEL_ID private: do not grant View Channel to @everyone, the verification role, or the Bulletin role.');
    }
    cherryChannels = { mod, minecraft };
  }
  return { guild, gateway, bulletinGateway, verificationChannel, logsChannel, cherryChannels };
}
