import { ChannelType, PermissionFlagsBits, type Client, type Guild,
  type Message, type TextChannel } from 'discord.js';
import type { Config } from './config.js';
import { SetupError } from './errors.js';
import type { PanelMessage, PanelRepository } from './panel.js';
import { assertSafeVerificationRole, hasVerificationButton } from './policy.js';
import { verificationPanel } from './ui.js';
import type { VerificationGateway } from './verification.js';

export class DiscordVerificationGateway implements VerificationGateway {
  constructor(private readonly guild: Guild, private readonly config: Config) {}

  async getMember(userId: string) {
    // Fetch only the clicking member; never download the member list for verification.
    const member = await this.guild.members.fetch({ user: userId, force: true, cache: false });
    return { hasRole: member.roles.cache.has(this.config.verificationRoleId),
      pending: member.pending ?? false, bot: member.user.bot };
  }

  async assertRoleAssignable(): Promise<void> {
    const role = await this.guild.roles.fetch(this.config.verificationRoleId, { force: true });
    if (!role) throw new SetupError('VERIFICATION_ROLE_ID does not exist in GUILD_ID.');
    assertSafeVerificationRole(role, this.guild.id);
    const me = await this.guild.members.fetchMe({ force: true, cache: false });
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new SetupError('Give the bot Manage Roles permission.');
    }
    if (me.roles.highest.comparePositionTo(role) <= 0) {
      throw new SetupError('Move the dvc.services bot role above the verification role.');
    }
  }

  async addRole(userId: string): Promise<void> {
    // A single-role PUT preserves every other role the member already has.
    await this.guild.members.addRole({
      user: userId, role: this.config.verificationRoleId,
      reason: 'dvc.services: member completed button verification',
    });
  }
}

function panelMessage(message: Message): PanelMessage {
  return {
    id: message.id,
    authorId: message.author.id,
    isVerificationPanel: hasVerificationButton(message.components.map(component => component.toJSON())),
  };
}

export function discordPanelRepository(channel: TextChannel): PanelRepository {
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
      await channel.messages.edit(id, { ...verificationPanel(), content: null, embeds: [] });
    },
    async create() { return (await channel.send(verificationPanel())).id; },
  };
}

export async function preflight(client: Client<true>, config: Config) {
  if (client.application.id !== config.applicationId) {
    throw new SetupError('APPLICATION_ID does not match DISCORD_TOKEN.');
  }
  const guild = await client.guilds.fetch(config.guildId);
  const gateway = new DiscordVerificationGateway(guild, config);
  await gateway.assertRoleAssignable();
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
  return { guild, gateway, verificationChannel, logsChannel };
}
