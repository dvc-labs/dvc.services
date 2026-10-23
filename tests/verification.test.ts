import assert from 'node:assert/strict';
import test from 'node:test';
import { VerificationService, type VerificationGateway } from '../src/verification.js';

function fixture(member = { hasRole: false, pending: false, bot: false }) {
  const awarded: string[] = [];
  const gateway: VerificationGateway = {
    getMember: async () => member,
    assertRoleAssignable: async () => {},
    addRole: async id => { awarded.push(id); },
  };
  return { gateway, awarded, service: new VerificationService(gateway) };
}

test('successful verification awards only the clicking member', async () => {
  const { service, awarded } = fixture();
  assert.equal(await service.verify('clicking-user'), 'awarded');
  assert.deepEqual(awarded, ['clicking-user']);
});

test('already verified, screening-pending, and bot members never get a role write', async () => {
  for (const [member, result] of [
    [{ hasRole: true, pending: false, bot: false }, 'already_verified'],
    [{ hasRole: false, pending: true, bot: false }, 'screening_pending'],
    [{ hasRole: false, pending: false, bot: true }, 'bot'],
  ] as const) {
    const { service, awarded } = fixture(member);
    assert.equal(await service.verify('member'), result);
    assert.deepEqual(awarded, []);
  }
});

test('concurrent clicks by the same member perform one role write', async () => {
  const { gateway, awarded, service } = fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  gateway.getMember = async () => {
    await pending;
    return { hasRole: false, pending: false, bot: false };
  };
  const first = service.verify('member');
  assert.equal(await service.verify('member'), 'processing');
  release();
  assert.equal(await first, 'awarded');
  assert.deepEqual(awarded, ['member']);
  assert.equal(await service.verify('member'), 'cooldown');
});

test('unassignable role prevents every award', async () => {
  const { gateway, awarded, service } = fixture();
  gateway.assertRoleAssignable = async () => { throw new Error('role moved above bot'); };
  await assert.rejects(service.verify('member'), /role moved/);
  assert.deepEqual(awarded, []);
});

test('failed Discord role write never reports awarded', async () => {
  const { gateway, service } = fixture();
  gateway.addRole = async () => { throw new Error('Discord unavailable'); };
  await assert.rejects(service.verify('member'), /Discord unavailable/);
  assert.equal(await service.verify('member'), 'cooldown');
});
