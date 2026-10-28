import assert from 'node:assert/strict';
import { mock } from 'node:test';
import test from 'node:test';
import type { EmbedBuilder, TextChannel } from 'discord.js';
import { AuditLog, discordAuditSink, type AuditEvent } from '../src/audit.js';
import { Logger } from '../src/logger.js';

const event: AuditEvent = { event: 'verification_succeeded', title: 'Member verified', outcome: 'awarded' };

test('Discord verification logs resolve member, channel, and role references without enabling pings', async () => {
  const sent: { embeds: EmbedBuilder[]; allowedMentions: { parse: string[] } }[] = [];
  const channel = { send: async (payload: typeof sent[number]) => { sent.push(payload); } } as unknown as TextChannel;
  await discordAuditSink(channel)({
    ...event, userId: '111111111111111111', channelId: '222222222222222222', roleId: '333333333333333333',
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.embeds[0]!.toJSON().fields, [
    { name: 'Result', value: 'awarded' },
    { name: 'Member', value: '<@111111111111111111>' },
    { name: 'Channel', value: '<#222222222222222222>' },
    { name: 'Role', value: '<@&333333333333333333>' },
  ]);
  assert.deepEqual(sent[0]!.allowedMentions, { parse: [] });
});

test('Discord lifecycle logs omit references that are not part of the event', async () => {
  const sent: { embeds: EmbedBuilder[] }[] = [];
  const channel = { send: async (payload: typeof sent[number]) => { sent.push(payload); } } as unknown as TextChannel;
  await discordAuditSink(channel)({ event: 'bot_online', title: 'Bot online', outcome: 'ready' });
  assert.deepEqual(sent[0]!.embeds[0]!.toJSON().fields, [{ name: 'Result', value: 'ready' }]);
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

test('cooldown and processing events stay in console logs without entering the Discord queue', async () => {
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
    audit.record({ ...event, event: 'verification_attempt', outcome: 'cooldown' });
    audit.record({ ...event, event: 'verification_attempt', outcome: 'processing' });
    audit.record({ ...event, event: 'command_used', outcome: 'cooldown' });
  }
  audit.record({ ...event, userId: 'another-member' });
  release();
  await audit.flush();
  assert.deepEqual(delivered, [event, { ...event, userId: 'another-member' }]);
  assert.equal(records.length, 452);
  assert.equal(records.some(([, name]) => name === 'audit_queue_full'), false);
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
