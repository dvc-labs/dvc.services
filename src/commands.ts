import { PermissionFlagsBits, SlashCommandBuilder, type ApplicationCommandData, type Guild } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('about').setDescription('About dvc.services and dvc.labs.'),
  new SlashCommandBuilder().setName('verification')
    .setDescription('Create or refresh the server verification panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

export async function syncCommands(guild: Guild): Promise<boolean> {
  const existing = await guild.commands.fetch();
  const desired = commands.map(command => command.toJSON());
  // discord.js compares received camelCase options with API snake_case definitions,
  // including nested options, defaults, and localisations. Keep option order meaningful.
  // Builder JSON is supported at runtime; its types also allow explicit undefined fields.
  if (existing.size === desired.length
    && desired.every(definition => existing.some(command => command.equals({
      ...definition, nsfw: definition.nsfw ?? false,
    } as ApplicationCommandData, true)))) return false;
  await guild.commands.set(desired);
  return true;
}
