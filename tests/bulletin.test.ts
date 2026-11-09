import assert from 'node:assert/strict';
import test from 'node:test';
import { BulletinService, type BulletinGateway } from '../src/bulletin.js';

function fixture(member = { verified: true, subscribed: false, bot: false }) {
  const writes: [string, boolean][] = [];
  const gateway: BulletinGateway = {
    getMember: async () => member,
    assertRoleAssignable: async () => {},
    setRole: async (id, subscribed) => { writes.push([id, subscribed]); },
  };
  return { gateway, writes, service: new BulletinService(gateway) };
}

test('verified members can subscribe and unsubscribe, changing only their own role', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.set('clicking-user', true), { outcome: 'subscribed', status: 'on' });
  assert.deepEqual(f.writes, [['clicking-user', true]]);
  const g = fixture({ verified: true, subscribed: true, bot: false });
  assert.deepEqual(await g.service.set('clicking-user', false), { outcome: 'unsubscribed', status: 'off' });
  assert.deepEqual(g.writes, [['clicking-user', false]]);
});

test('unchanged, unverified, and bot requests never produce a role write', async () => {
  for (const [member, subscribe, result] of [
    [{ verified: true, subscribed: true, bot: false }, true, 'already_subscribed'],
    [{ verified: true, subscribed: false, bot: false }, false, 'already_unsubscribed'],
    [{ verified: false, subscribed: false, bot: false }, true, 'not_verified'],
    [{ verified: true, subscribed: false, bot: true }, true, 'bot'],
  ] as const) {
    const f = fixture(member);
    assert.equal((await f.service.set('member', subscribe)).outcome, result);
    assert.deepEqual(f.writes, []);
  }
});

test('members who lost the verification role can still opt out', async () => {
  const f = fixture({ verified: false, subscribed: true, bot: false });
  assert.equal(await f.service.status('member'), 'on');
  assert.deepEqual(await f.service.set('member', false), { outcome: 'unsubscribed', status: 'not_verified' });
});

test('concurrent presses perform one write, then the cooldown applies until it expires', async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.gateway.getMember = async () => { await pending; return { verified: true, subscribed: false, bot: false }; };
  const first = f.service.set('member', true);
  assert.equal((await f.service.set('member', true)).outcome, 'processing');
  release();
  assert.equal((await first).outcome, 'subscribed');
  assert.deepEqual(f.writes, [['member', true]]);
  assert.equal((await f.service.set('member', false)).outcome, 'cooldown');
  assert.equal((await f.service.set('someone-else', true)).outcome, 'subscribed');
});

test('an unassignable role prevents every write, and a failed write is never reported as success', async () => {
  const f = fixture();
  f.gateway.assertRoleAssignable = async () => { throw new Error('role moved above bot'); };
  await assert.rejects(f.service.set('member', true), /role moved/);
  assert.deepEqual(f.writes, []);
  const g = fixture();
  g.gateway.setRole = async () => { throw new Error('Discord unavailable'); };
  await assert.rejects(g.service.set('member', true), /Discord unavailable/);
});
