import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} from 'discord.js';
import type { Config } from './config.js';
import { VERIFY_CUSTOM_ID } from './policy.js';
import { BRAND_COLOR, REPOSITORY_URL, VERSION, WEBSITE_URL } from './version.js';

export function embed(title: string, description?: string): EmbedBuilder {
  const result = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(title)
    .setFooter({ text: `dvc.services • v${VERSION}` });
  if (description) result.setDescription(description);
  return result;
}

export function verificationPanel() {
  return {
    embeds: [embed('Welcome to dvc.labs',
      'A place for projects, experiments, and a look behind the scenes at dvc.\n\n'
      + 'Take a moment to read the server rules, then press **Verify** to unlock the community. '
      + 'No external login or extra information is needed.')],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(VERIFY_CUSTOM_ID).setLabel('Verify').setStyle(ButtonStyle.Primary),
    )],
    allowedMentions: { parse: [] as never[] },
  };
}

export function aboutEmbed(config: Config, uptimeSeconds: number): EmbedBuilder {
  const hours = Math.floor(uptimeSeconds / 3_600);
  const minutes = Math.floor((uptimeSeconds % 3_600) / 60);
  return embed('dvc.services',
    'The service bot for **dvc.labs** — the home for dvc. projects, experiments, and server updates.\n\n'
    + 'This first release handles member verification and keeps the team informed through activity logs. '
    + 'More server tools, including OptiPlex monitoring integrations, are planned.')
    .addFields(
      { name: 'Version', value: `v${VERSION}`, inline: true },
      { name: 'Online for', value: `${hours}h ${minutes}m`, inline: true },
      { name: 'Hosted by', value: '[loon.host](https://loon.host/)', inline: true },
      { name: 'Commands', value: `Use commands in <#${config.commandsChannelId}>.` },
      { name: 'Links', value: `[dvc.](${WEBSITE_URL}) · [Source code](${REPOSITORY_URL})` },
    );
}
