import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GatewayIntentBits, IntentsBitField, MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { REQUIRED_GATEWAY_INTENTS, clientOptions, intentFailureHint } from '../src/client-options.js';
import { commands } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { errorSummary } from '../src/logger.js';
import { assertSafeMemberRole, Cooldown, hasEnabledButton, isTrustedVerificationButton, VERIFY_CUSTOM_ID } from '../src/policy.js';
import { verificationPanel } from '../src/ui.js';
import { BRAND_COLOR, VERSION } from '../src/version.js';
import { TEST_MINECRAFT_CHANNEL_ID as minecraft, TEST_MOD_CHANNEL_ID as mod } from './helpers.js';

export function environment(): NodeJS.ProcessEnv {
  return {
    DISCORD_TOKEN: 'unit-test-token',
    GUILD_ID: '111111111111111111',
    APPLICATION_ID: '222222222222222222',
    VERIFICATION_ROLE_ID: '333333333333333333',
    VERIFICATION_CHANNEL_ID: '444444444444444444',
    COMMANDS_CHANNEL_ID: '555555555555555555',
    LOGS_CHANNEL_ID: '666666666666666666',
  };
}

test('configuration preserves snowflakes as exact strings and applies defaults', () => {
  const config = loadConfig(environment());
  assert.equal(config.guildId, '111111111111111111');
  assert.equal(config.port, 8080);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.verificationMessageId, undefined);
  assert.ok(Object.isFrozen(config));
});

test('Cherry Creek accepts a separate pair of configured channels and rejects half-configured or overlapping destinations', () => {
  assert.equal(loadConfig(environment()).modChannelId, undefined);
  const config = loadConfig({ ...environment(), MOD_CHANNEL_ID: mod, MINECRAFT_CHANNEL_ID: minecraft });
  assert.equal(config.modChannelId, mod);
  assert.equal(config.minecraftChannelId, minecraft);
  for (const extra of [{ MOD_CHANNEL_ID: mod }, { MINECRAFT_CHANNEL_ID: minecraft },
    { MOD_CHANNEL_ID: minecraft, MINECRAFT_CHANNEL_ID: minecraft },
    { MOD_CHANNEL_ID: environment().LOGS_CHANNEL_ID, MINECRAFT_CHANNEL_ID: minecraft }]) {
    assert.throws(() => loadConfig({ ...environment(), ...extra }), /MOD_CHANNEL_ID/);
  }
});

test('configuration rejects missing secrets, malformed IDs, invalid ports, and colliding channels', () => {
  for (const [key, value] of [
    ['DISCORD_TOKEN', ''], ['DISCORD_TOKEN', 'Bot secret'], ['GUILD_ID', '1e18'],
    ['GUILD_ID', '99999999999999999999'], ['PORT', '8080junk'], ['PORT', '65536'],
    ['LOG_LEVEL', 'verbose'], ['LOGS_CHANNEL_ID', environment().COMMANDS_CHANNEL_ID!],
    ['VERIFICATION_ROLE_ID', environment().GUILD_ID!], ['VERIFICATION_MESSAGE_ID', 'invalid'],
  ]) {
    assert.throws(() => loadConfig({ ...environment(), [key!]: value }), { name: 'SetupError' });
  }
});

test('verification requires the configured guild, channel, bot author, active message, and component', () => {
  const expected = { guildId: 'guild', channelId: 'channel', botId: 'bot', messageId: 'panel' };
  const context = { guildId: 'guild', channelId: 'channel', authorId: 'bot', messageId: 'panel', customId: VERIFY_CUSTOM_ID };
  assert.equal(isTrustedVerificationButton(context, expected), true);
  for (const key of Object.keys(context) as (keyof typeof context)[]) {
    assert.equal(isTrustedVerificationButton({ ...context, [key]: 'other' }, expected), false);
  }
  assert.equal(isTrustedVerificationButton({ ...context, guildId: null }, expected), false);
  assert.equal(isTrustedVerificationButton(context, { ...expected, messageId: undefined }), false);
});

test('verification never awards an integration, everyone, or staff role', () => {
  const role = { id: 'members', managed: false, permissions: new PermissionsBitField(PermissionFlagsBits.ViewChannel) };
  assert.doesNotThrow(() => assertSafeMemberRole(role, 'guild'));
  assert.throws(() => assertSafeMemberRole({ ...role, id: 'guild' }, 'guild'));
  assert.throws(() => assertSafeMemberRole({ ...role, managed: true }, 'guild'));
  for (const permission of [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.BanMembers]) {
    assert.throws(() => assertSafeMemberRole({ ...role, permissions: new PermissionsBitField(permission) }, 'guild'));
  }
});

test('self-service Bulletin roles get the same safety checks and name themselves in the error', () => {
  const role = { id: 'bulletin', managed: false, permissions: new PermissionsBitField(PermissionFlagsBits.MentionEveryone) };
  assert.doesNotThrow(() => assertSafeMemberRole(role, 'guild', 'Bulletin'));
  assert.throws(() => assertSafeMemberRole({ ...role, id: 'guild' }, 'guild', 'Bulletin'), { message: /^The Bulletin role must be a normal member role/ });
  assert.throws(() => assertSafeMemberRole({ ...role, managed: true }, 'guild', 'Bulletin'), { name: 'SetupError' });
  assert.throws(() => assertSafeMemberRole({ ...role, permissions: new PermissionsBitField(PermissionFlagsBits.KickMembers) }, 'guild', 'Bulletin'),
    { message: /^The Bulletin role must not grant administrative or moderation permissions/ });
});

test('BULLETIN_ROLE_ID is optional, exact, and cannot be @everyone or the verification role', () => {
  assert.equal(loadConfig(environment()).bulletinRoleId, undefined);
  assert.equal(loadConfig({ ...environment(), BULLETIN_ROLE_ID: '  ' }).bulletinRoleId, undefined);
  assert.equal(loadConfig({ ...environment(), BULLETIN_ROLE_ID: ' 1562268805474820156 ' }).bulletinRoleId, '1562268805474820156');
  for (const value of ['not-a-role', '1e18', environment().GUILD_ID!, environment().VERIFICATION_ROLE_ID!]) {
    assert.throws(() => loadConfig({ ...environment(), BULLETIN_ROLE_ID: value }), { name: 'SetupError' });
  }
});

test('ADMIN_ROLE_ID is an optional existing role and cannot coincide with self-assignable roles', () => {
  const id = '1562268805474820156';
  assert.equal(loadConfig(environment()).adminRoleId, undefined);
  assert.equal(loadConfig({ ...environment(), ADMIN_ROLE_ID: ` ${id} ` }).adminRoleId, id);
  for (const value of ['invalid', id, environment().GUILD_ID!, environment().VERIFICATION_ROLE_ID!]) {
    assert.throws(() => loadConfig({ ...environment(), BULLETIN_ROLE_ID: id, ADMIN_ROLE_ID: value }), /ADMIN_ROLE_ID/);
  }
});

test('the optional Hall connection accepts an HTTPS origin and rejects credentials, paths, and redirects in its config', () => {
  assert.equal(loadConfig(environment()).hallWorkerUrl, undefined);
  const config = loadConfig({ ...environment(), WORKER_URL: ' https://hall.example/ ', HALLAI_API_KEY: ' secret ' });
  assert.equal(config.hallWorkerUrl, 'https://hall.example');
  assert.equal(config.hallApiKey, 'secret');
  for (const value of ['http://hall.example', 'https://user:pass@hall.example', 'https://hall.example/api/chat',
    'https://hall.example/?redirect=1', 'https://hall.example/#fragment']) {
    assert.throws(() => loadConfig({ ...environment(), WORKER_URL: value }), /WORKER_URL/);
  }
});

for (const name of ['PinMessages', 'BypassSlowmode'] as const) {
  test(`verification rejects ${name} without ManageMessages`, () => {
    const permissions = new PermissionsBitField([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits[name],
    ]);
    assert.equal(permissions.has(PermissionFlagsBits.ManageMessages), false);
    assert.throws(() => assertSafeMemberRole({
      id: 'members', managed: false, permissions,
    }, 'guild'), { name: 'SetupError', message: /administrative or moderation permissions/ });
  });
}

test('cooldowns are per member and expire', () => {
  let now = 1;
  const cooldown = new Cooldown(5_000, () => now);
  assert.equal(cooldown.take('a'), true);
  assert.equal(cooldown.take('a'), false);
  assert.equal(cooldown.take('b'), true);
  now += 5_000;
  assert.equal(cooldown.take('a'), true);
});

test('panel command requires Manage Server by default', () => {
  const definitions = commands.map(command => command.toJSON());
  assert.equal(definitions.find(command => command.name === 'verification')!.default_member_permissions,
    PermissionFlagsBits.ManageGuild.toString());
  assert.equal(definitions.find(command => command.name === 'member')!.default_member_permissions ?? null, null);
});

test('branding, persistent button ID, and package version remain consistent', () => {
  const panel = verificationPanel();
  assert.equal(panel.components[0]!.toJSON().accent_color, 0x26bcc5);
  assert.equal(panel.flags, MessageFlags.IsComponentsV2);
  assert.equal(BRAND_COLOR, 0x26bcc5);
  assert.equal(hasEnabledButton(panel.components.map(component => component.toJSON()), VERIFY_CUSTOM_ID), true);
  assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('panel discovery recognises legacy rows and nested V2 buttons without matching other components', () => {
  const button = { type: 2, custom_id: VERIFY_CUSTOM_ID };
  assert.equal(hasEnabledButton([{ type: 1, components: [button] }], VERIFY_CUSTOM_ID), true);
  assert.equal(hasEnabledButton([{ type: 17, components: [{ type: 1, components: [button] }] }], VERIFY_CUSTOM_ID), true);
  assert.equal(hasEnabledButton([{ type: 10, content: VERIFY_CUSTOM_ID }], VERIFY_CUSTOM_ID), false);
  assert.equal(hasEnabledButton([{ type: 2, custom_id: 'unrelated' }], VERIFY_CUSTOM_ID), false);
  assert.equal(hasEnabledButton([{ ...button, disabled: true }], VERIFY_CUSTOM_ID), false);
});

test('only the five used intents are requested and message content is excluded', () => {
  const intents = new IntentsBitField(REQUIRED_GATEWAY_INTENTS);
  assert.equal(intents.bitfield, 391);
  assert.equal(intents.has(GatewayIntentBits.MessageContent), false);
  assert.equal(intents.has(GatewayIntentBits.DirectMessages), false);
  const options = clientOptions();
  assert.deepEqual(options.allowedMentions, { parse: [], repliedUser: false });
  assert.ok(options.makeCache);
});

test('login hints are limited to DisallowedIntents errors and close code 4014', () => {
  for (const code of ['DisallowedIntents', 4014]) assert.match(intentFailureHint({ code })!, /Server Members and Presence/);
  for (const error of [{ code: 'TokenInvalid' }, { code: 4004 }, new Error('Used disallowed intents'), null, 'secret']) {
    assert.equal(intentFailureHint(error), undefined);
  }
});

test('test deployments can select another application emoji or disable branding', () => {
  assert.equal(loadConfig({ ...environment(), DVC_EMOJI: '<:test:777777777777777777>' }).emoji, '<:test:777777777777777777>');
  assert.equal(loadConfig({ ...environment(), DVC_EMOJI: 'none' }).emoji, '');
  assert.equal(loadConfig({ ...environment(), DVC_EMOJI: '' }).emoji, loadConfig(environment()).emoji);
  assert.equal(loadConfig({ ...environment(), DVC_EMOJI: '   ' }).emoji, loadConfig(environment()).emoji);
  assert.throws(() => loadConfig({ ...environment(), DVC_EMOJI: '[bad](https://example.com)' }), /DVC_EMOJI/);
  const panel = verificationPanel('');
  assert.equal(JSON.stringify(panel).includes('1566457051465388194'), false);
  assert.equal(JSON.stringify(verificationPanel('<:test:777777777777777777>')).includes('"id":"777777777777777777"'), true);
});

test('error diagnostics exclude tokens, request data, and raw error text', () => {
  const error = Object.assign(new Error('secret-token in request URL'), {
    name: 'DiscordAPIError', code: 50013, status: 403,
    requestBody: { token: 'private-interaction-token' },
  });
  assert.equal(errorSummary(error), 'DiscordAPIError code=50013 status=403');
  assert.equal(errorSummary({ token: 'secret' }), 'UnknownError');
});
