import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureVerificationPanel, type PanelMessage, type PanelRepository } from '../src/panel.js';

const existing: PanelMessage = { id: 'panel', authorId: 'bot', isVerificationPanel: true };

function repository(pages: PanelMessage[][]) {
  const updates: string[] = [];
  let creates = 0;
  const store: PanelRepository = {
    get: async id => id === existing.id ? existing : null,
    list: async () => pages.shift() ?? [],
    update: async id => { updates.push(id); },
    create: async () => { creates++; return 'new-panel'; },
  };
  return { store, updates, creates: () => creates };
}

test('restart reuses a bot panel even when it is older than the first history page', async () => {
  const { store, updates, creates } = repository([
    [{ id: 'new-message', authorId: 'someone', isVerificationPanel: false }], [existing],
  ]);
  assert.deepEqual(await ensureVerificationPanel(store, 'bot'), { id: 'panel', created: false });
  assert.deepEqual(updates, ['panel']);
  assert.equal(creates(), 0);
});

test('first start creates one panel and ignores panels authored by other accounts', async () => {
  const { store, creates } = repository([[{ ...existing, authorId: 'imposter' }], []]);
  assert.deepEqual(await ensureVerificationPanel(store, 'bot'), { id: 'new-panel', created: true });
  assert.equal(creates(), 1);
});

test('explicit panel ID updates only an owned verification message', async () => {
  const { store, creates } = repository([]);
  assert.equal((await ensureVerificationPanel(store, 'bot', 'panel')).created, false);
  await assert.rejects(ensureVerificationPanel(store, 'another-bot', 'panel'));
  await assert.rejects(ensureVerificationPanel(store, 'bot', 'missing'));
  assert.equal(creates(), 0);
});

test('history fetch or edit failure does not create a duplicate panel', async () => {
  const { store, creates } = repository([[existing]]);
  store.update = async () => { throw new Error('Missing access'); };
  await assert.rejects(ensureVerificationPanel(store, 'bot'), /Missing access/);
  store.list = async () => { throw new Error('Network error'); };
  await assert.rejects(ensureVerificationPanel(store, 'bot'), /Network error/);
  assert.equal(creates(), 0);
});
