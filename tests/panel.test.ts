import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureVerificationPanel, type PanelMessage, type PanelRepository } from '../src/panel.js';

const existing: PanelMessage = { id: 'panel', authorId: 'bot', kind: 'verification' };
const bulletin: PanelMessage = { id: 'bulletin-panel', authorId: 'bot', kind: 'bulletin' };

function repository(pages: PanelMessage[][]) {
  const updates: string[] = [];
  let creates = 0;
  const retired: string[] = [];
  const store: PanelRepository = {
    get: async id => id === existing.id ? existing : null,
    list: async () => pages.shift() ?? [],
    update: async id => { updates.push(id); },
    create: async () => { creates++; return 'new-panel'; },
    retireBulletin: async id => { retired.push(id); },
  };
  return { store, updates, retired, creates: () => creates };
}

test('restart reuses a bot panel even when it is older than the first history page', async () => {
  const { store, updates, creates } = repository([
    [{ id: 'new-message', authorId: 'someone', kind: undefined }], [existing],
  ]);
  assert.deepEqual(await ensureVerificationPanel(store, 'bot', undefined, false), { id: 'panel', created: false, retiredBulletinCards: 0 });
  assert.deepEqual(updates, ['panel']);
  assert.equal(creates(), 0);
});

test('first start creates one panel and ignores panels authored by other accounts', async () => {
  const { store, creates } = repository([[{ ...existing, authorId: 'imposter' }], []]);
  assert.deepEqual(await ensureVerificationPanel(store, 'bot'), { id: 'new-panel', created: true, retiredBulletinCards: 0 });
  assert.equal(creates(), 1);
});

test('explicit panel ID updates only an owned verification message', async () => {
  const { store, creates } = repository([]);
  store.list = async () => assert.fail('An explicit panel needs no history walk after migration');
  assert.equal((await ensureVerificationPanel(store, 'bot', 'panel', false)).created, false);
  await assert.rejects(ensureVerificationPanel(store, 'another-bot', 'panel', false));
  await assert.rejects(ensureVerificationPanel(store, 'bot', 'missing', false));
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

test('the upgrade reuses the selected verification card and removes only bot-owned Bulletin cards across pages', async () => {
  const { store, updates, retired, creates } = repository([[existing],
    [{ ...bulletin, id: 'unowned-message', authorId: 'another-bot' }], [bulletin]]);
  assert.deepEqual(await ensureVerificationPanel(store, 'bot', 'panel'), {
    id: 'panel', created: false, retiredBulletinCards: 1,
  });
  assert.deepEqual(updates, ['panel']);
  assert.deepEqual(retired, [bulletin.id]);
  assert.equal(creates(), 0);
});
