import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureVerificationPanels, type PanelKind, type PanelMessage, type PanelRepository } from '../src/panel.js';

const existing: PanelMessage = { id: 'panel', authorId: 'bot', kind: 'verification' };
const bulletin: PanelMessage = { id: 'bulletin-panel', authorId: 'bot', kind: 'bulletin' };

function repository(pages: PanelMessage[][]) {
  const updates: string[] = [];
  const created: PanelKind[] = [];
  const store: PanelRepository = {
    get: async id => id === existing.id ? existing : null,
    list: async () => pages.shift() ?? [],
    update: async id => { updates.push(id); },
    create: async kind => { created.push(kind); return kind === 'verification' ? 'new-panel' : 'new-bulletin'; },
  };
  return { store, updates, created, creates: () => created.length };
}

test('restart reuses a bot panel even when it is older than the first history page', async () => {
  const { store, updates, creates } = repository([
    [{ id: 'new-message', authorId: 'someone', kind: undefined }], [existing],
  ]);
  assert.deepEqual(await ensureVerificationPanels(store, 'bot', false), { verification: { id: 'panel', created: false } });
  assert.deepEqual(updates, ['panel']);
  assert.equal(creates(), 0);
});

test('first start creates one panel and ignores panels authored by other accounts', async () => {
  const { store, creates } = repository([[{ ...existing, authorId: 'imposter' }], []]);
  assert.deepEqual(await ensureVerificationPanels(store, 'bot', false), { verification: { id: 'new-panel', created: true } });
  assert.equal(creates(), 1);
});

test('explicit panel ID updates only an owned verification message', async () => {
  const { store, creates } = repository([]);
  assert.equal((await ensureVerificationPanels(store, 'bot', false, 'panel')).verification.created, false);
  await assert.rejects(ensureVerificationPanels(store, 'another-bot', false, 'panel'));
  await assert.rejects(ensureVerificationPanels(store, 'bot', false, 'missing'));
  assert.equal(creates(), 0);
});

test('history fetch or edit failure does not create a duplicate panel', async () => {
  const { store, creates } = repository([[existing]]);
  store.update = async () => { throw new Error('Missing access'); };
  await assert.rejects(ensureVerificationPanels(store, 'bot', true), /Missing access/);
  store.list = async () => { throw new Error('Network error'); };
  await assert.rejects(ensureVerificationPanels(store, 'bot', true), /Network error/);
  assert.equal(creates(), 0);
});

test('startup finds the verification and Bulletin cards across pages and reuses both', async () => {
  const { store, updates, creates } = repository([[{ ...bulletin, id: 'unowned-message', authorId: 'someone else' }], [bulletin], [existing]]);
  assert.deepEqual(await ensureVerificationPanels(store, 'bot', true), {
    verification: { id: 'panel', created: false }, bulletin: { id: 'bulletin-panel', created: false },
  });
  assert.deepEqual(updates, ['panel', 'bulletin-panel']);
  assert.equal(creates(), 0);
});

test('upgrading a pinned verification message creates only the missing Bulletin card', async () => {
  const { store, updates, created } = repository([[existing], []]);
  assert.deepEqual(await ensureVerificationPanels(store, 'bot', true, 'panel'), {
    verification: { id: 'panel', created: false }, bulletin: { id: 'new-bulletin', created: true },
  });
  assert.deepEqual(updates, ['panel']);
  assert.deepEqual(created, ['bulletin']);
});
