import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Collection, MessageFlags,
  PermissionFlagsBits, PermissionsBitField, type Client, type TextChannel } from 'discord.js';
import { DiscordBulletinGateway, DiscordVerificationGateway, discordPanelRepository, preflight } from '../src/discord.js';
import { ensureVerificationPanels } from '../src/panel.js';
import { BULLETIN_JOIN_REASON, BULLETIN_LEAVE_REASON, VERIFY_CUSTOM_ID } from '../src/policy.js';
import { testConfig } from './helpers.js';
import { VerificationService } from '../src/verification.js';

function preflightFixture() {
  const config = testConfig();
  // Role position per ID; anything unlisted sits below the bot.
  const hierarchy = new Map<string, number>();
  const me = { permissions: new PermissionsBitField([PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewAuditLog]),
    roles: { highest: { comparePositionTo: (role: { id: string }) => hierarchy.get(role.id) ?? 1 } } };
  const publicRole = { id: config.guildId, permissions: new PermissionsBitField() };
  const memberView = new Map<string, Set<string>>();
  const channels = new Map([config.verificationChannelId, config.commandsChannelId, config.logsChannelId,
    '1562226019631366144', '1569106176799408261'].map(id => [id, {
    id, type: ChannelType.GuildText, permissions: new PermissionsBitField([
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory,
    ]), permissionsFor(subject: unknown) {
      if (subject === me) return this.permissions;
      const role = subject as { id: string };
      return new PermissionsBitField(memberView.get(id)?.has(role.id) ? PermissionFlagsBits.ViewChannel : 0n);
    },
  }]));
  const roles = new Map<string, { id: string; managed: boolean; permissions: PermissionsBitField }>([[config.verificationRoleId,
    { id: config.verificationRoleId, managed: false, permissions: new PermissionsBitField(PermissionFlagsBits.ViewChannel) }]]);
  const guild = { id: config.guildId,
    members: { fetchMe: async () => me },
    roles: { fetch: async (id: string) => roles.get(id), cache: roles, everyone: publicRole },
    channels: { fetch: async (id: string) => channels.get(id) },
  };
  const client = { application: { id: config.applicationId }, guilds: { fetch: async () => guild } };
  return { config, me, channels, roles, hierarchy, memberView, client: client as unknown as Client<true> };
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

test('Cherry Creek startup requires bot access to both channels and denies public staff requests', async () => {
  const f = preflightFixture();
  const modChannelId = '1562226019631366144';
  const minecraftChannelId = '1569106176799408261';
  Object.assign(f.config, { modChannelId, minecraftChannelId });
  assert.equal((await preflight(f.client, f.config)).cherryChannels?.mod.id, modChannelId);
  for (const role of [f.config.guildId, f.config.verificationRoleId]) {
    f.memberView.set(modChannelId, new Set([role]));
    await assert.rejects(preflight(f.client, f.config), /Keep MOD_CHANNEL_ID private/);
  }
  f.memberView.clear();
  f.channels.get(minecraftChannelId)!.permissions.remove(PermissionFlagsBits.SendMessages);
  await assert.rejects(preflight(f.client, f.config), /Send Messages.*MINECRAFT_CHANNEL_ID/);
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
  assert.deepEqual(await ensureVerificationPanels(repository, config.applicationId, false, message.id),
    { verification: { id: message.id, created: false } });
  assert.equal(edits[0]!.content, null);
  assert.deepEqual(edits[0]!.embeds, []);
  assert.equal(edits[0]!.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(await ensureVerificationPanels(repository, config.applicationId, false),
    { verification: { id: message.id, created: false } });
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

test('the configured admin role must exist but may carry staff permissions and sit above the bot', async () => {
  const f = preflightFixture();
  const id = '888888888888888888';
  Object.assign(f.config, { adminRoleId: id });
  await assert.rejects(preflight(f.client, f.config), /ADMIN_ROLE_ID does not exist/);
  f.roles.set(id, { id, managed: false, permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) });
  f.hierarchy.set(id, -1);
  await preflight(f.client, f.config);
});

test('a fresh verification or admin role means access; only losing both allows a new verification award', async () => {
  const config = { ...testConfig(), adminRoleId: '888888888888888888' };
  const roles = new Set([config.adminRoleId]);
  const writes: unknown[] = [];
  const guild = { id: config.guildId, members: {
    fetch: async (options: unknown) => {
      assert.equal((options as { force: boolean }).force, true);
      return { roles: { cache: roles }, user: { bot: false } };
    },
    addRole: async (options: unknown) => { writes.push(options); },
  } };
  const gateway = new DiscordVerificationGateway(guild as never, config);
  gateway.assertRoleAssignable = async () => {};
  const bulletin = new DiscordBulletinGateway(guild as never, config, '999999999999999999');
  assert.equal((await bulletin.getMember('staff')).verified, true);
  assert.equal(await new VerificationService(gateway).verify('staff'), 'already_verified');
  assert.equal(writes.length, 0);
  roles.delete(config.adminRoleId);
  roles.add(config.verificationRoleId);
  assert.equal(await new VerificationService(gateway).verify('staff'), 'already_verified');
  roles.clear();
  assert.equal(await new VerificationService(gateway).verify('staff'), 'awarded');
  assert.equal(writes.length, 1);
  assert.equal((writes[0] as { role: string }).role, config.verificationRoleId);
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
