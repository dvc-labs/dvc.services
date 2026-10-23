import assert from 'node:assert/strict';
import { mock } from 'node:test';
import test from 'node:test';
import { AuditLog, type AuditEvent } from '../src/audit.js';
import { Logger } from '../src/logger.js';

const event: AuditEvent = { event: 'verification_succeeded', title: 'Member verified', outcome: 'awarded' };

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

test('structured console logs redact the configured bot token', () => {
  const output = mock.method(console, 'log', () => {});
  try {
    new Logger('info', 'test-secret').write('info', 'example', { detail: 'contains test-secret' });
    const line = output.mock.calls[0]!.arguments[0] as string;
    assert.ok(!line.includes('test-secret'));
    assert.ok(line.includes('[REDACTED]'));
  } finally { output.mock.restore(); }
});
