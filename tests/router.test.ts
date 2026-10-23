import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags, PermissionsBitField, type Interaction } from 'discord.js';
import { AuditLog, type AuditEvent } from '../src/audit.js';
import type { Config } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { VERIFY_CUSTOM_ID } from '../src/policy.js';
import { InteractionRouter } from '../src/router.js';
import { VerificationService, type VerificationGateway } from '../src/verification.js';

function fixture(kind: 'command' | 'button' = 'button') {
  const config: Config = {
    token: 'test', guildId: 'guild', applicationId: 'bot', verificationRoleId: 'member-role',
    verificationChannelId: 'verification', commandsChannelId: 'commands', logsChannelId: 'logs',
    verificationMessageId: undefined, port: 8080, logLevel: 'error',
  };
  const events: AuditEvent[] = [];
  const awarded: string[] = [];
  const replies: unknown[] = [];
  const logger = new Logger('error', '');
  logger.write = () => {};
  const audit = new AuditLog(logger);
  audit.setSink(async event => { events.push(event); });
  const gateway: VerificationGateway = {
    getMember: async () => ({ hasRole: false, pending: false, bot: false }),
    assertRoleAssignable: async () => {},
    addRole: async id => { awarded.push(id); },
  };
  const verification = new VerificationService(gateway);
  let refreshes = 0;
  const router = new InteractionRouter({
    config, audit, logger, botId: () => 'bot', isReady: () => true, panelId: () => 'panel',
    verification: () => verification,
    refreshPanel: async () => { refreshes++; return { id: 'panel', created: false }; },
  });
  const raw = {
    guildId: 'guild', channelId: kind === 'button' ? 'verification' : 'commands',
    user: { id: 'member' }, message: { id: 'panel', author: { id: 'bot' } },
    customId: VERIFY_CUSTOM_ID, commandName: 'about', memberPermissions: new PermissionsBitField(),
    deferred: false, replied: false,
    isChatInputCommand: () => kind === 'command', isButton: () => kind === 'button',
    async reply(payload: unknown) { raw.replied = true; replies.push(payload); },
    async deferReply(payload: unknown) { raw.deferred = true; replies.push(payload); },
    async editReply(payload: unknown) { replies.push(payload); },
  };
  return { raw, events, awarded, replies, gateway, audit, refreshes: () => refreshes,
    run: async () => { await router.handle(raw as unknown as Interaction); await audit.flush(); } };
}

test('trusted button defers privately, awards the clicking member, and logs the confirmed role', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.awarded, ['member']);
  assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
  assert.equal(f.events[0]!.event, 'verification_succeeded');
  assert.equal(f.events[0]!.roleId, 'member-role');
});

test('forged, stale, wrong-channel, and wrong-guild panels cannot trigger member or role calls', async () => {
  for (const change of ['author', 'message', 'channel', 'guild']) {
    const f = fixture();
    let reads = 0;
    f.gateway.getMember = async () => { reads++; throw new Error('must not fetch'); };
    if (change === 'author') f.raw.message.author.id = 'someone';
    if (change === 'message') f.raw.message.id = 'old-panel';
    if (change === 'channel') f.raw.channelId = 'elsewhere';
    if (change === 'guild') f.raw.guildId = 'another-guild';
    await f.run();
    assert.equal(reads, 0);
    assert.deepEqual(f.awarded, []);
    assert.equal(f.raw.deferred, false);
  }
});

test('a failed role write produces failure logs and no success event', async () => {
  const f = fixture();
  f.gateway.addRole = async () => { throw new Error('private token must not be logged'); };
  await f.run();
  assert.deepEqual(f.events.map(event => event.event), ['verification_failed']);
  assert.equal(f.events[0]!.detail, 'Error');
});

test('lost confirmation reply preserves the successful role-award log', async () => {
  const f = fixture();
  f.raw.editReply = async () => { throw new Error('interaction expired'); };
  await f.run();
  assert.deepEqual(f.awarded, ['member']);
  assert.deepEqual(f.events.map(event => event.event), ['verification_succeeded']);
});

test('panel command enforces Manage Server at runtime and logs denial', async () => {
  const f = fixture('command');
  f.raw.commandName = 'verification';
  await f.run();
  assert.equal(f.refreshes(), 0);
  assert.equal(f.events[0]!.outcome, 'denied_permission');
});

test('command channel restriction applies before panel updates', async () => {
  const f = fixture('command');
  f.raw.channelId = 'elsewhere';
  await f.run();
  assert.equal(f.events[0]!.outcome, 'denied_channel');
  assert.equal(f.raw.replied, true);
});

test('about sends its public embed and records command use', async () => {
  const f = fixture('command');
  await f.run();
  assert.equal(f.events[0]!.command, 'about');
  assert.equal(f.events[0]!.outcome, 'success');
  const payload = f.replies[0] as { flags?: number; embeds: unknown[] };
  assert.equal(payload.flags, undefined);
  assert.equal(payload.embeds.length, 1);
});
