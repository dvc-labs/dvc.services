import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags, PermissionsBitField, type Interaction, type ModalBuilder } from 'discord.js';
import { AuditLog, type AuditEvent } from '../src/audit.js';
import type { Config } from '../src/config.js';
import { Logger } from '../src/logger.js';
import { verificationModalId, VERIFY_CUSTOM_ID, VERIFY_INPUT_CUSTOM_ID } from '../src/policy.js';
import { InteractionRouter } from '../src/router.js';
import { VerificationService, type VerificationGateway } from '../src/verification.js';

function fixture(kind: 'command' | 'button' | 'modal' = 'button') {
  const config: Config = {
    token: 'test', guildId: 'guild', applicationId: 'bot', verificationRoleId: 'member-role',
    verificationChannelId: 'verification', commandsChannelId: 'commands', logsChannelId: 'logs',
    verificationMessageId: undefined, port: 8080, logLevel: 'error',
  };
  const events: AuditEvent[] = [];
  const awarded: string[] = [];
  const replies: unknown[] = [];
  const forms: ModalBuilder[] = [];
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
  let ready = true;
  let panelId = 'panel';
  const router = new InteractionRouter({
    config, audit, logger, botId: () => 'bot', isReady: () => ready, panelId: () => panelId,
    verification: () => verification,
    refreshPanel: async () => { refreshes++; return { id: 'panel', created: false }; },
  });
  const raw = {
    kind, word: 'verify', fromMessage: true,
    guildId: 'guild', channelId: kind === 'command' ? 'commands' : 'verification',
    user: { id: 'member' }, message: { id: 'panel', author: { id: 'bot' } },
    customId: kind === 'modal' ? verificationModalId('member', 'panel') : VERIFY_CUSTOM_ID,
    commandName: 'about', memberPermissions: new PermissionsBitField(),
    deferred: false, replied: false,
    isChatInputCommand: () => raw.kind === 'command', isButton: () => raw.kind === 'button',
    isModalSubmit: () => raw.kind === 'modal', isFromMessage: () => raw.fromMessage,
    fields: { getTextInputValue: (id: string) => {
      assert.equal(id, VERIFY_INPUT_CUSTOM_ID);
      return raw.word;
    } },
    async showModal(payload: ModalBuilder) { raw.replied = true; payload.toJSON(); forms.push(payload); },
    async reply(payload: unknown) { raw.replied = true; replies.push(payload); },
    async deferReply(payload: unknown) { raw.deferred = true; replies.push(payload); },
    async editReply(payload: unknown) { replies.push(payload); },
  };
  return { raw, events, awarded, replies, forms, gateway, audit, refreshes: () => refreshes,
    setReady: (value: boolean) => { ready = value; },
    setPanel: (value: string) => { panelId = value; },
    submit: (word: string) => {
      raw.kind = 'modal'; raw.word = word; raw.replied = false; raw.deferred = false;
      raw.customId = forms[0]!.toJSON().custom_id;
    },
    run: async () => { await router.handle(raw as unknown as Interaction); await audit.flush(); } };
}

test('trusted button opens a required text form without reading members or awarding a role', async () => {
  const f = fixture();
  f.gateway.getMember = async () => { throw new Error('must not fetch before form submission'); };
  await f.run();
  assert.equal(f.forms.length, 1);
  assert.equal(f.forms[0]!.toJSON().custom_id, verificationModalId('member', 'panel'));
  assert.equal(f.raw.deferred, false);
  assert.deepEqual(f.awarded, []);
  assert.deepEqual(f.replies, []);
  assert.deepEqual(f.events, []);
});

test('submitting verify ignores capitalisation and surrounding spaces and privately awards only the member', async () => {
  for (const word of ['verify', 'VERIFY', 'VeRiFy', '  verify  ', '\tVERIFY\n']) {
    const f = fixture();
    await f.run();
    f.submit(word);
    await f.run();
    assert.deepEqual(f.awarded, ['member']);
    assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
    assert.equal(f.events[0]!.event, 'verification_succeeded');
    assert.equal(f.events[0]!.roleId, 'member-role');
  }
});

test('incorrect, empty, and partial words produce private retry guidance without member or role calls', async () => {
  for (const word of ['', '  ', 'yes', 'verified', 'verify please', 'ver ify', 'private input']) {
    const f = fixture('modal');
    let reads = 0;
    f.gateway.getMember = async () => { reads++; throw new Error('must not fetch'); };
    f.raw.word = word;
    await f.run();
    assert.equal(reads, 0);
    assert.deepEqual(f.awarded, []);
    assert.equal(f.raw.deferred, false);
    assert.equal((f.replies[0] as { flags: number }).flags, MessageFlags.Ephemeral);
    assert.equal(f.events[0]!.outcome, 'incorrect_word');
    assert.equal(JSON.stringify(f.events).includes('private input'), false);
  }
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
    assert.deepEqual(f.forms, []);
  }
});

test('forms from another member, panel, channel, guild, or author cannot trigger member or role calls', async () => {
  for (const change of ['user', 'message', 'channel', 'guild', 'author', 'missing_message', 'not_ready', 'replaced_panel', 'custom_id']) {
    const f = fixture('modal');
    let reads = 0;
    f.gateway.getMember = async () => { reads++; throw new Error('must not fetch'); };
    if (change === 'user') f.raw.user.id = 'someone';
    if (change === 'message') f.raw.message.id = 'old-panel';
    if (change === 'channel') f.raw.channelId = 'elsewhere';
    if (change === 'guild') f.raw.guildId = 'another-guild';
    if (change === 'author') f.raw.message.author.id = 'someone';
    if (change === 'missing_message') f.raw.fromMessage = false;
    if (change === 'not_ready') f.setReady(false);
    if (change === 'replaced_panel') f.setPanel('new-panel');
    if (change === 'custom_id') f.raw.customId = verificationModalId('member', 'old-panel');
    await f.run();
    assert.equal(reads, 0);
    assert.deepEqual(f.awarded, []);
    assert.equal(f.raw.deferred, false);
    assert.equal(f.events.find(event => event.event === 'verification_succeeded'), undefined);
  }
});

test('a failed role write produces failure logs and no success event', async () => {
  const f = fixture('modal');
  f.gateway.addRole = async () => { throw new Error('private token must not be logged'); };
  await f.run();
  assert.deepEqual(f.events.map(event => event.event), ['verification_failed']);
  assert.equal(f.events[0]!.detail, 'Error');
});

test('lost confirmation reply preserves the successful role-award log', async () => {
  const f = fixture('modal');
  f.raw.editReply = async () => { throw new Error('interaction expired'); };
  await f.run();
  assert.deepEqual(f.awarded, ['member']);
  assert.deepEqual(f.events.map(event => event.event), ['verification_succeeded']);
});

test('repeated modal submissions cannot award the role twice', async () => {
  const f = fixture('modal');
  let reads = 0;
  f.gateway.getMember = async () => { reads++; return { hasRole: false, pending: false, bot: false }; };
  await f.run();
  await f.run();
  assert.deepEqual(f.awarded, ['member']);
  assert.equal(reads, 1);
  assert.deepEqual(f.events.map(event => event.outcome), ['awarded', 'cooldown']);
});

test('unrelated buttons and forms are ignored', async () => {
  for (const kind of ['button', 'modal'] as const) {
    const f = fixture(kind);
    f.raw.customId = 'another-feature';
    await f.run();
    assert.deepEqual(f.awarded, []);
    assert.deepEqual(f.replies, []);
    assert.deepEqual(f.forms, []);
    assert.deepEqual(f.events, []);
  }
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
