import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { commands } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { errorSummary } from '../src/logger.js';
import { assertSafeVerificationRole, Cooldown, isTrustedVerificationButton, VERIFY_CUSTOM_ID } from '../src/policy.js';
import { verificationPanel } from '../src/ui.js';
import { BRAND_COLOR, VERSION } from '../src/version.js';

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
  assert.doesNotThrow(() => assertSafeVerificationRole(role, 'guild'));
  assert.throws(() => assertSafeVerificationRole({ ...role, id: 'guild' }, 'guild'));
  assert.throws(() => assertSafeVerificationRole({ ...role, managed: true }, 'guild'));
  for (const permission of [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.BanMembers]) {
    assert.throws(() => assertSafeVerificationRole({ ...role, permissions: new PermissionsBitField(permission) }, 'guild'));
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
    assert.throws(() => assertSafeVerificationRole({
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
});

test('branding, persistent button ID, and package version remain consistent', () => {
  const panel = verificationPanel();
  assert.equal(panel.embeds[0]!.toJSON().color, 0x26bcc5);
  assert.equal(BRAND_COLOR, 0x26bcc5);
  const button = panel.components[0]!.toJSON().components[0]!;
  assert.ok('custom_id' in button);
  assert.equal(button.custom_id, VERIFY_CUSTOM_ID);
  assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('error diagnostics exclude tokens, request data, and raw error text', () => {
  const error = Object.assign(new Error('secret-token in request URL'), {
    name: 'DiscordAPIError', code: 50013, status: 403,
    requestBody: { token: 'private-interaction-token' },
  });
  assert.equal(errorSummary(error), 'DiscordAPIError code=50013 status=403');
  assert.equal(errorSummary({ token: 'secret' }), 'UnknownError');
});
