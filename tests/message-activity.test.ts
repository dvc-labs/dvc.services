import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags, type Message, type PartialMessage, type TextChannel } from 'discord.js';
import { AuditLog, discordAuditSink } from '../src/audit.js';
import { Logger } from '../src/logger.js';
import { MessageActivity } from '../src/message-activity.js';
import { messageText, testConfig } from './helpers.js';

const AUTHOR = '777777777777777770';
const CHANNEL = '777777777777777771';
const MESSAGE = '777777777777777772';
const EDITED = 1_792_500_000_000;

function fixture(messageLogContent = true) {
  const config = { ...testConfig(), messageLogContent };
  const logs: Parameters<Logger['write']>[] = [];
  const logger = new Logger('info', '');
  logger.write = (...args) => { logs.push(args); };
  const cards: unknown[] = [];
  const audit = new AuditLog(logger);
  let privateLogs = true, ready = true;
  audit.setSink(discordAuditSink({ send: async (payload: unknown) => { cards.push(payload); } } as unknown as TextChannel,
    () => privateLogs ? undefined : 'Hidden because the logs channel is visible to <@&' + config.verificationRoleId + '>'));
  const activity = new MessageActivity({ config, audit, isReady: () => ready });
  const original = { id: MESSAGE, channelId: CHANNEL, guildId: config.guildId as string | null, channel: null as unknown,
    author: { id: AUTHOR, bot: false }, system: false, webhookId: null as string | null, content: 'The original lore.',
    editedTimestamp: null as number | null };
  function message(overrides: Partial<typeof original> = {}): Message {
    return { ...original, ...overrides } as unknown as Message;
  }
  const partial = (id = MESSAGE) => ({ ...original, id, author: null, content: null }) as unknown as PartialMessage;
  return { config, activity, logs, cards, message, partial, flush: () => audit.flush(),
    exposeLogs: () => { privateLogs = false; }, disable: () => { ready = false; } };
}

test('staff edit and delete cards use the last observed text without repeating edits or copying chat into console logs', async () => {
  const f = fixture();
  f.activity.created(f.message());
  const edited = f.message({ content: 'Updated lore for @everyone: https://example.invalid/story', editedTimestamp: EDITED });
  f.activity.updated(f.partial(), edited);
  f.activity.updated(f.partial(), edited); // A later preview update can carry the same edit timestamp.
  f.activity.deleted(f.partial());
  await f.flush();
  assert.equal(f.cards.length, 2);
  assert.match(messageText(f.cards[0]), /Message edited[\s\S]+<#777777777777777771>[\s\S]+<@777777777777777770>/);
  assert.match(messageText(f.cards[0]), /Before\*\*\nThe original lore\.[\s\S]+After\*\*\nUpdated lore/);
  assert.match(messageText(f.cards[0]), /https:\/\/discord\.com\/channels\//);
  assert.match(messageText(f.cards[1]), /Message deleted[\s\S]+Deleted text\*\*\nUpdated lore/);
  for (const card of f.cards) {
    const safe = JSON.parse(JSON.stringify(card));
    assert.equal(safe.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(safe.allowedMentions, { parse: [], repliedUser: false });
    assert.doesNotMatch(messageText(card), /@everyone|https:\/\/example\.invalid/);
  }
  assert.doesNotMatch(JSON.stringify(f.logs), /original lore|Updated lore|example\.invalid/);
});

test('uncached edits and deletes record available data and label the missing text and author', async () => {
  const f = fixture();
  f.activity.updated(f.partial(), f.message({ content: 'Only the new version is available.', editedTimestamp: EDITED }));
  f.activity.deleted(f.partial('777777777777777773'));
  await f.flush();
  assert.equal(f.cards.length, 2);
  assert.match(messageText(f.cards[0]), /Previous text unavailable[\s\S]+Only the new version/);
  assert.match(messageText(f.cards[1]), /Message author\*\*\nUnavailable[\s\S]+Text unavailable/);
  assert.doesNotMatch(messageText(f.cards[1]), /Performed by/);
});

test('chat logging skips unrelated updates, known bots, webhooks, DMs, system messages and logs-channel threads', async () => {
  const f = fixture();
  f.activity.updated(f.partial(), f.message()); // No edit timestamp.
  const cases: Parameters<typeof f.message>[0][] = [
    { author: { id: AUTHOR, bot: true } }, { webhookId: '999999999999999999' }, { system: true },
    { guildId: '998888888888888888' }, { guildId: null }, { channelId: f.config.logsChannelId },
    { channel: { isThread: () => true, parentId: f.config.logsChannelId } },
  ];
  for (const [index, overrides] of cases.entries()) {
    const id = String(BigInt(MESSAGE) + BigInt(index));
    const before = f.message({ ...overrides, id });
    f.activity.created(before);
    f.activity.updated(before, f.message({ ...overrides, id, editedTimestamp: EDITED }));
    f.activity.deleted(before);
  }
  f.disable();
  f.activity.deleted(f.partial());
  await f.flush();
  assert.deepEqual(f.cards, []);
});

test('copies are omitted in metadata mode and withheld if regular members can see the logs channel', async () => {
  for (const copy of [false, true]) {
    const f = fixture(copy);
    f.activity.created(f.message());
    if (copy) f.exposeLogs(); // Permissions can change after a message was observed.
    f.activity.deleted(f.partial());
    await f.flush();
    assert.equal(f.cards.length, 1);
    assert.match(messageText(f.cards[0]), /Message deleted/);
    assert.doesNotMatch(messageText(f.cards[0]), /The original lore/);
    assert.equal(messageText(f.cards[0]).includes('Hidden because the logs channel is visible to <@&'
      + f.config.verificationRoleId + '>'), copy);
    assert.deepEqual(JSON.parse(JSON.stringify(f.cards[0])).allowedMentions, { parse: [], repliedUser: false });
  }
});

test('long message copies fit on an edit card and bulk deletions use one summary with bounded excerpts', async () => {
  const f = fixture();
  const long = '*'.repeat(498) + '😀final text beyond the limit';
  f.activity.created(f.message({ content: long }));
  f.activity.updated(f.partial(), f.message({ content: long + ' edited', editedTimestamp: EDITED }));
  const ids = [MESSAGE, '777777777777777773', '777777777777777774'];
  for (const id of ids.slice(1)) f.activity.created(f.message({ id, content: 'Lore for ' + id }));
  f.activity.bulkDeleted(ids.map(id => f.partial(id)), CHANNEL);
  await f.flush();
  const edited = messageText(f.cards[0]);
  assert.equal(edited.match(/Text shortened/g)?.length, 2);
  assert.equal(edited.match(/😀/gu)?.length, 2);
  assert.doesNotMatch(edited, /Further details|beyond the limit/);
  assert.equal(f.cards.length, 2);
  const bulk = messageText(f.cards[1]);
  assert.match(bulk, /Messages deleted in bulk[\s\S]+Showing 2 of 3 messages/);
  assert.ok(bulk.includes('Lore for ' + ids[1]));
  assert.ok(!bulk.includes(ids[2]!));
});
