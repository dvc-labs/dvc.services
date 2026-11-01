import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Collection, MessageFlags,
  PermissionFlagsBits, PermissionsBitField, type Client, type TextChannel } from 'discord.js';
import { discordPanelRepository, preflight } from '../src/discord.js';
import { ensureVerificationPanel } from '../src/panel.js';
import { VERIFY_CUSTOM_ID } from '../src/policy.js';
import { testConfig } from './helpers.js';

function preflightFixture() {
  const config = testConfig();
  const me = { permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewAuditLog]),
    roles: { highest: { comparePositionTo: () => 1 } } };
  const channels = new Map([config.verificationChannelId, config.commandsChannelId, config.logsChannelId].map(id => [id, {
    id, type: ChannelType.GuildText, permissions: new PermissionsBitField([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
    ]), permissionsFor() { return this.permissions; },
  }]));
  const guild = { id: config.guildId,
    members: { fetchMe: async () => me },
    roles: { fetch: async () => ({ id: config.verificationRoleId, managed: false,
      permissions: new PermissionsBitField(PermissionFlagsBits.ViewChannel) }) },
    channels: { fetch: async (id: string) => channels.get(id) },
  };
  const client = { application: { id: config.applicationId }, guilds: { fetch: async () => guild } };
  return { config, me, channels, client: client as unknown as Client<true> };
}

test('startup accepts the documented permissions and requires View Audit Log without Administrator', async () => {
  const f = preflightFixture();
  const resources = await preflight(f.client, f.config);
  assert.equal(resources.guild.id, f.config.guildId);
  assert.equal(f.me.permissions.has(PermissionFlagsBits.Administrator), false);
  f.me.permissions.remove(PermissionFlagsBits.ViewAuditLog);
  await assert.rejects(preflight(f.client, f.config), /View Audit Log/);
});

test('startup checks Read Message History in verification, command, and log channels', async () => {
  for (const key of ['verificationChannelId', 'commandsChannelId', 'logsChannelId'] as const) {
    const f = preflightFixture();
    f.channels.get(f.config[key])!.permissions.remove(PermissionFlagsBits.ReadMessageHistory);
    await assert.rejects(preflight(f.client, f.config), /Read Message History/);
  }
});

test('the existing legacy panel upgrades in place and the real adapter finds its nested V2 button on restart', async () => {
  const config = testConfig();
  const message = { id: '777777777777777777', author: { id: config.applicationId },
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
      .setCustomId(VERIFY_CUSTOM_ID).setStyle(ButtonStyle.Primary).setLabel('Verify'))] as { toJSON(): unknown }[] };
  const edits: { id: string; content: null; embeds: unknown[]; flags: number; components: { toJSON(): unknown }[] }[] = [];
  let creates = 0;
  const channel = {
    messages: {
      fetch: async (options: { message?: string }) => options.message ? message : new Collection([[message.id, message]]),
      edit: async (id: string, payload: typeof edits[number]) => { edits.push({ ...payload, id }); message.components = payload.components; },
    },
    send: async () => { creates++; return { id: 'another-panel' }; },
  };
  const repository = discordPanelRepository(channel as unknown as TextChannel, config);
  assert.deepEqual(await ensureVerificationPanel(repository, config.applicationId, message.id), { id: message.id, created: false });
  assert.equal(edits[0]!.content, null);
  assert.deepEqual(edits[0]!.embeds, []);
  assert.equal(edits[0]!.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(await ensureVerificationPanel(repository, config.applicationId), { id: message.id, created: false });
  assert.equal(creates, 0);
  assert.equal(edits.length, 2);
});
