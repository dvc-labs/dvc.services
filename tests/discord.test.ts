import assert from 'node:assert/strict';
import test from 'node:test';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Collection, MessageFlags,
  PermissionFlagsBits, PermissionsBitField, RESTJSONErrorCodes, Routes, type Client, type Guild, type TextChannel } from 'discord.js';
import { DiscordBulletinGateway, DiscordMinecrafterGateway, DiscordVerificationGateway, discordPanelRepository, preflight } from '../src/discord.js';
import { ensureVerificationPanel } from '../src/panel.js';
import { BULLETIN_JOIN_REASON, BULLETIN_LEAVE_REASON, BULLETIN_PANEL_BUTTON, BULLETIN_VERIFY_BUTTON,
  hasEnabledButton, MINECRAFTER_ROLE_REASON, VERIFY_CUSTOM_ID } from '../src/policy.js';
import { card, verificationPanel } from '../src/ui.js';
import { testConfig, TEST_MINECRAFT_CHANNEL_ID, TEST_MOD_CHANNEL_ID } from './helpers.js';
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
    TEST_MOD_CHANNEL_ID, TEST_MINECRAFT_CHANNEL_ID].map(id => [id, {
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
  return { config, me, channels, roles, hierarchy, memberView, guild, client: client as unknown as Client<true> };
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
  const modChannelId = TEST_MOD_CHANNEL_ID;
  const minecraftChannelId = TEST_MINECRAFT_CHANNEL_ID;
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
      fetch: async (options: { message?: string; before?: string }) => options.message ? message
        : new Collection(options.before ? [] : [[message.id, message]]),
      edit: async (id: string, payload: typeof edits[number]) => { edits.push({ ...payload, id }); message.components = payload.components; },
    },
    send: async () => { creates++; return { id: 'another-panel' }; },
  };
  const repository = discordPanelRepository(channel as unknown as TextChannel, config);
  assert.deepEqual(await ensureVerificationPanel(repository, config.applicationId, message.id),
    { id: message.id, created: false, retiredBulletinCards: 0 });
  assert.equal(edits[0]!.content, null);
  assert.deepEqual(edits[0]!.embeds, []);
  assert.equal(edits[0]!.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(await ensureVerificationPanel(repository, config.applicationId, undefined, false),
    { id: message.id, created: false, retiredBulletinCards: 0 });
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

test('startup names View Server Insights and the affected role without banning it from the bot', async () => {
  const f = preflightFixture();
  f.me.permissions.add(PermissionFlagsBits.ViewGuildInsights);
  await preflight(f.client, f.config);
  const memberRole = f.roles.get(f.config.verificationRoleId)!;
  memberRole.permissions.add(PermissionFlagsBits.ViewGuildInsights);
  await assert.rejects(preflight(f.client, f.config), /Remove View Server Insights from the verification role/);
  memberRole.permissions.remove(PermissionFlagsBits.ViewGuildInsights);
  const bulletinRoleId = '999999999999999999';
  f.roles.set(bulletinRoleId, { ...memberRole, id: bulletinRoleId,
    permissions: new PermissionsBitField(PermissionFlagsBits.ViewGuildInsights) });
  Object.assign(f.config, { bulletinRoleId });
  await assert.rejects(preflight(f.client, f.config), /Remove View Server Insights from the Bulletin role/);
});

test('the adapter removes a disabled legacy Bulletin card and keeps preferences on the same verification message', async () => {
  const config = testConfig();
  const roleId = '999999999999999999';
  const verification = { id: '777777777777777777', author: { id: config.applicationId },
    components: verificationPanel(config.emoji, false).components };
  const bulletin = { id: '888888888888888888', author: { id: config.applicationId },
    components: card('Legacy Bulletin', 'Old preferences', [], { buttons: [new ButtonBuilder().setCustomId(BULLETIN_PANEL_BUTTON)
      .setLabel('Bulletin preferences').setStyle(ButtonStyle.Secondary).setDisabled(true)] }).components };
  const other = { ...bulletin, id: '666666666666666666', author: { id: '555555555555555555' } };
  const messages = new Collection([[bulletin.id, bulletin], [verification.id, verification], [other.id, other]]);
  const channel = { messages: {
    fetch: async ({ before }: { before?: string }) => before ? new Collection() : new Collection(messages),
    edit: async (id: string, payload: ReturnType<typeof verificationPanel>) => { messages.get(id)!.components = payload.components; },
    delete: async (id: string) => { messages.delete(id); },
  }, send: async () => { assert.fail('Expected the existing verification message to be reused'); } };
  const repository = discordPanelRepository(channel as unknown as TextChannel, { ...config, bulletinRoleId: roleId });
  assert.deepEqual(await ensureVerificationPanel(repository, config.applicationId),
    { id: verification.id, created: false, retiredBulletinCards: 1 });
  assert.ok(hasEnabledButton(verification.components.map(c => c.toJSON()), VERIFY_CUSTOM_ID));
  assert.ok(hasEnabledButton(verification.components.map(c => c.toJSON()), BULLETIN_VERIFY_BUTTON));
  assert.deepEqual([...messages.keys()], [verification.id, other.id]);
});

test('Minecrafter is awarded once to the eligible applicant and cannot grant access to the moderation channel', async () => {
  const f = preflightFixture();
  const roleId = '999999999999999999';
  const userId = '888888888888888888';
  const role = { id: roleId, managed: false, permissions: new PermissionsBitField() };
  f.roles.set(roleId, role);
  const memberRoles = new Set([f.config.verificationRoleId]);
  const writes: unknown[] = [];
  const member = { roles: [...memberRoles], user: { bot: false }, pending: false };
  let lookupError: Error | undefined;
  Object.assign(f.guild, { client: { rest: { get: async (route: string) => {
    assert.equal(route, Routes.guildMember(f.config.guildId, userId));
    if (lookupError) throw lookupError;
    return { ...member, roles: [...memberRoles] };
  } } } });
  Object.assign(f.guild.members, {
    addRole: async (options: unknown) => { writes.push(options); memberRoles.add(roleId); },
  });
  const gateway = new DiscordMinecrafterGateway(f.guild as unknown as Guild, f.config, roleId,
    f.channels.get(TEST_MOD_CHANNEL_ID) as unknown as TextChannel);
  f.memberView.set(TEST_MOD_CHANNEL_ID, new Set([roleId]));
  await assert.rejects(gateway.prepareAward(userId), /Keep MOD_CHANNEL_ID private/);
  f.memberView.clear();
  f.hierarchy.set(roleId, 0);
  await assert.rejects(gateway.prepareAward(userId), /above the Minecrafter role/);
  f.hierarchy.clear();
  const grant = await gateway.prepareAward(userId);
  assert.deepEqual(writes, []);
  await grant();
  await (await gateway.prepareAward(userId))();
  member.pending = true;
  await assert.rejects(gateway.prepareAward(userId), /must still have access/);
  member.pending = false;
  memberRoles.delete(f.config.verificationRoleId);
  await assert.rejects(gateway.prepareAward(userId), /must still have access/);
  assert.equal(await gateway.hasRole(userId, roleId), true);
  // A stale guild role cache must not hide a held role during recovery.
  f.roles.delete(roleId);
  assert.equal(await gateway.hasRole(userId, roleId), true);
  lookupError = Object.assign(new Error('Unknown member'), { code: RESTJSONErrorCodes.UnknownMember, status: 404 });
  assert.equal(await gateway.hasRole(userId, roleId), false);
  f.roles.set(roleId, role);
  await assert.rejects(gateway.prepareAward(userId), /must still have access/);
  lookupError = Object.assign(new Error('Missing access'), { code: RESTJSONErrorCodes.MissingAccess, status: 403 });
  await assert.rejects(gateway.hasRole(userId, roleId), { code: RESTJSONErrorCodes.MissingAccess });
  assert.deepEqual(writes, [{ user: userId, role: roleId, reason: MINECRAFTER_ROLE_REASON }]);
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
