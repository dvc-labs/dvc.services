import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditLogEvent, MessageFlags, type Guild, type GuildAuditLogsEntry,
  type GuildMember, type VoiceState } from 'discord.js';
import { GuildActivity } from '../src/activity.js';
import { AuditLog, type AuditEvent } from '../src/audit.js';
import { Logger } from '../src/logger.js';
import { DVC_EMOJI } from '../src/version.js';
import { messageText, testConfig } from './helpers.js';

function fixture(timing?: { wait: (ms: number, signal: AbortSignal) => Promise<void> }) {
  const config = testConfig();
  const events: AuditEvent[] = [];
  const logs: Parameters<Logger['write']>[] = [];
  const messages: unknown[] = [];
  const logger = new Logger('error', '');
  logger.write = (...args) => { logs.push(args); };
  const audit = new AuditLog(logger);
  audit.setSink(async event => { events.push(event); });
  let ready = true;
  let now = 1_000;
  const activity = new GuildActivity({ config, audit, isReady: () => ready, now: () => now,
    wait: timing?.wait ?? (async ms => { now += ms; }) });
  const member = {
    id: '777777777777777777', guild: { id: config.guildId, memberCount: 50 },
    user: { bot: false, createdTimestamp: 1_500_000_000_000 }, joinedTimestamp: 1_600_000_000_000,
    async send(payload: unknown) { messages.push(payload); },
  };
  return { config, member, activity, audit, events, logs, messages, now: () => now,
    setReady: (value: boolean) => { ready = value; },
    flush: async () => { await activity.flush(); await audit.flush(); } };
}

test('new members receive one kind welcome with verification and GitHub links, plus an emoji join log', async () => {
  const f = fixture();
  f.activity.joined(f.member as unknown as GuildMember);
  await f.flush();
  assert.equal(f.events[0]!.title, `${DVC_EMOJI} Member joined`);
  assert.equal(f.events[0]!.userId, f.member.id);
  assert.equal(f.messages.length, 1);
  assert.match(messageText(f.messages[0]), /<@777777777777777777>/);
  assert.match(messageText(f.messages[0]), /<#444444444444444444>/);
  const payload = JSON.parse(JSON.stringify(f.messages[0]));
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  assert.match(JSON.stringify(payload), /https:\/\/github.com\/dvc-labs/);
  assert.match(JSON.stringify(payload), /Follow dvc.labs on GitHub/);
  assert.deepEqual(f.events.map(event => event.outcome), ['joined']);
  assert.ok(f.logs.some(([, event, fields]) => event === 'welcome_dm' && fields?.outcome === 'sent'));
});

test('duplicate join events do not resend DMs, while a real leave and rejoin can receive a new welcome', async () => {
  const f = fixture();
  f.activity.joined(f.member as unknown as GuildMember);
  f.activity.joined(f.member as unknown as GuildMember);
  await f.flush();
  f.activity.joined(f.member as unknown as GuildMember);
  await f.flush();
  assert.equal(f.messages.length, 1);
  f.activity.left(f.member as unknown as GuildMember);
  f.member.joinedTimestamp++;
  f.activity.joined(f.member as unknown as GuildMember);
  await f.flush();
  assert.equal(f.messages.length, 2);
  assert.equal(f.events.filter(event => event.event === 'member_left').length, 1);
});

test('bots are logged without DMs and other guilds or startup events cannot trigger welcomes', async () => {
  for (const change of ['bot', 'guild', 'not_ready']) {
    const f = fixture();
    if (change === 'bot') f.member.user.bot = true;
    if (change === 'guild') f.member.guild.id = '999999999999999999';
    if (change === 'not_ready') f.setReady(false);
    f.activity.joined(f.member as unknown as GuildMember);
    await f.flush();
    assert.equal(f.messages.length, 0);
    assert.equal(f.events.length, change === 'bot' ? 1 : 0);
  }
});

test('blocked DMs are safely logged and do not interrupt the next member welcome', async () => {
  const f = fixture();
  const blocked = { ...f.member, send: async () => { throw Object.assign(new Error('private body/token'), { code: 50007 }); } };
  f.activity.joined(blocked as unknown as GuildMember);
  f.activity.joined({ ...f.member, id: '888888888888888888' } as unknown as GuildMember);
  await f.flush();
  assert.equal(f.messages.length, 1);
  assert.ok(f.logs.some(([, event, fields]) => event === 'welcome_dm'
    && fields?.outcome === 'not_delivered' && fields.detail === 'Error code=50007'));
  assert.equal(JSON.stringify(f.events).includes('private body/token'), false);
  assert.equal(JSON.stringify(f.logs).includes('private body/token'), false);
});

test('welcome queue is bounded during slow delivery and shutdown drops pending jobs', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sends = 0;
  const member = { ...f.member, send: async () => { sends++; await gate; } };
  for (let i = 0; i < 100; i++) {
    f.activity.joined({ ...member, id: (777777777777777777n + BigInt(i)).toString() } as unknown as GuildMember);
  }
  assert.equal(sends, 1);
  assert.equal(f.logs.filter(([, name, fields]) => name === 'welcome_dm' && fields?.outcome === 'queue_full').length, 49);
  f.activity.stop();
  release();
  await f.flush();
  assert.equal(sends, 1);
  f.activity.joined({ ...member, id: '999999999999999999' } as unknown as GuildMember);
  assert.equal(sends, 1);
});

test('a join arriving as the previous DM settles still gets drained', async () => {
  const f = fixture();
  f.activity.joined(f.member as unknown as GuildMember);
  await Promise.resolve();
  f.activity.joined({ ...f.member, id: '888888888888888888' } as unknown as GuildMember);
  await f.flush();
  assert.equal(f.messages.length, 2);
});

test('uncached member updates log current state without pretending the old values are known', async () => {
  const f = fixture();
  const before = { ...f.member, partial: false, nickname: null, pending: true,
    premiumSinceTimestamp: null, communicationDisabledUntilTimestamp: null };
  const after = { ...before, nickname: '@everyone **Dave**', pending: false,
    premiumSinceTimestamp: 1_600_000_000_000, communicationDisabledUntilTimestamp: 1_700_000_000_000,
    isCommunicationDisabled: () => true };
  f.activity.updated(before as unknown as GuildMember, after as unknown as GuildMember);
  f.activity.updated({ ...before, partial: true } as unknown as GuildMember, after as unknown as GuildMember);
  await f.flush();
  assert.equal(f.events.length, 2);
  assert.equal(f.events[0]!.fields!.length, 4);
  assert.equal(f.events[1]!.outcome, 'snapshot');
  assert.match(f.events[1]!.detail!, /Previous state was not cached/);
  assert.equal(f.events[1]!.fields!.length, 4);
  assert.equal(JSON.stringify(f.events).includes('@everyone **Dave**'), false);
});

test('welcome delivery attempts start at least 1.5 seconds apart', async () => {
  const f = fixture();
  const attempts: number[] = [];
  for (let i = 0; i < 3; i++) f.activity.joined({ ...f.member,
    id: (777777777777777777n + BigInt(i)).toString(), send: async () => { attempts.push(f.now()); },
  } as unknown as GuildMember);
  await f.flush();
  assert.deepEqual(attempts, [1_000, 2_500, 4_000]);
});

test('shutdown cancels a pending DM pacing timer promptly', async () => {
  let waiting = false;
  const f = fixture({ wait: async (_ms, signal) => {
    waiting = true;
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true });
    });
  } });
  f.activity.joined(f.member as unknown as GuildMember);
  f.activity.joined({ ...f.member, id: '888888888888888888' } as unknown as GuildMember);
  await Promise.resolve();
  assert.equal(waiting, true);
  f.activity.stop();
  await f.flush();
  assert.equal(f.messages.length, 1);
});

test('a 60-member join burst and DM results cannot displace a later verification error', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.audit.setSink(async event => { await blocked; f.events.push(event); });
  for (let i = 0; i < 60; i++) f.activity.joined({ ...f.member,
    id: (777777777777777777n + BigInt(i)).toString(),
  } as unknown as GuildMember);
  await f.activity.flush();
  f.audit.record({ event: 'verification_failed', title: 'Verification failed', outcome: 'error', priority: 'critical' });
  release();
  await f.audit.flush();
  assert.equal(f.events.filter(event => event.event === 'member_joined').length, 60);
  assert.equal(f.events.some(event => event.event === 'welcome_dm'), false);
  assert.equal(f.events[1]!.event, 'verification_failed');
});

test('Discord audit events retain the actual actor and resolve member, role, and channel targets without guessed attribution', async () => {
  const f = fixture();
  const base = { id: '100000000000000001', action: AuditLogEvent.MemberRoleUpdate, executorId: '888888888888888888',
    targetId: f.member.id, targetType: 'User', target: null, reason: 'Member roles updated',
    changes: [{ key: '$add', new: [{ id: f.config.verificationRoleId, name: 'Member' }] }] };
  for (const [index, targetType] of ['User', 'Role', 'Channel'].entries()) {
    f.activity.auditEntry({ ...base, id: String(100000000000000001n + BigInt(index)), targetType } as unknown as GuildAuditLogsEntry,
      f.member.guild as unknown as Guild);
  }
  f.activity.auditEntry(base as unknown as GuildAuditLogsEntry, f.member.guild as unknown as Guild);
  await f.flush();
  assert.equal(f.events.length, 3); // Duplicate audit entry ID ignored.
  assert.equal(f.events[0]!.actorId, '888888888888888888');
  assert.equal(f.events[0]!.userId, f.member.id);
  assert.equal(f.events[1]!.roleId, f.member.id);
  assert.equal(f.events[2]!.channelId, f.member.id);
  assert.match(f.events[0]!.fields!.find(field => field.name === 'Roles added')!.value, /<@&333333333333333333>/);
});

test('our own verification award audit stays in the console without hiding another actor’s changes', async () => {
  const f = fixture();
  const entry = { id: '100000000000000001', action: AuditLogEvent.MemberRoleUpdate, executorId: f.config.applicationId,
    targetId: f.member.id, targetType: 'User', target: null, reason: 'dvc.services: member completed button verification', changes: [] };
  f.activity.auditEntry(entry as unknown as GuildAuditLogsEntry, f.member.guild as unknown as Guild);
  f.activity.auditEntry({ ...entry, id: '100000000000000002', executorId: '888888888888888888' } as unknown as GuildAuditLogsEntry,
    f.member.guild as unknown as Guild);
  await f.flush();
  assert.equal(f.logs.filter(([, name]) => name === 'server_audit_entry').length, 2);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0]!.actorId, '888888888888888888');
});

test('message and thread audit entries resolve their actual author and channel IDs', async () => {
  const f = fixture();
  const base = { id: '100000000000000001', action: AuditLogEvent.MessageDelete, executorId: '888888888888888888',
    targetId: f.member.id, targetType: 'Message', target: null, reason: null, changes: [],
    extra: { channel: { id: '999999999999999999' }, count: 1 } };
  f.activity.auditEntry(base as unknown as GuildAuditLogsEntry, f.member.guild as unknown as Guild);
  f.activity.auditEntry({ ...base, id: '100000000000000002', action: AuditLogEvent.MessageBulkDelete } as unknown as GuildAuditLogsEntry,
    f.member.guild as unknown as Guild);
  f.activity.auditEntry({ ...base, id: '100000000000000003', targetType: 'Thread', action: AuditLogEvent.ThreadUpdate } as unknown as GuildAuditLogsEntry,
    f.member.guild as unknown as Guild);
  await f.flush();
  assert.equal(f.events[0]!.userId, f.member.id);
  assert.equal(f.events[0]!.channelId, '999999999999999999');
  assert.equal(f.events[1]!.userId, undefined);
  assert.equal(f.events[1]!.channelId, f.member.id);
  assert.equal(f.events[2]!.channelId, f.member.id);
});

test('voice channel changes log native references and ignore microphone-only updates', async () => {
  const f = fixture();
  const before = { id: f.member.id, guild: f.member.guild, channelId: '100000000000000001' };
  const after = { ...before, channelId: '100000000000000002' };
  f.activity.voiceChanged(before as unknown as VoiceState, after as unknown as VoiceState);
  f.activity.voiceChanged(after as unknown as VoiceState, after as unknown as VoiceState);
  await f.flush();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0]!.channelId, after.channelId);
  assert.equal(f.events[0]!.fields![0]!.value, '<#100000000000000001>');
});
