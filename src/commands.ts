import { PermissionFlagsBits, SlashCommandBuilder, type ApplicationCommandData, type Guild } from 'discord.js';
import { MAX_HALL_PROMPT } from './hall.js';

export const commands = [
  new SlashCommandBuilder().setName('about').setDescription('About dvc.services and dvc.labs.'),
  new SlashCommandBuilder().setName('verification')
    .setDescription('Refresh the verification panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('member')
    .setDescription('Inspect a server member’s profile, roles, permissions, and current status.')
    .addUserOption(option => option.setName('user').setDescription('The server member to look up.').setRequired(true)),
  new SlashCommandBuilder().setName('ask').setDescription('Ask hallAI a question. Use Forget on the reply to clear context.')
    .addStringOption(option => option.setName('prompt').setDescription('Your question (sent to Hall and OpenAI; avoid sensitive information).')
      .setRequired(true).setMinLength(1).setMaxLength(MAX_HALL_PROMPT))
    .addBooleanOption(option => option.setName('private').setDescription('Only show the question and answer to you (default: public).'))
    .addBooleanOption(option => option.setName('reset').setDescription('Clear this conversation’s context before asking.')),
  new SlashCommandBuilder().setName('cherrycreek').setDescription('Request access to the Cherry Creek Java server.'),
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
