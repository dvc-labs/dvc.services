import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags, PermissionFlagsBits, PermissionsBitField, type Interaction } from 'discord.js';
import { AuditLog, type AuditEvent } from '../src/audit.js';
import type { Config } from '../src/config.js';
import { SetupError } from '../src/errors.js';
import { Logger } from '../src/logger.js';
import { memberNavigationId, type MemberReport } from '../src/member.js';
import { VERIFY_CUSTOM_ID } from '../src/policy.js';
import { InteractionRouter, type RouterDependencies } from '../src/router.js';
import { VerificationService, type VerificationGateway } from '../src/verification.js';
import { messageText } from './helpers.js';

function fixture(kind: 'command' | 'button' | 'modal' = 'button') {
  const config: Config = {
    token: 'test', guildId: 'guild', applicationId: 'bot', verificationRoleId: 'member-role',
    verificationChannelId: 'verification', commandsChannelId: 'commands', logsChannelId: 'logs',
    verificationMessageId: undefined, port: 8080, logLevel: 'error',
  };
  const events: AuditEvent[] = [];
  const awarded: string[] = [];
  const replies: unknown[] = [];
  const logs: Parameters<Logger['write']>[] = [];
  const logger = new Logger('error', '');
  logger.write = (...args) => { logs.push(args); };
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
  const deps: RouterDependencies = {
    config, audit, logger, botId: () => 'bot', isReady: () => ready, panelId: () => panelId,
    verification: () => verification,
    memberReport: async () => { throw new Error('Unexpected member lookup'); },
    refreshPanel: async () => { refreshes++; return { id: 'panel', created: false }; },
  };
  const router = new InteractionRouter(deps);
  const raw = {
    kind,
    guildId: 'guild', channelId: kind === 'command' ? 'commands' : 'verification',
    user: { id: 'member' }, message: { id: 'panel', author: { id: 'bot' } },
    customId: kind === 'modal' ? 'dvc:verify:form:v1:member:panel' : VERIFY_CUSTOM_ID,
    commandName: 'about', memberPermissions: new PermissionsBitField(),
    options: { getUser: () => ({ id: '777777777777777777' }) },
    deferred: false, replied: false,
    isChatInputCommand: () => raw.kind === 'command', isButton: () => raw.kind === 'button',
    isModalSubmit: () => raw.kind === 'modal',
    async reply(payload: unknown) { raw.replied = true; replies.push(payload); },
    async deferReply(payload: unknown) { raw.deferred = true; replies.push(payload); },
    async deferUpdate() { raw.deferred = true; replies.push({ deferUpdate: true }); },
    async editReply(payload: unknown) { replies.push(payload); },
  };
  return { raw, events, awarded, replies, logs, gateway, audit, deps, refreshes: () => refreshes,
    setReady: (value: boolean) => { ready = value; },
    setPanel: (value: string) => { panelId = value; },
    handle: () => router.handle(raw as unknown as Interaction),
    run: async () => { await router.handle(raw as unknown as Interaction); await audit.flush(); } };
}

test('trusted button defers privately before fetching and awards only the clicking member', async () => {
  const f = fixture();
  f.gateway.getMember = async () => {
    assert.equal(f.raw.deferred, true);
    return { hasRole: false, pending: false, bot: false };
  };
  await f.run();
  assert.deepEqual(f.awarded, ['member']);
  assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
  assert.equal(f.events[0]!.event, 'verification_succeeded');
  assert.equal(f.events[0]!.roleId, 'member-role');
});

const lookup: MemberReport = {
  userId: '777777777777777777', thumbnail: 'https://cdn.discordapp.com/embed/avatars/0.png',
  pages: [{ title: 'Overview', fields: [{ name: 'Member', value: '<@777777777777777777>' }] },
    { title: 'Permissions', fields: [{ name: 'Permissions', value: 'View channel' }] }],
};

test('member command is public for ordinary members and audits the caller and target separately', async () => {
  const f = fixture('command');
  f.raw.commandName = 'member';
  f.raw.user.id = '888888888888888888';
  f.deps.memberReport = async userId => {
    assert.equal(f.raw.deferred, true);
    assert.equal(userId, lookup.userId);
    return lookup;
  };
  await f.run();
  assert.deepEqual(f.replies[0], {});
  assert.equal((f.replies[1] as { flags: number }).flags & MessageFlags.Ephemeral, 0);
  assert.match(messageText(f.replies[1]), /<@777777777777777777>/);
  assert.equal(f.events[0]!.userId, '888888888888888888');
  assert.equal(f.events[0]!.targetUserId, lookup.userId);
  assert.equal(f.events[0]!.outcome, 'success');
});

test('member lookup cannot run in another guild/channel or during startup', async () => {
  for (const change of ['guild', 'channel', 'not_ready']) {
    const f = fixture('command');
    f.raw.commandName = 'member';
    if (change === 'guild') f.raw.guildId = 'elsewhere';
    if (change === 'channel') f.raw.channelId = 'elsewhere';
    if (change === 'not_ready') f.setReady(false);
    let reads = 0;
    f.deps.memberReport = async () => { reads++; return lookup; };
    await f.run();
    assert.equal(reads, 0);
    assert.equal(f.raw.deferred, false);
    assert.equal((f.replies[0] as { flags: number }).flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  }
});

test('member page buttons recheck ownership, guild, channel, and bot authorship before reading', async () => {
  for (const change of ['owner', 'guild', 'channel', 'author', 'malformed', 'not_ready']) {
    const f = fixture();
    f.raw.user.id = '888888888888888888';
    f.raw.channelId = 'commands';
    f.raw.customId = memberNavigationId(f.raw.user.id, lookup.userId, 1);
    if (change === 'owner') f.raw.user.id = '999999999999999999';
    if (change === 'guild') f.raw.guildId = 'elsewhere';
    if (change === 'channel') f.raw.channelId = 'elsewhere';
    if (change === 'author') f.raw.message.author.id = 'someone';
    if (change === 'malformed') f.raw.customId += ':invalid';
    if (change === 'not_ready') f.setReady(false);
    let reads = 0;
    f.deps.memberReport = async () => { reads++; return lookup; };
    await f.run();
    assert.equal(reads, 0);
    assert.equal(f.raw.deferred, false);
  }
});

test('member navigation works for ordinary members and refreshes only the requested target', async () => {
  const f = fixture();
  f.raw.user.id = '888888888888888888';
  f.raw.channelId = 'commands';
  f.raw.customId = memberNavigationId(f.raw.user.id, lookup.userId, 1);
  let reads = 0;
  f.deps.memberReport = async userId => { assert.equal(userId, lookup.userId); reads++; return lookup; };
  await f.run();
  assert.equal(reads, 1);
  assert.deepEqual(f.replies[0], { deferUpdate: true });
  assert.match(messageText(f.replies[1]), /Member · Permissions/);
  assert.equal(f.events.length, 0); // Page navigation is console-only.
});

test('missing member and lookup failures produce generic guidance without exposing API error bodies', async () => {
  for (const missing of [true, false]) {
    const f = fixture('command');
    f.raw.commandName = 'member';
    f.deps.memberReport = async () => {
      if (missing) return null;
      throw new Error('private request body');
    };
    await f.run();
    assert.equal(f.events[0]!.outcome, missing ? 'member_not_found' : 'error');
    assert.equal(JSON.stringify(f.replies).includes('private request body'), false);
    assert.equal(JSON.stringify(f.logs).includes('private request body'), false);
  }
});

test('already verified, screening-pending, and bot members receive private replies without role writes', async () => {
  for (const [member, outcome] of [
    [{ hasRole: true, pending: false, bot: false }, 'already_verified'],
    [{ hasRole: false, pending: true, bot: false }, 'screening_pending'],
    [{ hasRole: false, pending: false, bot: true }, 'bot'],
  ] as const) {
    const f = fixture();
    f.gateway.getMember = async () => member;
    await f.run();
    assert.deepEqual(f.awarded, []);
    assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
    assert.equal(f.events[0]!.outcome, outcome);
  }
});

test('forged, stale, wrong-channel, and wrong-guild panels cannot trigger member or role calls', async () => {
  for (const change of ['author', 'message', 'channel', 'guild', 'not_ready', 'replaced_panel']) {
    const f = fixture();
    let reads = 0;
    f.gateway.getMember = async () => { reads++; throw new Error('must not fetch'); };
    if (change === 'author') f.raw.message.author.id = 'someone';
    if (change === 'message') f.raw.message.id = 'old-panel';
    if (change === 'channel') f.raw.channelId = 'elsewhere';
    if (change === 'guild') f.raw.guildId = 'another-guild';
    if (change === 'not_ready') f.setReady(false);
    if (change === 'replaced_panel') f.setPanel('new-panel');
    await f.run();
    assert.equal(reads, 0);
    assert.deepEqual(f.awarded, []);
    assert.equal(f.raw.deferred, false);
  }
});

test('forms opened before deployment are ignored without member or role calls', async () => {
  const f = fixture('modal');
  let reads = 0;
  f.gateway.getMember = async () => { reads++; throw new Error('must not fetch'); };
  await f.run();
  assert.equal(reads, 0);
  assert.deepEqual(f.awarded, []);
  assert.deepEqual(f.replies, []);
  assert.deepEqual(f.events, []);
});

test('a failed role write produces failure logs and no success event', async () => {
  const f = fixture();
  f.gateway.addRole = async () => { throw new Error('private token must not be logged'); };
  await f.run();
  assert.deepEqual(f.events.map(event => event.event), ['verification_failed']);
  assert.equal(f.events[0]!.detail, 'Error');
  assert.equal(JSON.stringify(f.logs).includes('private token'), false);
  assert.equal(JSON.stringify(f.replies).includes('private token'), false);
});

test('runtime role setup errors retain details in operator logs and give members generic private guidance', async () => {
  const f = fixture();
  const message = 'Move the dvc.services bot role above the verification role.';
  f.gateway.assertRoleAssignable = async () => { throw new SetupError(message); };
  await f.run();
  assert.deepEqual(f.awarded, []);
  assert.equal(f.events[0]!.detail, message);
  assert.equal(f.logs.find(([, event]) => event === 'interaction_failed')![2]!.error, message);
  assert.equal(JSON.stringify(f.replies).includes(message), false);
  assert.ok(JSON.stringify(f.replies).includes('Please try again shortly.'));
  assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
});

test('lost confirmation reply preserves the successful role-award log', async () => {
  const f = fixture();
  f.raw.editReply = async () => { throw new Error('interaction expired'); };
  await f.run();
  assert.deepEqual(f.awarded, ['member']);
  assert.deepEqual(f.events.map(event => event.event), ['verification_succeeded']);
});

test('repeated button presses cannot award twice and cooldown logs stay local', async () => {
  const f = fixture();
  let reads = 0;
  f.gateway.getMember = async () => { reads++; return { hasRole: false, pending: false, bot: false }; };
  await f.run();
  await f.run();
  assert.deepEqual(f.awarded, ['member']);
  assert.equal(reads, 1);
  assert.deepEqual(f.events.map(event => event.outcome), ['awarded']);
  assert.ok(f.logs.some(([, event, fields]) => event === 'verification_attempt' && fields?.outcome === 'cooldown'));
});

test('one member spamming Verify cannot displace another member’s successful audit event', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.audit.setSink(async event => { await blocked; f.events.push(event); });
  try {
    await f.handle();
    for (let i = 0; i < 150; i++) await f.handle();
    f.raw.user.id = 'another-member';
    await f.handle();
  } finally {
    release();
    await f.audit.flush();
  }
  assert.deepEqual(f.awarded, ['member', 'another-member']);
  assert.deepEqual(f.events.map(event => event.userId), ['member', 'another-member']);
  assert.equal(f.logs.filter(([, , fields]) => fields?.outcome === 'cooldown').length, 150);
});

test('concurrent button presses acknowledge processing locally and record one successful award', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.gateway.getMember = async () => {
    await blocked;
    return { hasRole: false, pending: false, bot: false };
  };
  const first = f.handle();
  try {
    await f.handle();
    assert.ok(f.logs.some(([, , fields]) => fields?.outcome === 'processing'));
  } finally { release(); await first; await f.audit.flush(); }
  assert.deepEqual(f.awarded, ['member']);
  assert.deepEqual(f.events.map(event => event.outcome), ['awarded']);
});

test('unrelated buttons and forms are ignored', async () => {
  for (const kind of ['button', 'modal'] as const) {
    const f = fixture(kind);
    f.raw.customId = 'another-feature';
    await f.run();
    assert.deepEqual(f.awarded, []);
    assert.deepEqual(f.replies, []);
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

test('stale explicit panel configuration is actionable in operator logs with generic private guidance', async () => {
  const f = fixture('command');
  f.raw.commandName = 'verification';
  f.raw.memberPermissions = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
  const message = 'VERIFICATION_MESSAGE_ID must identify an existing verification panel sent by this bot.';
  f.deps.refreshPanel = async () => { throw new SetupError(message); };
  await f.run();
  assert.equal(f.events[0]!.event, 'command_used');
  assert.equal(f.events[0]!.outcome, 'error');
  assert.equal(f.events[0]!.detail, message);
  assert.equal(f.logs.find(([, event]) => event === 'interaction_failed')![2]!.error, message);
  assert.equal(JSON.stringify(f.replies).includes(message), false);
  assert.ok(JSON.stringify(f.replies).includes('Please try again shortly.'));
  assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
});

test('repeated commands keep cooldown audits local', async () => {
  const f = fixture('command');
  await f.run();
  await f.run();
  assert.deepEqual(f.events.map(event => event.outcome), ['success']);
  assert.ok(f.logs.some(([, event, fields]) => event === 'command_used' && fields?.outcome === 'cooldown'));
});

test('command channel restriction applies before panel updates', async () => {
  const f = fixture('command');
  f.raw.channelId = 'elsewhere';
  await f.run();
  assert.equal(f.events[0]!.outcome, 'denied_channel');
  assert.equal(f.raw.replied, true);
});

test('about sends its public V2 card and records command use', async () => {
  const f = fixture('command');
  await f.run();
  assert.equal(f.events[0]!.command, 'about');
  assert.equal(f.events[0]!.outcome, 'success');
  const payload = f.replies[0] as { flags: number; components: unknown[]; embeds?: unknown[] };
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal(payload.embeds, undefined);
  assert.equal(payload.components.length, 1);
  assert.match(messageText(payload), /loon.host/);
});
