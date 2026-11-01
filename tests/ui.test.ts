import assert from 'node:assert/strict';
import test from 'node:test';
import { aboutCard, displayText, welcomeMessage } from '../src/ui.js';
import { messageText, testConfig } from './helpers.js';

test('member-controlled text cannot supply masked links, autolinks, headings, lists, quotes, or mentions', () => {
  const text = displayText('[Claim your free Nitro](https://discord-gifts.example/claim)\n'
    + '# Heading\n- List\n1. Number\n> Quote\n>>> More quotes\n@everyone <@111111111111111111>\n'
    + 'https://example.com www.example.com discord.gg/test', 2_000);
  assert.equal(/(?<!\\)\[Claim your free Nitro]\(/.test(text), false);
  assert.ok(text.includes('\\[Claim your free Nitro]('));
  for (const raw of ['\n# ', '\n- ', '\n1. ', '\n> ', '\n>>> ', '@everyone', '<@111111111111111111>',
    'https://', 'www.example.com', 'discord.gg/test']) assert.equal(text.includes(raw), false, raw);
  assert.ok(text.includes('Claim your free Nitro'));
  assert.ok(text.includes('\\>'));
});

test('authored GitHub links remain usable and the welcome includes the logging notice', () => {
  const config = testConfig();
  const welcome = welcomeMessage(config, '777777777777777777');
  assert.match(JSON.stringify(welcome), /https:\/\/github.com\/dvc-labs/);
  assert.match(messageText(welcome), /logs membership, verification/);
  assert.match(messageText(welcome), /Ordinary chat and incoming DMs are not archived/);
  assert.match(messageText(aboutCard(config, 10)), /\[loon.host\]\(https:\/\/loon.host\)/);
});

test('subtext markers, bidi controls, and single-slash schemes are neutralised', () => {
  const text = displayText('-# subtext\n  -# indented\n\u202ereversed\u202c\u2066text\u2069 <https:/x>');
  assert.match(text, /\\-# subtext/);
  assert.match(text, /  \\-# indented/);
  assert.equal(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text), false);
  assert.equal(text.includes('https:/'), false);
});

test('truncation by source code point preserves complete emojis and Markdown escape sequences', () => {
  const emoji = displayText('x'.repeat(99) + '😀tail', 100);
  assert.equal(Array.from(emoji).length, 100);
  assert.ok(emoji.endsWith('😀'));
  const markup = displayText('x'.repeat(97) + '*****', 100);
  assert.ok(markup.endsWith('\\*\\*\\*'));
  const slash = displayText('x'.repeat(99) + '\\tail', 100);
  assert.equal((slash.match(/\\+$/)?.[0].length ?? 0) % 2, 0);
});
