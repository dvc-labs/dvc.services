import assert from 'node:assert/strict';
import { mock } from 'node:test';
import test from 'node:test';
import { MessageFlags, type TextChannel } from 'discord.js';
import { AuditLog, discordAuditSink, type AuditEvent } from '../src/audit.js';
import { Logger } from '../src/logger.js';
import { messageText } from './helpers.js';

const event: AuditEvent = { event: 'verification_succeeded', title: 'Member verified', outcome: 'awarded', critical: true };

test('Discord verification logs resolve member, channel, and role references without enabling pings', async () => {
  const sent: { flags: number; components: unknown[]; allowedMentions: { parse: string[]; repliedUser: boolean } }[] = [];
  const channel = { send: async (payload: typeof sent[number]) => { sent.push(payload); } } as unknown as TextChannel;
  await discordAuditSink(channel)({
    ...event, userId: '111111111111111111', channelId: '222222222222222222', roleId: '333333333333333333',
  });
  assert.equal(sent.length, 1);
  const text = messageText(sent[0]);
  assert.match(text, /\*\*Result\*\*\nAwarded/);
  assert.match(text, /\*\*Member\*\*\n<@111111111111111111>/);
  assert.match(text, /\*\*Channel\*\*\n<#222222222222222222>/);
  assert.match(text, /\*\*Role\*\*\n<@&333333333333333333>/);
  assert.equal(sent[0]!.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(sent[0]!.allowedMentions, { parse: [], repliedUser: false });
});

test('Discord lifecycle logs omit references that are not part of the event', async () => {
  const sent: unknown[] = [];
  const channel = { send: async (payload: typeof sent[number]) => { sent.push(payload); } } as unknown as TextChannel;
  await discordAuditSink(channel)({ event: 'bot_online', title: 'Bot online', outcome: 'ready' });
  const text = messageText(sent[0]);
  assert.match(text, /\*\*Result\*\*\nReady/);
  assert.equal(text.includes('**Member**'), false);
  assert.equal(text.includes('**Channel**'), false);
  assert.equal(text.includes('**Role**'), false);
});

test('console audit records keep exact IDs for diagnostics', () => {
  const output = mock.method(console, 'log', () => {});
  try {
    new AuditLog(new Logger('info', '')).record({
      ...event, userId: '111111111111111111', channelId: '222222222222222222', roleId: '333333333333333333',
    });
    const record = JSON.parse(output.mock.calls[0]!.arguments[0] as string);
    assert.equal(record.userId, '111111111111111111');
    assert.equal(record.channelId, '222222222222222222');
    assert.equal(record.roleId, '333333333333333333');
  } finally { output.mock.restore(); }
});

test('Discord log failures are isolated and later events still drain', async () => {
  const audit = new AuditLog(new Logger('error', ''));
  const delivered: string[] = [];
  audit.setSink(async value => {
    if (value.outcome === 'failed') throw new Error('Discord unavailable');
    delivered.push(value.outcome);
  });
  audit.record({ ...event, outcome: 'failed' });
  audit.record(event);
  await audit.flush();
  audit.record({ ...event, outcome: 'next' });
  await audit.flush();
  assert.deepEqual(delivered, ['awarded', 'next']);
});

test('Discord log queue is bounded during an outage or rate limit', async () => {
  const audit = new AuditLog(new Logger('error', ''));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sent = 0;
  audit.setSink(async () => { sent++; await gate; });
  for (let i = 0; i < 250; i++) audit.record(event);
  release();
  await audit.flush();
  assert.equal(sent, 101); // One in flight plus 100 waiting.
});

test('routine bursts cannot consume reserved verification capacity and critical records are delivered first', async () => {
  const logger = new Logger('error', '');
  logger.write = () => {};
  const audit = new AuditLog(logger);
  const delivered: AuditEvent[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  audit.setSink(async value => { await blocked; delivered.push(value); });
  for (let i = 0; i < 200; i++) audit.record({ event: 'member_joined', title: 'Member joined', outcome: 'joined' });
  const failure = { event: 'verification_failed', title: 'Verification failed', outcome: 'error', critical: true };
  audit.record(failure);
  release();
  await audit.flush();
  assert.equal(delivered.length, 82); // One in flight, 80 routine records, one critical record.
  assert.deepEqual(delivered[1], failure);
});

test('a full mixed queue evicts a routine record to retain a later critical error', async () => {
  const logger = new Logger('error', '');
  logger.write = () => {};
  const audit = new AuditLog(logger);
  const delivered: AuditEvent[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  audit.setSink(async value => { await blocked; delivered.push(value); });
  for (let i = 0; i < 81; i++) audit.record({ event: 'member_joined', title: 'Member joined', outcome: 'joined' });
  for (let i = 0; i < 20; i++) audit.record(event);
  audit.record({ ...event, event: 'verification_failed', outcome: 'error' });
  release();
  await audit.flush();
  assert.equal(delivered.length, 101);
  assert.equal(delivered.filter(value => value.critical).length, 21);
  assert.ok(delivered.some(value => value.event === 'verification_failed'));
});

test('explicit console-only events cannot displace Discord audit events during a backlog', async () => {
  const logger = new Logger('info', '');
  const records: Parameters<Logger['write']>[] = [];
  logger.write = (...args) => { records.push(args); };
  const audit = new AuditLog(logger);
  const delivered: AuditEvent[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  audit.setSink(async value => { await blocked; delivered.push(value); });
  audit.record(event);
  for (let i = 0; i < 150; i++) {
    audit.record({ ...event, event: 'verification_attempt', outcome: 'cooldown', discord: false });
    audit.record({ ...event, event: 'verification_attempt', outcome: 'processing', discord: false });
    audit.record({ ...event, event: 'command_used', outcome: 'cooldown', discord: false });
  }
  audit.record({ ...event, userId: 'another-member' });
  release();
  await audit.flush();
  assert.deepEqual(delivered, [event, { ...event, userId: 'another-member' }]);
  assert.equal(records.length, 452);
  assert.equal(records.some(([, name]) => name === 'audit_queue_full'), false);
});

test('Discord delivery is explicit and independent of event names or outcome words', async () => {
  const audit = new AuditLog(new Logger('error', ''));
  const delivered: AuditEvent[] = [];
  audit.setSink(async value => { delivered.push(value); });
  const expected: AuditEvent[] = [];
  for (const outcome of ['cooldown', 'processing', 'awarded']) {
    const futureEvent = { ...event, event: 'another_feature', outcome };
    audit.record(futureEvent);
    audit.record({ ...futureEvent, discord: true });
    audit.record({ ...futureEvent, discord: false });
    expected.push(futureEvent, { ...futureEvent, discord: true });
  }
  await audit.flush();
  assert.deepEqual(delivered, expected);
});

test('structured console logs redact the configured bot token', () => {
  const output = mock.method(console, 'log', () => {});
  try {
    new Logger('info', 'test-secret').write('info', 'example', { detail: 'contains test-secret' });
    const line = output.mock.calls[0]!.arguments[0] as string;
    assert.ok(!line.includes('test-secret'));
    assert.ok(line.includes('[REDACTED]'));
  } finally { output.mock.restore(); }
});
