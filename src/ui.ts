import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown,
  MessageFlags, SectionBuilder, SeparatorBuilder, TextDisplayBuilder, ThumbnailBuilder,
  channelMention, roleMention, userMention,
} from 'discord.js';
import type { BulletinResult } from './bulletin.js';
import type { Config } from './config.js';
import { BULLETIN_JOIN_ID, BULLETIN_LEAVE_ID, VERIFY_CUSTOM_ID } from './policy.js';
import { BRAND_COLOR, DVC_EMOJI, GITHUB_URL, REPOSITORY_URL, VERSION, WEBSITE_URL } from './version.js';

export interface CardField { name: string; value: string }
interface CardOptions {
  thumbnail?: string;
  buttons?: ButtonBuilder[];
  footer?: string;
}

export const NO_MENTIONS = { parse: [] as never[], repliedUser: false };

export function displayText(value: string, limit = 300): string {
  // Disable both formatting and linkification of member-controlled text. Authored links
  // and native mentions are constructed separately and never pass through this helper.
  // Truncate the source by code point before adding escapes; never split a surrogate
  // pair or an escape sequence. Rendered text can be longer than this source limit.
  const source = Array.from(value.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ''))
    .slice(0, Math.max(0, limit)).join('');
  const plain = source.replace(/<(?=[@#])/g, '‹').replace(/@/g, '@\u200b')
    .replace(/:\//g, ':\u200b/').replace(/\bwww\./gi, 'www\u200b.')
    .replace(/\bdiscord\.(gg|com\/invite)/gi, 'discord\u200b.$1');
  const escaped = escapeMarkdown(plain, { maskedLink: true, heading: true, bulletedList: true, numberedList: true })
    .replace(/^([ \t]*)-#(?=[ \t])/gm, '$1\\-#')
    .replace(/>/g, '\\>');
  return escaped || 'None';
}

export function brandedTitle(title: string, emoji: string): string {
  return emoji ? `${emoji} ${title}` : title;
}

export function humanise(value: string): string {
  const words = value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function discordTime(timestamp: number | null | undefined): string {
  if (!timestamp) return 'Not available';
  const seconds = Math.floor(timestamp / 1_000);
  return '<t:' + seconds + ':f> (<t:' + seconds + ':R>)';
}

// V2 messages use a single teal container, with no legacy content or embeds.
// Leave room below Discord's 4,000-character combined text limit.
export function card(title: string, description = '', fields: readonly CardField[] = [], options: CardOptions = {}) {
  const heading = ('## ' + title + '\n' + description).trim().slice(0, 1_000);
  const container = new ContainerBuilder().setAccentColor(BRAND_COLOR);
  const header = new TextDisplayBuilder().setContent(heading);
  if (options.thumbnail) {
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(header)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(options.thumbnail).setDescription('Discord profile picture')));
  } else container.addTextDisplayComponents(header);
  if (fields.length) {
    const parts: string[] = [];
    let length = 0;
    for (const field of fields) {
      const block = '**' + field.name + '**\n' + field.value;
      if (length + block.length > 2_500) {
        parts.push('… Further details are available in the console log.');
        break;
      }
      parts.push(block); length += block.length + 2;
    }
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(parts.join('\n\n')));
  }
  if (options.buttons?.length) {
    container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(options.buttons));
  }
  container.addTextDisplayComponents(new TextDisplayBuilder()
    .setContent(('-# dvc.services • v' + VERSION + (options.footer ? ' • ' + options.footer : '')).slice(0, 250)));
  return { flags: MessageFlags.IsComponentsV2 as const, components: [container], allowedMentions: NO_MENTIONS };
}

function githubButton(): ButtonBuilder {
  return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Follow dvc.labs on GitHub').setURL(GITHUB_URL);
}

export function verificationPanel(emoji = DVC_EMOJI) {
  const verify = new ButtonBuilder().setCustomId(VERIFY_CUSTOM_ID).setLabel('Verify').setStyle(ButtonStyle.Primary);
  const match = /^<(a?):([a-zA-Z0-9_]+):(\d+)>$/.exec(emoji);
  if (match) verify.setEmoji({ id: match[3]!, name: match[2]!, animated: match[1] === 'a' });
  return card(brandedTitle('Welcome to dvc.labs', emoji),
    'A place for projects, experiments, and a look behind the scenes at dvc.\n\n'
    + 'Take a moment to read the server rules, then press **Verify** to unlock the community.', [], {
      buttons: [verify, githubButton()],
    });
}

export function bulletinButton(subscribe: boolean): ButtonBuilder {
  return new ButtonBuilder().setCustomId(subscribe ? BULLETIN_JOIN_ID : BULLETIN_LEAVE_ID)
    .setLabel(subscribe ? 'Get Bulletin pings' : 'Stop Bulletin pings').setStyle(ButtonStyle.Secondary);
}

// Shown on the private verification reply, directly under the "you're verified" message.
export function bulletinOffer(roleId: string): CardField {
  return { name: 'Want news pings?',
    value: 'Press **Get Bulletin pings** to be mentioned with ' + roleMention(roleId)
      + ' for dvc.labs news and updates. It’s optional, and you can switch it off again any time.' };
}

// The same private message is edited in place after each press, so the button always shows the next action.
export function bulletinCard(result: BulletinResult, requested: boolean, roleId: string,
  config: Pick<Config, 'emoji' | 'verificationChannelId'>) {
  const role = roleMention(roleId);
  const reply = (title: string, description: string, subscribe: boolean | null) =>
    card(brandedTitle(title, config.emoji), description, [],
      subscribe === null ? {} : { buttons: [bulletinButton(subscribe)] });
  switch (result) {
    case 'subscribed':
      return reply('Bulletin pings on', `You’ll now get ${role} pings for dvc.labs news and updates. You can switch them off any time.`, false);
    case 'already_subscribed':
      return reply('Bulletin pings are on', `You already have ${role}. Press the button if you’d like to switch it off.`, false);
    case 'unsubscribed':
      return reply('Bulletin pings off', `You won’t get ${role} pings any more. You can switch them back on whenever you like.`, true);
    case 'already_unsubscribed':
      return reply('Bulletin pings are off', `You don’t have ${role}. Press the button if you’d like news pings.`, true);
    case 'not_verified':
      return reply('Verify first', `Press **Verify** in ${channelMention(config.verificationChannelId)} first, then come back for Bulletin pings.`, null);
    case 'bot':
      return reply('Members only', 'Bulletin pings are for human members.', null);
    case 'processing':
    case 'cooldown':
      return reply('Just a moment', 'Please wait a few seconds before changing Bulletin pings again.', requested);
  }
}

export function aboutCard(config: Config, uptimeSeconds: number) {
  const hours = Math.floor(uptimeSeconds / 3_600);
  const minutes = Math.floor((uptimeSeconds % 3_600) / 60);
  return card(brandedTitle('dvc.services', config.emoji),
    'The service bot for **dvc.labs** — the home for dvc. projects, experiments, and server updates.\n\n'
    + 'Member verification, a friendly welcome, member lookups, and useful server activity logs.', [
      { name: 'Version', value: 'v' + VERSION },
      { name: 'Online for', value: hours + 'h ' + minutes + 'm' },
      { name: 'Hosted by', value: '[loon.host](https://loon.host)' },
      { name: 'Commands', value: 'Use /about and /member in ' + channelMention(config.commandsChannelId) + '. Staff can also use /verification.' },
      { name: 'Links', value: '[dvc.](' + WEBSITE_URL + ') · [Source code](' + REPOSITORY_URL + ')' },
    ], { buttons: [githubButton()] });
}

export function welcomeMessage(config: Config, userId: string) {
  return card(brandedTitle('Welcome to dvc.labs!', config.emoji),
    'Hey ' + userMention(userId) + ", glad you're here! Make yourself at home among the projects, experiments, and people behind dvc.\n\n"
    + 'Start in ' + channelMention(config.verificationChannelId) + ': read the server rules, then press **Verify** to join the community.\n\n'
    + 'Curious about what we’re building? Follow **dvc.labs on GitHub** for our projects and updates.\n\n'
    + 'A quick heads-up: the team logs membership, verification, voice-channel changes, and administrative activity. '
    + 'Member profiles can be looked up publicly; live presence and moderation details are restricted to private staff views. '
    + 'Ordinary chat and incoming DMs are not archived. See you in the server!', [], {
      buttons: [new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open dvc.labs')
        .setURL('https://discord.com/channels/' + config.guildId + '/' + config.verificationChannelId), githubButton()],
    });
}
