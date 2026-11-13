import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { HallClient, type HallReply, type HallScope } from '../src/hall.js';
import { hallCards, hallForgetId } from '../src/hall-ui.js';
import { hasEnabledButton } from '../src/policy.js';
import { messageText } from './helpers.js';

const scope: HallScope = { guildId: '111111111111111111', channelId: '222222222222222222',
  userId: '333333333333333333', private: true };
const hallReply: HallReply = { reply: 'Hello from Hall.', webSearch: true, truncated: false, contextFresh: true, safety: 'checked' };

test('Hall receives authenticated requests with the correct scope, a fresh request ID, and reset before generation', async () => {
  const requests: { path: string; body: Record<string, string> }[] = [];
  const client = new HallClient('https://hall.example', 'worker-secret', async (url, init) => {
    assert.equal(new URL(String(url)).origin, 'https://hall.example');
    assert.equal(init?.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer worker-secret');
    const path = new URL(String(url)).pathname;
    requests.push({ path, body: JSON.parse(String(init.body)) });
    return path === '/api/reset' ? Response.json({ ok: true }) : Response.json({
      reply: 'Hello from Hall.', memory: 'session', context_fresh: true, web_search: true, safety: 'checked',
    });
  });
  assert.deepEqual(await client.ask(scope, 'What is dvc.labs?', true), hallReply);
  assert.deepEqual(requests.map(r => r.path), ['/api/reset', '/api/chat']);
  const identity = { source: 'discord', guild_id: scope.guildId, channel_id: scope.channelId,
    user_id: scope.userId, visibility: 'private' };
  assert.deepEqual(requests[0]!.body, identity);
  const { request_id, ...body } = requests[1]!.body;
  assert.match(request_id!, /^[a-f\d-]{36}$/);
  assert.deepEqual(body, { ...identity, prompt: 'What is dvc.labs?' });
});

test('failed requests do not retry or expose upstream body text, and only accept UUID references', async () => {
  const reference = 'c793e738-2088-4b35-89fb-535c8818edfe';
  for (const [status, kind, requestId, safeReference] of [
    [403, 'access_denied', reference, reference], [429, 'rate_limited', '@everyone', undefined],
    [409, 'busy', undefined, undefined], [503, 'unavailable', undefined, undefined],
  ] as const) {
    let calls = 0;
    const client = new HallClient('https://hall.example', 'worker-secret', async () => {
      calls++;
      return Response.json({ error: 'private upstream message', request_id: requestId }, { status });
    });
    await assert.rejects(client.ask(scope, 'a question', false), { name: 'HallError', kind, status, reference: safeReference });
    assert.equal(calls, 1);
  }
});

test('an invalid reply or overlarge response cannot become a Discord answer', async () => {
  for (const value of ['invalid JSON', JSON.stringify({ reply: 'hello', memory: 'none' }),
    JSON.stringify({ reply: 'x'.repeat(16_001), memory: 'session' }),
    JSON.stringify({ reply: 'hello', memory: 'session', oversized: 'x'.repeat(132_000) })]) {
    const client = new HallClient('https://hall.example', 'test', async () => new Response(value));
    await assert.rejects(client.ask(scope, 'a question', false), { name: 'HallError', kind: 'unavailable' });
  }
});

test('Hall shares concurrency limits but lets a member forget immediately after an answer', async () => {
  let now = 1;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = new HallClient('https://hall.example', 'test', async url => {
    calls++;
    await gate;
    return Response.json(String(url).endsWith('/reset') ? { ok: true } : { reply: 'yes', memory: 'session' });
  }, () => now);
  const first = client.ask(scope, 'question', false);
  const second = client.ask({ ...scope, userId: 'other' }, 'question', false);
  try {
    await assert.rejects(client.forget({ ...scope, private: false }), { kind: 'busy' });
    await assert.rejects(client.ask({ ...scope, userId: 'third' }, 'question', false), { kind: 'busy' });
    assert.equal(calls, 2);
  } finally { release(); await Promise.all([first, second]); }
  await client.forget(scope);
  await assert.rejects(client.forget({ ...scope, private: false }), { kind: 'rate_limited' });
  await assert.rejects(client.ask({ ...scope, private: false }, 'question', false), { kind: 'rate_limited' });
  now += 12_000;
  await client.forget({ ...scope, private: false });
  assert.equal(calls, 4);
});

test('shutting down aborts an in-flight request and prevents another upstream call', async () => {
  let aborted = 0;
  const client = new HallClient('https://hall.example', 'test', async (_url, init) => {
    await new Promise<never>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
      aborted++;
      reject(new Error('private fetch detail'));
    }, { once: true }));
    throw new Error('unexpected continuation');
  });
  const first = assert.rejects(client.ask(scope, 'question', false), { kind: 'unavailable' });
  client.close();
  await first;
  await assert.rejects(client.ask({ ...scope, userId: 'other' }, 'question', false), { kind: 'unavailable' });
  assert.equal(aborted, 1);
});

test('V2 responses show the escaped question and answer, retain source links, and cannot ping members', () => {
  const source = '[Wikipedia](https://en.wikipedia.org/wiki/Discord_(software))';
  const pages = hallCards('Look up [an unsafe link](https://example.invalid/) @everyone', { ...hallReply,
    reply: `Hi <@123456789012345678>.\n${source}` }, '', scope.userId, false);
  assert.equal(pages.length, 1);
  const page = pages[0]!;
  assert.equal(page.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(page.allowedMentions, { parse: [], repliedUser: false });
  const text = messageText(page);
  assert.match(text, /\*\*Your question\*\*[\s\S]+\*\*Answer\*\*/);
  assert.ok(!text.includes('https://example.invalid/'));
  assert.ok(!text.includes('<@123456789012345678>'));
  assert.ok(text.includes(source));
  assert.match(text, /Web search used.*Fresh context.*Safety checked/);
});

test('long responses retain the full question, Unicode, complete links and fenced code on continuation cards', () => {
  const source = '[A source](https://example.com/wiki/Test_(article))';
  const prompt = '*'.repeat(998) + '😀';
  const code = 'const x = "😀";\n'.repeat(280);
  const pages = hallCards(prompt, { ...hallReply, reply: `${source}\n\n\`\`\`js\n${code}\`\`\`\nFinal line.`, truncated: true }, '', scope.userId, true);
  assert.ok(pages.length > 2);
  const rendered = pages.map(page => {
    const text = messageText(page);
    assert.ok(text.length < 4_000);
    assert.ok(!/[\uD800-\uDFFF]/u.test(text));
    assert.ok(!text.includes('Further details'));
    assert.equal((text.match(/^```/gm)?.length ?? 0) % 2, 0);
    assert.ok(hasEnabledButton(page.components.map(component => component.toJSON()), hallForgetId(scope.userId, true)));
    return text;
  });
  assert.ok(rendered[0]!.includes('\\*'.repeat(998) + '😀'));
  assert.ok(rendered.some(text => text.includes(source)));
  assert.equal(rendered.join('').match(/const x =/g)?.length, 280);
  assert.match(rendered.at(-1)!, /Final line.[\s\S]+Hall reached its reply limit/);
});

test('a citation larger than a V2 card is displayed as inert text without a partial live link', () => {
  const url = `https://example.com/${'a'.repeat(3_000)}`;
  const pages = hallCards('A question', { ...hallReply, reply: `[Source](${url})\nEnding.` }, '', scope.userId, false);
  assert.ok(pages.length > 1);
  const text = pages.map(messageText).join('\n');
  assert.ok(!text.includes('https://example.com/'));
  assert.match(text, /Ending\./);
});
