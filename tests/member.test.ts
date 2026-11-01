import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActivityType, Collection, GuildMemberFlagsBitField, MessageFlags, PermissionFlagsBits,
  PermissionsBitField, UserFlagsBitField, type Guild, type GuildMember, type Role, type User,
} from 'discord.js';
import { buildMemberReport, loadMemberReport, MemberLookupLimiter, memberCard,
  memberNavigationId, parseMemberNavigation } from '../src/member.js';
import { messageText, testConfig } from './helpers.js';

function fixture(roleCount = 2) {
  const config = testConfig();
  const user = {
    id: '777777777777777777', tag: 'Dave', globalName: 'Dave', username: 'dave', bot: false, system: false,
    createdTimestamp: 1_500_000_000_000, flags: new UserFlagsBitField(), primaryGuild: null,
    hexAccentColor: '#26bcc5', collectibles: null,
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png',
    bannerURL: () => null, avatarDecorationURL: () => null,
  };
  const roles = new Collection<string, Role>();
  for (let i = 0; i < roleCount; i++) {
    const role = { id: (333333333333333333n + BigInt(i)).toString(), position: i,
      comparePositionTo: (other: { position: number }) => i - other.position };
    roles.set(role.id, role as unknown as Role);
  }
  const member = {
    id: user.id, user, guild: { id: config.guildId, ownerId: '888888888888888888', roles: { everyone: { id: config.guildId } } },
    nickname: 'Dave', displayName: 'Dave', joinedTimestamp: 1_600_000_000_000, pending: false,
    premiumSinceTimestamp: null, communicationDisabledUntilTimestamp: null,
    flags: new GuildMemberFlagsBitField(), permissions: new PermissionsBitField(PermissionsBitField.All),
    roles: { cache: roles, highest: roles.last()! }, manageable: true, kickable: false, bannable: false, moderatable: false,
    isCommunicationDisabled: () => false, presence: null as { status: string; clientStatus: object; activities: unknown[] } | null,
    voice: { channelId: null as string | null, channel: { permissionsFor: () => new PermissionsBitField() },
      selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, streaming: false, selfVideo: false, suppress: false },
    avatarURL: () => null, bannerURL: () => null, avatarDecorationURL: () => null,
    displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png', displayHexColor: '#26bcc5',
  };
  const report = () => buildMemberReport(member as unknown as GuildMember, user as unknown as User, config);
  return { member, user, config, report };
}

test('member pages show exact native references, real dates, permissions, and honest unavailable states', () => {
  const f = fixture();
  const report = f.report();
  const text = report.pages.map(page => messageText(memberCard(report, '888888888888888888', report.pages.indexOf(page)))).join('\n');
  assert.match(text, /<@777777777777777777>/);
  assert.match(text, /<@&333333333333333333>/);
  assert.match(text, /<t:1500000000:f>/);
  assert.match(text, /<t:1600000000:f>/);
  assert.match(text, /Not observed/);
  assert.match(text, /Administrator/);
  assert.match(text, /Not set/);
});

test('every role and permission remains available and all V2 pages fit the message limit for large profiles', () => {
  const f = fixture(250);
  f.member.nickname = '@everyone **spoof**';
  f.member.presence = { status: 'online', clientStatus: { desktop: 'online' }, activities: Array.from({ length: 20 }, () => ({
    name: 'x'.repeat(128), details: 'x'.repeat(128), state: 'x'.repeat(128), type: ActivityType.Playing,
  })) };
  const report = f.report();
  const all: string[] = [];
  for (let i = 0; i < report.pages.length; i++) {
    const payload = memberCard(report, '888888888888888888', i);
    const text = messageText(payload);
    all.push(text);
    assert.ok(text.length < 4_000);
    assert.equal(payload.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
    payload.components.forEach(component => component.toJSON());
  }
  for (const role of f.member.roles.cache.values()) assert.ok(all.join('\n').includes(`<@&${role.id}>`));
  assert.equal(all.join('\n').includes('@everyone **spoof**'), false);
  assert.ok(report.pages.some(page => page.title === 'More activities'));
});

test('public reports never reveal private voice-channel IDs even if the caller can access them', () => {
  const f = fixture();
  f.member.voice.channelId = '999999999999999999';
  const privateReport = f.report();
  assert.equal(JSON.stringify(privateReport).includes(f.member.voice.channelId), false);
  assert.match(JSON.stringify(privateReport), /channel details omitted/);
  f.member.voice.channel.permissionsFor = () => new PermissionsBitField(PermissionFlagsBits.ViewChannel);
  const publicReport = f.report();
  assert.ok(JSON.stringify(publicReport).includes('<#999999999999999999>'));
});

test('member lookup fetches only the requested account and refreshes public user profile data', async () => {
  const f = fixture();
  const calls: unknown[] = [];
  const guild = { members: { fetch: async (options: unknown) => { calls.push(options); return f.member; } },
    client: { users: { fetch: async (id: string, options: unknown) => { calls.push([id, options]); return f.user; } } } };
  const report = await loadMemberReport(guild as unknown as Guild, f.config, f.user.id);
  assert.equal(report!.userId, f.user.id);
  assert.deepEqual(calls, [{ user: f.user.id, cache: false, force: true }, [f.user.id, { cache: false, force: true }]]);
});

test('unknown members stop before profile fetches and other Discord errors propagate', async () => {
  for (const code of [10007, 50013]) {
    const f = fixture();
    const guild = { members: { fetch: async () => { throw { code }; } },
      client: { users: { fetch: async () => { throw new Error('must not fetch'); } } } };
    if (code === 10007) assert.equal(await loadMemberReport(guild as unknown as Guild, f.config, f.user.id), null);
    else await assert.rejects(loadMemberReport(guild as unknown as Guild, f.config, f.user.id));
  }
});

test('navigation binds the requester and target and rejects malformed or oversized page IDs', () => {
  const id = memberNavigationId('888888888888888888', '777777777777777777', 2);
  assert.ok(id.length <= 100);
  assert.deepEqual(parseMemberNavigation(id), { ownerId: '888888888888888888', userId: '777777777777777777', page: 2 });
  for (const invalid of [id + ':extra', id.replace(':2', ':-1'), id.replace(':2', ':999'), 'dvc:member:v1:someone:target:0']) {
    assert.equal(parseMemberNavigation(invalid), null);
  }
});

test('lookup budgets enforce per-user intervals and a shared burst/refill limit', () => {
  let now = 1_000;
  const limiter = new MemberLookupLimiter(() => now);
  for (let i = 0; i < 5; i++) {
    const permit = limiter.acquire(`member-${i}`);
    assert.equal(permit.allowed, true);
    if (permit.allowed) permit.release();
  }
  assert.deepEqual(limiter.acquire('another'), { allowed: false, retryAfter: 2 });
  assert.deepEqual(limiter.acquire('member-0'), { allowed: false, retryAfter: 10 });
  now += 2_000;
  const page = limiter.acquire('member-0', true);
  assert.equal(page.allowed, true);
  if (page.allowed) page.release();
  assert.deepEqual(limiter.acquire('member-0', true), { allowed: false, retryAfter: 2 });
  now += 8_000;
  assert.equal(limiter.acquire('member-0').allowed, true);
});

test('at most two member reports run concurrently and release is idempotent', () => {
  const limiter = new MemberLookupLimiter();
  const first = limiter.acquire('first');
  const second = limiter.acquire('second');
  assert.equal(limiter.acquire('third').allowed, false);
  if (first.allowed) { first.release(); first.release(); }
  assert.equal(limiter.acquire('third').allowed, true);
  assert.equal(limiter.acquire('fourth').allowed, false);
  if (second.allowed) second.release();
  assert.equal(limiter.acquire('fourth').allowed, true);
});
