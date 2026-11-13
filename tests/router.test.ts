import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags, MessageFlagsBitField, PermissionFlagsBits, PermissionsBitField, type Interaction } from 'discord.js';
import { AuditLog, type AuditEvent } from '../src/audit.js';
import type { Config } from '../src/config.js';
import { SetupError } from '../src/errors.js';
import { HallError, type HallReply } from '../src/hall.js';
import { hallCards, hallForgetId } from '../src/hall-ui.js';
import { Logger } from '../src/logger.js';
import { memberDetailsId, memberNavigationId, type MemberReport } from '../src/member.js';
import { BulletinService, type BulletinGateway } from '../src/bulletin.js';
import { bulletinActionId, BULLETIN_PANEL_BUTTON, BULLETIN_VERIFY_BUTTON, VERIFY_CUSTOM_ID } from '../src/policy.js';
import { CHERRY_MODAL_ID, CHERRY_REVIEW_PREFIX, type CherryCreek } from '../src/cherry-creek.js';
import { InteractionRouter, type RouterDependencies } from '../src/router.js';
import { VerificationService, type VerificationGateway } from '../src/verification.js';
import { messageText } from './helpers.js';

function fixture(kind: 'command' | 'button' | 'modal' = 'button') {
  const config: Config = {
    token: 'test', guildId: 'guild', applicationId: 'bot', verificationRoleId: 'member-role', adminRoleId: undefined,
    verificationChannelId: 'verification', commandsChannelId: 'commands', logsChannelId: 'logs',
    verificationMessageId: undefined, bulletinRoleId: undefined, hallWorkerUrl: undefined, hallApiKey: undefined,
    modChannelId: undefined, minecraftChannelId: undefined, minecrafterRoleId: undefined, dataDir: '/unused/test/data',
    port: 8080, logLevel: 'error', emoji: '',
  };
  const events: AuditEvent[] = [];
  const awarded: string[] = [];
  const replies: unknown[] = [];
  const deleted: string[] = [];
  const logs: Parameters<Logger['write']>[] = [];
  const logger = new Logger('error', '');
  logger.write = (...args) => { logs.push(args); };
  const audit = new AuditLog(logger);
  audit.setSink(async event => { events.push(event); });
  const gateway: VerificationGateway = {
    getMember: async () => ({ hasAccess: false, pending: false, bot: false }),
    assertRoleAssignable: async () => {},
    addRole: async id => { awarded.push(id); },
  };
  const verification = new VerificationService(gateway);
  let refreshes = 0;
  let ready = true;
  let panelId = 'panel';
  let now = 1_000;
  let responseCount = 0;
  const deps: RouterDependencies = {
    config, audit, logger, botId: () => 'bot', isReady: () => ready, panelId: () => panelId,
    verification: () => verification,
    memberReport: async () => { throw new Error('Unexpected member lookup'); },
    now: () => now,
    refreshPanel: async () => { refreshes++; return { id: 'panel', created: false, retiredBulletinCards: 0 }; },
  };
  const router = new InteractionRouter(deps);
  const raw = {
    kind,
    guildId: 'guild', channelId: kind === 'command' ? 'commands' : 'verification',
    user: { id: 'member' }, message: { id: 'panel', author: { id: 'bot' }, flags: new MessageFlagsBitField(),
      components: [] as { toJSON(): unknown }[] },
    customId: kind === 'modal' ? 'dvc:verify:form:v1:member:panel' : VERIFY_CUSTOM_ID,
    commandName: 'about', memberPermissions: new PermissionsBitField(),
    resolvedMember: { id: '777777777777777777' } as { id: string } | null,
    prompt: 'How does verification work?', privateReply: false, resetContext: false,
    options: { getUser: () => ({ id: '777777777777777777' }), getMember: () => raw.resolvedMember,
      getString: (): string => raw.prompt, getBoolean: (name: string): boolean => name === 'private' ? raw.privateReply : raw.resetContext },
    deferred: false, replied: false, ephemeral: null as boolean | null, responseId: 'reply-0',
    isChatInputCommand: () => raw.kind === 'command', isButton: () => raw.kind === 'button',
    isModalSubmit: () => raw.kind === 'modal',
    async reply(payload: unknown) { raw.replied = true; raw.ephemeral = !!((payload as { flags?: number }).flags! & MessageFlags.Ephemeral); replies.push(payload); },
    async deferReply(payload: unknown) {
      raw.deferred = true; raw.ephemeral = !!((payload as { flags?: number }).flags! & MessageFlags.Ephemeral);
      raw.responseId = `reply-${++responseCount}`; replies.push(payload);
    },
    async deferUpdate() { raw.deferred = true; raw.responseId = raw.message.id; replies.push({ deferUpdate: true }); },
    async editReply(payload: unknown) { raw.replied = true; replies.push(payload); return { id: raw.responseId }; },
    async deleteReply() { deleted.push(raw.responseId); },
    async followUp(payload: unknown) {
      if (raw.kind === 'command' && raw.deferred && !raw.replied) {
        assert.fail('A first follow-up after a public defer would ignore its ephemeral flag');
      }
      replies.push(payload); return { id: `followup-${++responseCount}` };
    },
  };
  return { raw, events, awarded, replies, deleted, logs, gateway, audit, deps, refreshes: () => refreshes,
    advance: (ms: number) => { now += ms; },
    useMessage: (id: string, ephemeral = false) => {
      raw.kind = 'button'; raw.message.id = id; raw.message.flags = new MessageFlagsBitField(ephemeral ? MessageFlags.Ephemeral : 0);
      raw.deferred = false; raw.replied = false; raw.ephemeral = null; raw.responseId = id;
    },
    setReady: (value: boolean) => { ready = value; },
    setPanel: (value: string) => { panelId = value; },
    handle: () => router.handle(raw as unknown as Interaction),
    run: async () => { await router.handle(raw as unknown as Interaction); await audit.flush(); } };
}

test('trusted button defers privately before fetching and awards only the clicking member', async () => {
  const f = fixture();
  f.gateway.getMember = async () => {
    assert.equal(f.raw.deferred, true);
    return { hasAccess: false, pending: false, bot: false };
  };
  await f.run();
  assert.deepEqual(f.awarded, ['member']);
  assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
  assert.equal(f.events[0]!.event, 'verification_succeeded');
  assert.equal(f.events[0]!.priority, 'important');
  assert.equal(f.events[0]!.roleId, 'member-role');
});

const lookup: MemberReport = {
  userId: '777777777777777777', thumbnail: 'https://cdn.discordapp.com/embed/avatars/0.png',
  pages: [{ title: 'Overview', fields: [{ name: 'Member', value: '<@777777777777777777>' }] },
    { title: 'Server membership', fields: [{ name: 'Highest role', value: 'Member' }] },
    { title: 'Permissions', fields: [{ name: 'Permissions', value: 'PRIVATE_PERMISSION_DATA' }], staffOnly: true },
    { title: 'Presence and voice', fields: [{ name: 'Activities', value: 'PRIVATE_TRACK' }], staffOnly: true }],
};

async function lookupFixture() {
  const f = fixture('command');
  f.raw.commandName = 'member'; f.raw.user.id = '888888888888888888';
  f.deps.memberReport = async () => lookup;
  await f.run();
  const publicId = f.raw.responseId;
  f.useMessage(publicId);
  f.raw.customId = memberNavigationId(f.raw.user.id, lookup.userId, 1);
  f.events.length = 0; f.replies.length = 0; f.logs.length = 0;
  return { ...f, publicId };
}

test('member command is public for ordinary members and audits the caller and target separately', async () => {
  const f = fixture('command');
  f.raw.commandName = 'member';
  f.raw.user.id = '888888888888888888';
  f.deps.memberReport = async userId => {
    assert.equal(f.raw.deferred, true);
    assert.equal(userId, lookup.userId);
    return lookup;
  };
  await f.run();
  assert.deepEqual(f.replies[0], {});
  assert.equal((f.replies[1] as { flags: number }).flags & MessageFlags.Ephemeral, 0);
  assert.match(messageText(f.replies[1]), /<@777777777777777777>/);
  assert.equal(JSON.stringify(f.replies).includes('PRIVATE_'), false);
  assert.equal(f.events[0]!.userId, '888888888888888888');
  assert.equal(f.events[0]!.targetUserId, lookup.userId);
  assert.equal(f.events[0]!.outcome, 'success');
});

test('member lookup cannot run in another guild/channel or during startup', async () => {
  for (const change of ['guild', 'channel', 'not_ready']) {
    const f = fixture('command');
    f.raw.commandName = 'member';
    if (change === 'guild') f.raw.guildId = 'elsewhere';
    if (change === 'channel') f.raw.channelId = 'elsewhere';
    if (change === 'not_ready') f.setReady(false);
    let reads = 0;
    f.deps.memberReport = async () => { reads++; return lookup; };
    await f.run();
    assert.equal(reads, 0);
    assert.equal(f.raw.deferred, false);
    assert.equal((f.replies[0] as { flags: number }).flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  }
});

test('member page buttons recheck ownership, guild, channel, and bot authorship before reading', async () => {
  for (const change of ['owner', 'guild', 'channel', 'author', 'malformed', 'not_ready']) {
    const f = await lookupFixture();
    if (change === 'owner') f.raw.user.id = '999999999999999999';
    if (change === 'guild') f.raw.guildId = 'elsewhere';
    if (change === 'channel') f.raw.channelId = 'elsewhere';
    if (change === 'author') f.raw.message.author.id = 'someone';
    if (change === 'malformed') f.raw.customId += ':invalid';
    if (change === 'not_ready') f.setReady(false);
    let reads = 0;
    f.deps.memberReport = async () => { reads++; return lookup; };
    await f.run();
    assert.equal(reads, 0);
    assert.equal(f.raw.deferred, false);
  }
});

test('member navigation uses a stable snapshot without repeating member/profile fetches', async () => {
  const f = await lookupFixture();
  let reads = 0;
  f.deps.memberReport = async userId => { assert.equal(userId, lookup.userId); reads++; return lookup; };
  await f.run();
  assert.equal(reads, 0);
  assert.deepEqual(f.replies[0], { deferUpdate: true });
  assert.match(messageText(f.replies[1]), /Member · Server membership/);
  assert.equal(f.events.length, 0); // Page navigation is console-only.
  f.advance(2_001); f.useMessage(f.publicId);
  f.raw.customId = memberNavigationId(f.raw.user.id, lookup.userId, 99);
  await f.run();
  assert.equal(JSON.stringify(f.replies).includes('PRIVATE_'), false);
  assert.equal(reads, 0);
});

test('missing member and lookup failures produce generic guidance without exposing API error bodies', async () => {
  for (const missing of [true, false]) {
    const f = fixture('command');
    f.raw.commandName = 'member';
    f.deps.memberReport = async () => {
      if (missing) return null;
      throw new Error('private request body');
    };
    await f.run();
    assert.equal(f.events[0]!.outcome, missing ? 'member_not_found' : 'error');
    assert.deepEqual(f.deleted, ['reply-1']);
    assert.equal((f.replies.at(-1) as { flags: number }).flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
    assert.match(messageText(f.replies[1]), /Lookup finished/);
    assert.equal(messageText(f.replies[1]).includes('Member not found'), false);
    assert.equal(JSON.stringify(f.replies).includes('private request body'), false);
    assert.equal(JSON.stringify(f.logs).includes('private request body'), false);
  }
});

test('a resolved non-member is rejected privately before deferring or fetching any profile', async () => {
  const f = fixture('command');
  f.raw.commandName = 'member'; f.raw.resolvedMember = null;
  let reads = 0;
  f.deps.memberReport = async () => { reads++; return lookup; };
  await f.run();
  assert.equal(reads, 0);
  assert.equal(f.raw.deferred, false);
  assert.equal(f.deleted.length, 0);
  assert.equal(f.replies.length, 1);
  assert.equal((f.replies[0] as { flags: number }).flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  assert.match(messageText(f.replies[0]), /Member not found/);
});

test('failure handling does not risk a public follow-up if completing the original defer fails', async () => {
  const f = fixture('command');
  f.raw.commandName = 'member';
  f.deps.memberReport = async () => null;
  f.raw.editReply = async () => { throw new Error('private failure body'); };
  let followups = 0;
  f.raw.followUp = async () => { followups++; return { id: 'unexpected' }; };
  await f.run();
  assert.equal(followups, 0);
  assert.deepEqual(f.deleted, ['reply-1']);
  assert.equal(JSON.stringify(f.logs).includes('private failure body'), false);
});

test('expired snapshots ask for a new lookup without performing another API request', async () => {
  const f = await lookupFixture();
  f.advance(120_000);
  let reads = 0;
  f.deps.memberReport = async () => { reads++; return lookup; };
  await f.run();
  assert.equal(reads, 0);
  assert.equal(f.raw.deferred, false);
  assert.match(messageText(f.replies[0]), /This card has expired/);
  assert.match(messageText(f.replies[0]), /Run \/member again/);
});

test('staff opening details on an expired card also get specific refresh guidance', async () => {
  const f = await lookupFixture();
  f.advance(120_000);
  f.raw.customId = memberDetailsId(f.raw.user.id, lookup.userId);
  f.raw.memberPermissions = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
  let reads = 0;
  f.deps.memberReport = async () => { reads++; return lookup; };
  await f.run();
  assert.equal(reads, 0);
  assert.equal(f.raw.deferred, false);
  assert.match(messageText(f.replies[0]), /This card has expired/);
});

test('private staff details require Manage Server or Moderate Members and are never posted publicly', async () => {
  for (const permission of [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ModerateMembers]) {
    const f = await lookupFixture();
    f.raw.customId = memberDetailsId(f.raw.user.id, lookup.userId);
    f.raw.memberPermissions = new PermissionsBitField(permission);
    let reads = 0;
    f.deps.memberReport = async () => { assert.equal(f.raw.ephemeral, true); reads++; return lookup; };
    await f.run();
    assert.equal(reads, 1);
    assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
    const privateId = f.raw.responseId;
    f.advance(2_001);
    f.useMessage(privateId, true);
    f.raw.customId = memberNavigationId(f.raw.user.id, lookup.userId, 2);
    await f.run();
    assert.ok(JSON.stringify(f.replies).includes('PRIVATE_PERMISSION_DATA'));
    assert.equal(reads, 1);
    f.advance(2_001); f.useMessage(privateId, true);
    f.raw.memberPermissions = new PermissionsBitField();
    f.replies.length = 0;
    await f.run();
    assert.equal(JSON.stringify(f.replies).includes('PRIVATE_'), false);
    assert.equal(f.raw.deferred, false);
  }
});

test('ordinary members cannot open staff details or access private snapshots', async () => {
  const f = await lookupFixture();
  f.raw.customId = memberDetailsId(f.raw.user.id, lookup.userId);
  let reads = 0;
  f.deps.memberReport = async () => { reads++; return lookup; };
  await f.run();
  assert.equal(reads, 0);
  assert.equal(f.raw.deferred, false);
  assert.equal((f.replies[0] as { flags: number }).flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  assert.equal(f.events.length, 0);
});

test('150 denied public-card clicks cannot fill the Discord audit queue or displace verification', async () => {
  const f = await lookupFixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.audit.setSink(async event => { await blocked; f.events.push(event); });
  f.audit.record({ event: 'seed', title: 'Seed', outcome: 'ready' });
  f.raw.user.id = '999999999999999999';
  for (let i = 0; i < 150; i++) { f.useMessage(f.publicId); await f.handle(); }
  f.raw.channelId = 'verification'; f.useMessage('panel'); f.raw.customId = VERIFY_CUSTOM_ID;
  await f.handle();
  release(); await f.audit.flush();
  assert.deepEqual(f.events.map(event => event.event), ['seed', 'verification_succeeded']);
  assert.equal(f.logs.filter(([, event]) => event === 'member_lookup_denied').length, 150);
  assert.equal(f.logs.some(([, event]) => event === 'audit_queue_full'), false);
});

test('already verified, screening-pending, and bot members receive private replies without role writes', async () => {
  for (const [member, outcome] of [
    [{ hasAccess: true, pending: false, bot: false }, 'already_verified'],
    [{ hasAccess: false, pending: true, bot: false }, 'screening_pending'],
    [{ hasAccess: false, pending: false, bot: true }, 'bot'],
  ] as const) {
    const f = fixture();
    f.gateway.getMember = async () => member;
    await f.run();
    assert.deepEqual(f.awarded, []);
    assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
    assert.equal(f.logs.find(([, event]) => event === 'verification_attempt')?.[2]?.outcome, outcome);
    assert.equal(f.events.length, outcome === 'already_verified' ? 0 : 1);
  }
});

test('forged, stale, wrong-channel, and wrong-guild panels cannot trigger member or role calls', async () => {
  for (const change of ['author', 'message', 'channel', 'guild', 'not_ready', 'replaced_panel']) {
    const f = fixture();
    let reads = 0;
    f.gateway.getMember = async () => { reads++; throw new Error('must not fetch'); };
    if (change === 'author') f.raw.message.author.id = 'someone';
    if (change === 'message') f.raw.message.id = 'old-panel';
    if (change === 'channel') f.raw.channelId = 'elsewhere';
    if (change === 'guild') f.raw.guildId = 'another-guild';
    if (change === 'not_ready') f.setReady(false);
    if (change === 'replaced_panel') f.setPanel('new-panel');
    await f.run();
    assert.equal(reads, 0);
    assert.deepEqual(f.awarded, []);
    assert.equal(f.raw.deferred, false);
  }
});

test('forms opened before deployment are ignored without member or role calls', async () => {
  const f = fixture('modal');
  let reads = 0;
  f.gateway.getMember = async () => { reads++; throw new Error('must not fetch'); };
  await f.run();
  assert.equal(reads, 0);
  assert.deepEqual(f.awarded, []);
  assert.deepEqual(f.replies, []);
  assert.deepEqual(f.events, []);
});

test('a failed role write produces failure logs and no success event', async () => {
  const f = fixture();
  f.gateway.addRole = async () => { throw new Error('private token must not be logged'); };
  await f.run();
  assert.deepEqual(f.events.map(event => event.event), ['verification_failed']);
  assert.equal(f.events[0]!.priority, 'critical');
  assert.equal(f.events[0]!.detail, 'Error');
  assert.equal(JSON.stringify(f.logs).includes('private token'), false);
  assert.equal(JSON.stringify(f.replies).includes('private token'), false);
});

test('runtime role setup errors retain details in operator logs and give members generic private guidance', async () => {
  const f = fixture();
  const message = 'Move the dvc.services bot role above the verification role.';
  f.gateway.assertRoleAssignable = async () => { throw new SetupError(message); };
  await f.run();
  assert.deepEqual(f.awarded, []);
  assert.equal(f.events[0]!.detail, message);
  assert.equal(f.logs.find(([, event]) => event === 'interaction_failed')![2]!.error, message);
  assert.equal(JSON.stringify(f.replies).includes(message), false);
  assert.ok(JSON.stringify(f.replies).includes('Please try again shortly.'));
  assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
});

test('lost confirmation reply preserves the successful role-award log', async () => {
  const f = fixture();
  f.raw.editReply = async () => { throw new Error('interaction expired'); };
  await f.run();
  assert.deepEqual(f.awarded, ['member']);
  assert.deepEqual(f.events.map(event => event.event), ['verification_succeeded']);
});

test('repeated button presses cannot award twice and cooldown logs stay local', async () => {
  const f = fixture();
  let reads = 0;
  f.gateway.getMember = async () => { reads++; return { hasAccess: false, pending: false, bot: false }; };
  await f.run();
  await f.run();
  assert.deepEqual(f.awarded, ['member']);
  assert.equal(reads, 1);
  assert.deepEqual(f.events.map(event => event.outcome), ['awarded']);
  assert.ok(f.logs.some(([, event, fields]) => event === 'verification_attempt' && fields?.outcome === 'cooldown'));
});

test('one member spamming Verify cannot displace another member’s successful audit event', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.audit.setSink(async event => { await blocked; f.events.push(event); });
  try {
    await f.handle();
    for (let i = 0; i < 150; i++) await f.handle();
    f.raw.user.id = 'another-member';
    await f.handle();
  } finally {
    release();
    await f.audit.flush();
  }
  assert.deepEqual(f.awarded, ['member', 'another-member']);
  assert.deepEqual(f.events.map(event => event.userId), ['member', 'another-member']);
  assert.equal(f.logs.filter(([, , fields]) => fields?.outcome === 'cooldown').length, 150);
});

test('concurrent button presses acknowledge processing locally and record one successful award', async () => {
  const f = fixture();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.gateway.getMember = async () => {
    await blocked;
    return { hasAccess: false, pending: false, bot: false };
  };
  const first = f.handle();
  try {
    await f.handle();
    assert.ok(f.logs.some(([, , fields]) => fields?.outcome === 'processing'));
  } finally { release(); await first; await f.audit.flush(); }
  assert.deepEqual(f.awarded, ['member']);
  assert.deepEqual(f.events.map(event => event.outcome), ['awarded']);
});

test('unrelated buttons and forms are ignored', async () => {
  for (const kind of ['button', 'modal'] as const) {
    const f = fixture(kind);
    f.raw.customId = 'another-feature';
    await f.run();
    assert.deepEqual(f.awarded, []);
    assert.deepEqual(f.replies, []);
    assert.deepEqual(f.events, []);
  }
});

test('panel command enforces Manage Server at runtime and logs denial', async () => {
  const f = fixture('command');
  f.raw.commandName = 'verification';
  await f.run();
  assert.equal(f.refreshes(), 0);
  assert.equal(f.events[0]!.outcome, 'denied_permission');
});

test('stale explicit panel configuration is actionable in operator logs with generic private guidance', async () => {
  const f = fixture('command');
  f.raw.commandName = 'verification';
  f.raw.memberPermissions = new PermissionsBitField(PermissionFlagsBits.ManageGuild);
  const message = 'VERIFICATION_MESSAGE_ID must identify an existing verification panel sent by this bot.';
  f.deps.refreshPanel = async () => { throw new SetupError(message); };
  await f.run();
  assert.equal(f.events[0]!.event, 'command_used');
  assert.equal(f.events[0]!.outcome, 'error');
  assert.equal(f.events[0]!.detail, message);
  assert.equal(f.logs.find(([, event]) => event === 'interaction_failed')![2]!.error, message);
  assert.equal(JSON.stringify(f.replies).includes(message), false);
  assert.ok(JSON.stringify(f.replies).includes('Please try again shortly.'));
  assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
});

test('repeated commands keep cooldown audits local', async () => {
  const f = fixture('command');
  await f.run();
  await f.run();
  assert.deepEqual(f.events.map(event => event.outcome), ['success']);
  assert.ok(f.logs.some(([, event, fields]) => event === 'command_used' && fields?.outcome === 'cooldown'));
});

test('command channel restriction applies before panel updates', async () => {
  const f = fixture('command');
  f.raw.channelId = 'elsewhere';
  await f.run();
  assert.equal(f.events[0]!.outcome, 'denied_channel');
  assert.equal(f.raw.replied, true);
});

test('about sends its public V2 card and records command use', async () => {
  const f = fixture('command');
  await f.run();
  assert.equal(f.events[0]!.command, 'about');
  assert.equal(f.events[0]!.outcome, 'success');
  const payload = f.replies[0] as { flags: number; components: unknown[]; embeds?: unknown[] };
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal(payload.embeds, undefined);
  assert.equal(payload.components.length, 1);
  assert.match(messageText(payload), /loon.host/);
});

const BULLETIN_TEST_USER = '999999999999999999';
const BULLETIN_ROLE = '888888888888888888';
const BULLETIN_JOIN_ID = bulletinActionId(BULLETIN_TEST_USER, BULLETIN_ROLE, 'join');
const BULLETIN_LEAVE_ID = bulletinActionId(BULLETIN_TEST_USER, BULLETIN_ROLE, 'leave');
const BULLETIN_SKIP_ID = bulletinActionId(BULLETIN_TEST_USER, BULLETIN_ROLE, 'skip');

function bulletinFixture(member = { verified: true, subscribed: false, bot: false }) {
  const f = fixture();
  f.raw.user.id = BULLETIN_TEST_USER;
  Object.assign(f.deps.config, { bulletinRoleId: BULLETIN_ROLE });
  const writes: [string, boolean][] = [];
  const gateway: BulletinGateway = {
    getMember: async () => member,
    assertRoleAssignable: async () => {},
    setRole: async (id, subscribed) => { writes.push([id, subscribed]); member.subscribed = subscribed; },
  };
  const service = new BulletinService(gateway, f.deps.now);
  f.deps.bulletin = () => service;
  return { ...f, member, writes, bulletinGateway: gateway,
    click: async (customId: string) => {
      f.useMessage('private-card', true); f.raw.channelId = 'verification'; f.raw.customId = customId; await f.run();
    } };
}

test('newly verified members get a private Bulletin choice without automatically subscribing', async () => {
  for (const hasAccess of [false, true]) {
    const f = bulletinFixture();
    f.gateway.getMember = async () => ({ hasAccess, pending: false, bot: false });
    await f.run();
    assert.match(messageText(f.replies[1]), hasAccess ? /Already verified/ : /Member verified/);
    const receipt = JSON.stringify(f.replies[1]);
    assert.equal(f.raw.ephemeral, true);
    assert.equal(receipt.includes(BULLETIN_JOIN_ID), !hasAccess);
    assert.equal(receipt.includes(BULLETIN_SKIP_ID), !hasAccess);
    assert.equal(messageText(f.replies[1]).includes('Would you like to receive announcement bulletins?'), !hasAccess);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.awarded, hasAccess ? [] : [BULLETIN_TEST_USER]);
  }
});

test('choosing No keeps the member verified and points back to Bulletin preferences without writing a role', async () => {
  const f = bulletinFixture();
  await f.click(BULLETIN_SKIP_ID);
  assert.deepEqual(f.replies[0], { deferUpdate: true });
  assert.match(messageText(f.replies[1]), /Bulletin preferences/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.events, []);
});

test('the verification panel opens private Bulletin preferences from current roles', async () => {
  const f = bulletinFixture();
  f.useMessage('panel');
  f.raw.customId = BULLETIN_VERIFY_BUTTON;
  await f.run();
  assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
  assert.ok(JSON.stringify(f.replies.at(-1)).includes(BULLETIN_JOIN_ID));
  // A staff role change outside this bot is reflected in the next card.
  f.member.subscribed = true;
  f.advance(3_001);
  f.useMessage('panel');
  f.raw.customId = BULLETIN_VERIFY_BUTTON;
  await f.run();
  assert.ok(JSON.stringify(f.replies.at(-1)).includes(BULLETIN_LEAVE_ID));
  assert.deepEqual(f.writes, []);
});

test('retired Bulletin cards and replaced verification cards cannot change roles', async () => {
  const f = fixture();
  f.raw.customId = BULLETIN_VERIFY_BUTTON;
  f.useMessage('bulletin-panel');
  await f.run();
  assert.equal(f.raw.deferred, false);
  assert.equal(f.raw.ephemeral, true);
  assert.match(messageText(f.replies[0]), /Bulletin unavailable/);
  const replaced = bulletinFixture();
  replaced.raw.customId = BULLETIN_PANEL_BUTTON;
  replaced.useMessage('bulletin-panel');
  await replaced.run();
  assert.equal(replaced.raw.deferred, false);
  assert.deepEqual(replaced.writes, []);
});

test('Bulletin buttons toggle only the clicking member’s role and edit the private card in place', async () => {
  const f = bulletinFixture();
  await f.click(BULLETIN_JOIN_ID);
  assert.deepEqual(f.writes, [[BULLETIN_TEST_USER, true]]);
  assert.deepEqual(f.replies[0], { deferUpdate: true });
  assert.match(messageText(f.replies[1]), /Bulletin pings are on/);
  assert.ok(JSON.stringify(f.replies[1]).includes(BULLETIN_LEAVE_ID));
  assert.equal(f.events[0]!.event, 'bulletin_updated');
  assert.equal(f.events[0]!.outcome, 'subscribed');
  assert.equal(f.events[0]!.roleId, BULLETIN_ROLE);
  assert.equal(f.events[0]!.userId, BULLETIN_TEST_USER);
  f.advance(3_001);
  await f.click(BULLETIN_LEAVE_ID);
  assert.deepEqual(f.writes, [[BULLETIN_TEST_USER, true], [BULLETIN_TEST_USER, false]]);
  assert.match(messageText(f.replies.at(-1)), /Bulletin pings are off/);
  assert.ok(JSON.stringify(f.replies.at(-1)).includes(BULLETIN_JOIN_ID));
  assert.equal(f.events[1]!.outcome, 'unsubscribed');
});

test('Bulletin denies legacy receipts, other members, public messages and invalid sources without role writes', async () => {
  for (const change of ['guild', 'channel', 'author', 'not_ready', 'disabled', 'owner', 'public', 'legacy', 'old-role']) {
    const f = bulletinFixture();
    f.useMessage('private-card', change !== 'public');
    f.raw.channelId = 'verification';
    f.raw.customId = BULLETIN_JOIN_ID;
    if (change === 'guild') f.raw.guildId = 'elsewhere';
    if (change === 'channel') f.raw.channelId = 'elsewhere';
    if (change === 'author') f.raw.message.author.id = 'someone';
    if (change === 'not_ready') f.setReady(false);
    if (change === 'disabled') f.deps.bulletin = () => undefined;
    if (change === 'owner') f.raw.user.id = '888888888888888888';
    if (change === 'legacy') { f.raw.customId = 'dvc:bulletin:v1:join'; f.raw.channelId = 'verification'; }
    if (change === 'old-role') f.raw.customId = bulletinActionId(BULLETIN_TEST_USER, '777777777777777777', 'join');
    await f.run();
    assert.deepEqual(f.writes, [], change);
    assert.equal(f.raw.deferred, false, change);
    assert.equal((f.replies[0] as { flags: number }).flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral, change);
    assert.match(messageText(f.replies[0]), /Bulletin unavailable/);
    assert.equal(f.events.length, 0, change); // Denials stay in the console.
  }
});

test('unverified members cannot opt in, but any member can opt out; unchanged states cause no write or Discord log', async () => {
  const unverified = bulletinFixture({ verified: false, subscribed: false, bot: false });
  await unverified.click(BULLETIN_JOIN_ID);
  assert.deepEqual(unverified.writes, []);
  assert.match(messageText(unverified.replies.at(-1)), /Verify first/);
  assert.equal(JSON.stringify(unverified.replies.at(-1)).includes('dvc:bulletin'), false);
  assert.equal(unverified.events.length, 0);
  const lapsed = bulletinFixture({ verified: false, subscribed: true, bot: false });
  await lapsed.click(BULLETIN_LEAVE_ID);
  assert.deepEqual(lapsed.writes, [[BULLETIN_TEST_USER, false]]);
  assert.match(messageText(lapsed.replies.at(-1)), /Bulletin pings are off/);
  assert.equal(JSON.stringify(lapsed.replies.at(-1)).includes(BULLETIN_JOIN_ID), false);
  const already = bulletinFixture({ verified: true, subscribed: true, bot: false });
  await already.click(BULLETIN_JOIN_ID);
  assert.deepEqual(already.writes, []);
  assert.match(messageText(already.replies.at(-1)), /Bulletin pings are on/);
  assert.equal(already.events.length, 0);
});

test('rapid Bulletin presses stay private and leave the current preference card intact', async () => {
  const f = bulletinFixture();
  await f.click(BULLETIN_JOIN_ID);
  await f.click(BULLETIN_JOIN_ID);
  assert.deepEqual(f.writes, [[BULLETIN_TEST_USER, true]]);
  assert.match(messageText(f.replies.at(-1)), /Just a moment/);
  assert.ok(JSON.stringify(f.replies[1]).includes(BULLETIN_LEAVE_ID));
  assert.ok((f.replies.at(-1) as { flags: number }).flags & MessageFlags.Ephemeral);
  assert.equal(f.events.length, 1);
});

test('a failed Bulletin write is a critical operator log with generic private guidance and no changed-role event', async () => {
  const f = bulletinFixture();
  f.bulletinGateway.setRole = async () => { throw new Error('private request body'); };
  await f.click(BULLETIN_JOIN_ID);
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0]!.event, 'bulletin_failed');
  assert.equal(f.events[0]!.priority, 'critical');
  assert.equal(JSON.stringify(f.replies).includes('private request body'), false);
  assert.equal((f.replies.at(-1) as { flags: number }).flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  assert.match(messageText(f.replies.at(-1)), /Something went wrong/);
});

test('Bulletin setup errors keep their corrective message in operator logs only', async () => {
  const f = bulletinFixture();
  f.bulletinGateway.assertRoleAssignable = async () => { throw new SetupError('Move the dvc.services bot role above the Bulletin role.'); };
  await f.click(BULLETIN_JOIN_ID);
  assert.match(f.events[0]!.detail!, /above the Bulletin role/);
  assert.equal(messageText(f.replies).includes('above the Bulletin role'), false);
});

test('a lost Bulletin confirmation reply preserves the role change and its log', async () => {
  const f = bulletinFixture();
  f.raw.editReply = async () => { throw new Error('Unknown interaction'); };
  await f.click(BULLETIN_JOIN_ID);
  assert.deepEqual(f.writes, [[BULLETIN_TEST_USER, true]]);
  assert.equal(f.events[0]!.event, 'bulletin_updated');
  assert.equal(f.logs.some(([, event]) => event === 'interaction_reply_failed'), true);
  assert.equal(f.events.some(event => event.event === 'bulletin_failed'), false);
});

const hallAnswer: HallReply = { reply: 'Verification gives you access to dvc.labs.',
  webSearch: false, contextFresh: false, truncated: false, safety: undefined };

test('/ask defers in the chosen reply mode and keeps the question, answer and continuations in that mode', async () => {
  for (const privateReply of [false, true]) {
    const f = fixture('command');
    f.raw.commandName = 'ask'; f.raw.privateReply = privateReply; f.raw.resetContext = true;
    f.raw.user.id = BULLETIN_TEST_USER;
    f.raw.prompt = '  A private test question  ';
    f.deps.hall = { ask: async (scope, prompt, reset) => {
      assert.equal(f.raw.deferred, true);
      assert.equal(f.raw.ephemeral, privateReply);
      assert.deepEqual(scope, { guildId: 'guild', channelId: 'commands', userId: BULLETIN_TEST_USER, private: privateReply });
      assert.equal(prompt, 'A private test question');
      assert.equal(reset, true);
      return { ...hallAnswer, reply: hallAnswer.reply.repeat(100) };
    }, forget: async () => { assert.fail('Unexpected forget'); } };
    await f.run();
    assert.deepEqual(f.replies[0], privateReply ? { flags: MessageFlags.Ephemeral } : {});
    assert.match(messageText(f.replies[1]), /Your question\*\*\nA private test question[\s\S]+Answer\*\*\nVerification/);
    assert.ok(f.replies.length > 2);
    for (const reply of f.replies.slice(2)) {
      assert.equal((reply as { flags: number }).flags,
        MessageFlags.IsComponentsV2 | (privateReply ? MessageFlags.Ephemeral : 0));
    }
    for (const reply of f.replies.slice(1)) {
      assert.ok(JSON.stringify(reply).includes(hallForgetId(BULLETIN_TEST_USER, privateReply)));
    }
    assert.equal(f.events.length, 0);
    assert.ok(!JSON.stringify(f.logs).includes('A private test question'));
    assert.ok(!JSON.stringify(f.logs).includes(hallAnswer.reply));
  }
});

test('/ask validates its configuration, prompt, and server channel before contacting Hall', async () => {
  for (const invalid of ['guild', 'channel', 'disabled', 'blank', 'length']) {
    const f = fixture('command');
    f.raw.commandName = 'ask';
    if (invalid !== 'disabled') f.deps.hall = { ask: async () => { assert.fail('Unexpected Hall request'); }, forget: async () => {} };
    if (invalid === 'guild') f.raw.guildId = 'another';
    if (invalid === 'channel') f.raw.channelId = 'another';
    if (invalid === 'blank') f.raw.prompt = '   ';
    if (invalid === 'length') f.raw.prompt = 'x'.repeat(1_001);
    await f.run();
    assert.equal(f.raw.deferred, false, invalid);
    assert.equal(f.raw.ephemeral, true, invalid);
    assert.equal(f.replies.length, 1, invalid);
  }
});

test('a failed public /ask leaves no question or upstream error in the channel or the logs', async () => {
  const f = fixture('command');
  f.raw.commandName = 'ask'; f.raw.prompt = 'private test question';
  f.deps.hall = { ask: async () => { throw new HallError('access_denied', 403); }, forget: async () => {} };
  await f.run();
  assert.equal(f.deleted.length, 1);
  assert.match(messageText(f.replies[1]), /Request finished/);
  assert.equal((f.replies[2] as { flags: number }).flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
  assert.match(messageText(f.replies[2]), /Hall connection was refused/);
  assert.ok(!JSON.stringify([f.replies, f.logs]).includes(f.raw.prompt));
  assert.equal(f.events.length, 0);
  assert.ok(f.logs.some(([, event, fields]) => event === 'hall_request_failed' && fields?.status === 403));
});

function forgetFixture(privateReply: boolean) {
  const f = fixture();
  f.useMessage('hall-answer', privateReply);
  f.raw.channelId = 'commands';
  f.raw.user.id = BULLETIN_TEST_USER;
  f.raw.customId = hallForgetId(BULLETIN_TEST_USER, privateReply);
  f.raw.message.components = hallCards('A question', hallAnswer, '', BULLETIN_TEST_USER, privateReply)[0]!.components;
  return f;
}

test('Forget clears the conversation for its requester and reply mode, without editing the answer', async () => {
  for (const privateReply of [false, true]) {
    const f = forgetFixture(privateReply);
    f.deps.hall = { ask: async () => { assert.fail('Unexpected generation'); }, forget: async scope => {
      assert.equal(f.raw.ephemeral, true);
      assert.deepEqual(scope, { guildId: 'guild', channelId: 'commands', userId: BULLETIN_TEST_USER, private: privateReply });
    } };
    await f.run();
    assert.deepEqual(f.replies[0], { flags: MessageFlags.Ephemeral });
    assert.notEqual(f.raw.responseId, f.raw.message.id);
    assert.match(messageText(f.replies[1]), new RegExp(`${privateReply ? 'private' : 'public'} conversation context`));
    assert.ok(f.logs.some(([, event]) => event === 'hall_context_reset'));
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.deleted, []);
  }
});

test('Forget never clears a conversation from a different owner, guild, channel, author, or reply mode', async () => {
  for (const invalid of ['owner', 'guild', 'channel', 'author', 'visibility', 'missing_button', 'not_ready']) {
    const f = forgetFixture(false);
    f.deps.hall = { ask: async () => { assert.fail('Unexpected generation'); }, forget: async () => { assert.fail('Unexpected reset'); } };
    if (invalid === 'owner') f.raw.user.id = '888888888888888888';
    if (invalid === 'guild') f.raw.guildId = 'elsewhere';
    if (invalid === 'channel') f.raw.channelId = 'elsewhere';
    if (invalid === 'author') f.raw.message.author.id = 'elsewhere';
    if (invalid === 'visibility') f.raw.message.flags.add(MessageFlags.Ephemeral);
    if (invalid === 'missing_button') f.raw.message.components = [];
    if (invalid === 'not_ready') f.setReady(false);
    await f.run();
    assert.equal(f.raw.deferred, false, invalid);
    assert.equal(f.raw.ephemeral, true, invalid);
    assert.deepEqual(f.events, [], invalid);
  }
});

test('Cherry Creek command, form, and review route separately even outside the commands channel', async () => {
  const f = fixture('command');
  Object.assign(f.deps.config, { minecraftChannelId: 'minecraft', modChannelId: 'moderation' });
  const actions: string[] = [];
  f.deps.cherry = () => ({
    open: async () => { actions.push('open'); return 'form_opened'; },
    submit: async () => { actions.push('submit'); },
    review: async (_interaction: unknown, botId: string) => { actions.push('review:' + botId); },
  } as unknown as CherryCreek);
  f.raw.commandName = 'cherrycreek'; f.raw.channelId = 'minecraft';
  await f.run();
  f.raw.kind = 'modal'; f.raw.customId = CHERRY_MODAL_ID;
  await f.run();
  f.useMessage('staff-message'); f.raw.channelId = 'moderation'; f.raw.customId = CHERRY_REVIEW_PREFIX + 'example';
  await f.run();
  assert.deepEqual(actions, ['open', 'submit', 'review:bot']);
});
