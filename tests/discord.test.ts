import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Collection, MessageFlags,
  PermissionFlagsBits, PermissionsBitField, type Client, type TextChannel } from 'discord.js';
import { DiscordBulletinGateway, discordPanelRepository, preflight } from '../src/discord.js';
import { ensureVerificationPanel } from '../src/panel.js';
import { BULLETIN_JOIN_REASON, BULLETIN_LEAVE_REASON, VERIFY_CUSTOM_ID } from '../src/policy.js';
import { testConfig } from './helpers.js';

function preflightFixture() {
  const config = testConfig();
  // Role position per ID; anything unlisted sits below the bot.
  const hierarchy = new Map<string, number>();
  const me = { permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewAuditLog]),
    roles: { highest: { comparePositionTo: (role: { id: string }) => hierarchy.get(role.id) ?? 1 } } };
  const channels = new Map([config.verificationChannelId, config.commandsChannelId, config.logsChannelId].map(id => [id, {
    id, type: ChannelType.GuildText, permissions: new PermissionsBitField([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
    ]), permissionsFor() { return this.permissions; },
  }]));
  const roles = new Map<string, { id: string; managed: boolean; permissions: PermissionsBitField }>([[config.verificationRoleId,
    { id: config.verificationRoleId, managed: false, permissions: new PermissionsBitField(PermissionFlagsBits.ViewChannel) }]]);
  const guild = { id: config.guildId,
    members: { fetchMe: async () => me },
    roles: { fetch: async (id: string) => roles.get(id) },
    channels: { fetch: async (id: string) => channels.get(id) },
  };
  const client = { application: { id: config.applicationId }, guilds: { fetch: async () => guild } };
  return { config, me, channels, roles, hierarchy, client: client as unknown as Client<true> };
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

test('startup validates the optional Bulletin role: it exists, is safe to self-assign, and sits below the bot', async () => {
  const bulletinRoleId = '999999999999999999';
  const bulletinRole = { id: bulletinRoleId, managed: false, permissions: new PermissionsBitField(PermissionFlagsBits.ViewChannel) };
  const without = preflightFixture();
  assert.equal((await preflight(without.client, without.config)).bulletinGateway, undefined);

  const ok = preflightFixture();
  Object.assign(ok.config, { bulletinRoleId });
  ok.roles.set(bulletinRoleId, bulletinRole);
  assert.ok((await preflight(ok.client, ok.config)).bulletinGateway);

  const missing = preflightFixture();
  Object.assign(missing.config, { bulletinRoleId });
  await assert.rejects(preflight(missing.client, missing.config), /BULLETIN_ROLE_ID does not exist/);

  const staff = preflightFixture();
  Object.assign(staff.config, { bulletinRoleId });
  staff.roles.set(bulletinRoleId, { ...bulletinRole, permissions: new PermissionsBitField(PermissionFlagsBits.KickMembers) });
  await assert.rejects(preflight(staff.client, staff.config), /Bulletin role must not grant administrative or moderation/);

  const above = preflightFixture();
  Object.assign(above.config, { bulletinRoleId });
  above.roles.set(bulletinRoleId, bulletinRole);
  above.hierarchy.set(bulletinRoleId, 0);
  await assert.rejects(preflight(above.client, above.config), /above the Bulletin role/);
});

test('the Bulletin gateway reads both flags from one member fetch and changes a single role with an audit reason', async () => {
  const config = testConfig();
  const roleId = '999999999999999999';
  const calls: [string, unknown][] = [];
  const roles = new Set([config.verificationRoleId]);
  const guild = { id: config.guildId, members: {
    fetch: async (options: unknown) => { calls.push(['fetch', options]); return { roles: { cache: roles }, user: { bot: false } }; },
    addRole: async (options: unknown) => { calls.push(['add', options]); },
    removeRole: async (options: unknown) => { calls.push(['remove', options]); },
  } };
  const gateway = new DiscordBulletinGateway(guild as never, config, roleId);
  assert.deepEqual(await gateway.getMember('1'), { verified: true, subscribed: false, bot: false });
  roles.add(roleId);
  assert.deepEqual(await gateway.getMember('1'), { verified: true, subscribed: true, bot: false });
  await gateway.setRole('1', true);
  await gateway.setRole('1', false);
  assert.deepEqual(calls.filter(call => call[0] !== 'fetch'), [
    ['add', { user: '1', role: roleId, reason: BULLETIN_JOIN_REASON }],
    ['remove', { user: '1', role: roleId, reason: BULLETIN_LEAVE_REASON }],
  ]);
  assert.deepEqual(calls[0], ['fetch', { user: '1', force: true, cache: false }]);
});
