import { ApplicationCommandType, PermissionFlagsBits, SlashCommandBuilder, type Guild } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('about').setDescription('About dvc.services and dvc.labs.'),
  new SlashCommandBuilder().setName('verification')
    .setDescription('Create or refresh the server verification panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

interface CommandShape {
  name: string;
  description: string;
  type?: number | undefined;
  default_member_permissions?: string | null | undefined;
  options?: unknown[] | undefined;
}

export function commandSignature(definitions: CommandShape[]): string {
  return JSON.stringify(definitions.map(command => ({
    name: command.name,
    description: command.description,
    type: command.type ?? ApplicationCommandType.ChatInput,
    default_member_permissions: command.default_member_permissions ?? null,
    options: command.options ?? [],
  })).sort((a, b) => a.name.localeCompare(b.name)));
}

export async function syncCommands(guild: Guild): Promise<boolean> {
  const existing = await guild.commands.fetch();
  const desired = commands.map(command => command.toJSON());
  const current = existing.map(command => ({
    name: command.name,
    description: command.description,
    type: command.type,
    default_member_permissions: command.defaultMemberPermissions?.bitfield.toString() ?? null,
    options: command.options,
  }));
  if (commandSignature(current) === commandSignature(desired)) return false;
  await guild.commands.set(desired);
  return true;
}
