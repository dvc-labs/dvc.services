import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection, MessageFlags, PermissionFlagsBits, PermissionsBitField, type ButtonInteraction,
  type ChatInputCommandInteraction, type ModalSubmitInteraction, type TextChannel } from 'discord.js';
import { AuditLog, type AuditEvent } from '../src/audit.js';
import { CHERRY_MODAL_ID, CherryCreek } from '../src/cherry-creek.js';
import { Logger } from '../src/logger.js';
import { messageText, testConfig, TEST_MINECRAFT_CHANNEL_ID as MINECRAFT, TEST_MOD_CHANNEL_ID as MOD } from './helpers.js';

const APPLICANT = '777777777777777777';
const MODERATOR = '888888888888888888';
const MESSAGE = '999999999999999991';
const ANNOUNCEMENT = '999999999999999992';
const USERNAME = 'Cherry_Player';
const BUTTON = 'dvc:cherry:v1:review:accepted:' + APPLICANT + ':' + USERNAME;
type MessagePayload = { components: { toJSON(): unknown }[]; flags: number; allowedMentions?: unknown; nonce?: string; enforceNonce?: boolean };
type StaffMessage = { id: string; author: { id: string }; components: MessagePayload['components'] };

function fixture() {
  const config = { ...testConfig(), modChannelId: MOD, minecraftChannelId: MINECRAFT };
  const auditEvents: AuditEvent[] = [];
  const consoleLogs: unknown[] = [];
  const logger = new Logger('info', '');
  logger.write = (...args) => { consoleLogs.push(args); };
  const audit = new AuditLog(logger);
  audit.setSink(async event => { auditEvents.push(event); });
  const modPosts: MessagePayload[] = [];
  const announcements: MessagePayload[] = [];
  const edits: MessagePayload[] = [];
  const message: StaffMessage = { id: MESSAGE, author: { id: config.applicationId }, components: [] };
  const history = new Collection<string, StaffMessage>();
  const historyReads: (string | undefined)[] = [];
  const permissions = new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
  const options = {
    failAnnouncement: false, failDecision: false, failReceipt: false,
    async beforeEdit() {}, async beforeAnnounce() {}, async beforeHistory() {}, async beforeSend() {},
  };
  const mod = {
    id: MOD,
    permissionsFor: () => permissions,
    send: async (payload: MessagePayload) => {
      await options.beforeSend();
      const post = modPosts.length === 0 ? message : {
        id: String(BigInt(MESSAGE) + BigInt(modPosts.length) * 10n), author: { id: config.applicationId },
        components: payload.components,
      };
      modPosts.push(payload); post.components = payload.components;
      history.set(post.id, post);
      return post;
    },
    messages: {
      fetch: async ({ message: id, cache, force, limit, before }: {
        message?: string; cache: boolean; force?: boolean; limit?: number; before?: string
      }) => {
        assert.equal(cache, false);
        if (id) {
          assert.equal(force, true);
          return history.get(id);
        }
        assert.equal(limit, 100);
        historyReads.push(before);
        await options.beforeHistory();
        const sorted = [...history.values()].filter(item => !before || BigInt(item.id) < BigInt(before))
          .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, limit);
        return new Collection(sorted.map(item => [item.id, item]));
      },
      edit: async (_id: string, payload: MessagePayload) => {
        await options.beforeEdit();
        if (options.failDecision || (options.failReceipt && edits.length === 1)) throw new Error('private REST details');
        edits.push(payload); message.components = payload.components;
      },
    },
  };
  const minecraft = { id: MINECRAFT, send: async (payload: MessagePayload) => {
    await options.beforeAnnounce();
    if (options.failAnnouncement) throw new Error('private REST details');
    announcements.push(payload); return { id: ANNOUNCEMENT };
  } };
  let now = 1_800_000_000_000;
  const freshService = () => new CherryCreek(config, mod as unknown as TextChannel, minecraft as unknown as TextChannel, audit, () => now);
  const service = freshService();
  let interactionId = 777777777777777776n;
  function interaction() {
    const replies: unknown[] = [];
    const raw = {
      id: String(interactionId++), guildId: config.guildId, channelId: MINECRAFT,
      user: { id: APPLICANT, bot: false }, member: { roles: [config.verificationRoleId], pending: false },
      memberPermissions: new PermissionsBitField(), deferred: false,
      message: { id: MESSAGE, author: { id: config.applicationId } }, username: USERNAME, customId: BUTTON,
      fields: { getTextInputValue(id: string): string { assert.equal(id, 'java_username'); return raw.username; } },
      async reply(payload: unknown) { replies.push(payload); },
      async deferReply(payload: unknown) { raw.deferred = true; replies.push(payload); },
      async editReply(payload: unknown) { replies.push(payload); },
      async showModal(payload: { toJSON(): unknown }) { replies.push(payload.toJSON()); },
    };
    return { raw, replies, command: raw as unknown as ChatInputCommandInteraction,
      modal: raw as unknown as ModalSubmitInteraction, button: raw as unknown as ButtonInteraction };
  }
  function reviewer() {
    const r = interaction();
    r.raw.channelId = MOD; r.raw.user.id = MODERATOR;
    r.raw.memberPermissions.add(PermissionFlagsBits.ModerateMembers);
    return r;
  }
  return { service, freshService, modPosts, announcements, edits, interaction, reviewer, audit, auditEvents, consoleLogs,
    config, options, message, history, historyReads, permissions, advance: (ms: number) => { now += ms; },
    submit: async (activeService = service) => {
      const f = interaction(); await activeService.submit(f.modal); return f;
    } };
}

test('the command opens a username-only modal, and a valid submission goes privately to staff', async () => {
  const f = fixture();
  const request = f.interaction();
  assert.equal(await f.service.open(request.command), 'form_opened');
  const form = request.replies[0] as { custom_id: string; components: { label: string; component: { min_length: number; max_length: number } }[] };
  assert.equal(form.custom_id, CHERRY_MODAL_ID);
  assert.equal(form.components[0]!.label, 'Minecraft Java username');
  assert.equal(form.components[0]!.component.min_length, 3);
  assert.equal(form.components[0]!.component.max_length, 16);
  const receipt = await f.submit();
  await f.audit.flush();
  assert.deepEqual(receipt.replies[0], { flags: MessageFlags.Ephemeral });
  assert.match(messageText(receipt.replies[1]), /Request sent/);
  assert.equal(f.modPosts[0]!.flags, MessageFlags.IsComponentsV2);
  assert.match(messageText(f.modPosts[0]), /whitelist add Cherry_Player/);
  assert.ok(JSON.stringify(f.modPosts[0]).includes(BUTTON));
  assert.deepEqual(f.modPosts[0]!.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(f.modPosts[0]!.enforceNonce, true);
  assert.deepEqual(f.announcements, []);
  assert.equal(f.auditEvents[0]!.event, 'cherry_request_submitted');
  assert.ok(!JSON.stringify([f.auditEvents, f.consoleLogs]).includes(USERNAME));
});

test('submit rechecks access and channel and rejects invalid Java names before posting', async () => {
  for (const change of ['unverified', 'pending', 'bot', 'guild', 'channel', 'bad_name']) {
    const f = fixture();
    const r = f.interaction();
    assert.equal(await f.service.open(r.command), 'form_opened');
    if (change === 'unverified') r.raw.member.roles = [];
    if (change === 'pending') r.raw.member.pending = true;
    if (change === 'bot') r.raw.user.bot = true;
    if (change === 'guild') r.raw.guildId = 'different-guild';
    if (change === 'channel') r.raw.channelId = MOD;
    if (change === 'bad_name') r.raw.username = 'name; other';
    await f.service.submit(r.modal);
    assert.equal(r.raw.deferred, false, change);
    assert.equal(f.modPosts.length, 0, change);
    assert.ok((r.replies.at(-1) as { flags: number }).flags & MessageFlags.Ephemeral, change);
  }
});

test('the cooldown avoids additional history reads from immediate resubmissions', async () => {
  const f = fixture();
  await f.submit();
  const repeated = await f.submit();
  assert.equal(f.modPosts.length, 1);
  assert.equal(f.historyReads.length, 1);
  assert.match(messageText(repeated.replies[0]), /Please wait/);
});

test('an open request blocks a different username after cooldown and after restart past the first history page', async () => {
  const f = fixture();
  await f.submit();
  f.advance(60_001);
  const duplicate = f.interaction(); duplicate.raw.username = 'Another_Player';
  await f.service.submit(duplicate.modal);
  assert.match(messageText(duplicate.replies.at(-1)), /Request already pending/);
  for (let i = 1n; i <= 101n; i++) {
    const id = String(BigInt(MESSAGE) + i);
    f.history.set(id, { id, author: { id: MODERATOR }, components: f.message.components });
  }
  const afterRestart = await f.submit(f.freshService());
  await f.audit.flush();
  assert.match(messageText(afterRestart.replies.at(-1)), /Request already pending/);
  assert.ok(f.historyReads.at(-1));
  assert.equal(f.modPosts.length, 1);
  assert.equal(f.auditEvents.length, 1);
  assert.ok(f.consoleLogs.some(entry => Array.isArray(entry) && entry[1] === 'cherry_request_blocked'));
});

test('other members and closed requests do not block a new submission', async () => {
  const f = fixture();
  await f.submit();
  const other = f.interaction(); other.raw.user.id = '888888888888888886';
  await f.service.submit(other.modal);
  assert.match(messageText(other.replies.at(-1)), /Request sent/);
  const reviewer = f.reviewer(); reviewer.raw.customId = BUTTON.replace('accepted', 'declined');
  await f.service.review(reviewer.button, f.config.applicationId);
  f.advance(60_001);
  const resubmission = await f.submit();
  assert.match(messageText(resubmission.replies.at(-1)), /Request sent/);
  assert.equal(f.modPosts.length, 3);
});

test('a member cannot submit again while the first card is posting even after the cooldown', async () => {
  const f = fixture();
  let entered!: () => void;
  let release!: () => void;
  const posting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.options.beforeSend = async () => { entered(); await gate; };
  const first = f.submit();
  await posting;
  try {
    f.advance(60_001);
    const second = await f.submit();
    assert.match(messageText(second.replies[0]), /Please wait/);
  } finally { release(); await first; }
  assert.equal(f.historyReads.length, 1);
  assert.equal(f.modPosts.length, 1);
});

test('a lost history permission, failed fetch or expired history check never posts the request', async () => {
  for (const failure of ['permission', 'revoked', 'fetch', 'timeout']) {
    const f = fixture();
    if (failure === 'permission') f.permissions.remove(PermissionFlagsBits.ReadMessageHistory);
    if (failure === 'revoked') f.options.beforeHistory = async () => { f.permissions.remove(PermissionFlagsBits.ReadMessageHistory); };
    if (failure === 'fetch') f.options.beforeHistory = async () => { throw new Error('private REST details'); };
    if (failure === 'timeout') f.options.beforeHistory = async () => { f.advance(20_001); };
    const failed = await f.submit();
    await f.audit.flush();
    assert.match(messageText(failed.replies.at(-1)), /Request not sent/, failure);
    assert.equal(f.modPosts.length, 0, failure);
    assert.equal(f.auditEvents.length, 0, failure);
    assert.ok(!JSON.stringify(f.consoleLogs).includes('private REST details'));
  }
});

test('accept saves and closes the request before pinging only the applicant with the Java address', async () => {
  const f = fixture(); await f.submit();
  f.options.beforeAnnounce = async () => {
    assert.equal(f.edits.length, 1);
    assert.match(messageText(f.edits[0]), /Accepted/);
    assert.ok(!JSON.stringify(f.edits[0]).includes(BUTTON));
  };
  const reviewer = f.reviewer();
  await f.service.review(reviewer.button, f.config.applicationId);
  await f.audit.flush();
  assert.equal(f.announcements.length, 1);
  assert.deepEqual(f.announcements[0]!.allowedMentions, { parse: [], users: [APPLICANT], repliedUser: false });
  assert.ok(messageText(f.announcements[0]).includes('<@' + APPLICANT + '>'));
  assert.match(messageText(f.announcements[0]), /play\.cherrycreek\.app/);
  assert.ok(JSON.stringify(f.announcements[0]).includes('https://cherrycreek.app/'));
  assert.ok(!JSON.stringify(f.announcements[0]).includes(USERNAME));
  assert.match(messageText(f.edits[1]), /View approval/);
  assert.deepEqual(f.auditEvents.map(e => e.event), ['cherry_request_submitted', 'cherry_request_reviewed', 'cherry_notice_sent']);
  assert.equal(f.auditEvents[1]!.actorId, MODERATOR);
  assert.equal(f.auditEvents[1]!.targetUserId, APPLICANT);
  const stale = f.reviewer();
  await f.freshService().review(stale.button, f.config.applicationId);
  assert.match(messageText(stale.replies.at(-1)), /Request already closed/);
  assert.equal(f.announcements.length, 1);
});

test('declining closes the staff card without any public announcement', async () => {
  const f = fixture(); await f.submit();
  const r = f.reviewer(); r.raw.customId = BUTTON.replace('accepted', 'declined');
  await f.service.review(r.button, f.config.applicationId);
  assert.match(messageText(f.edits[0]), /Declined/);
  assert.equal(f.edits.length, 1);
  assert.deepEqual(f.announcements, []);
});

test('review requires current staff permissions and the matching open bot message in the moderation channel', async () => {
  for (const change of ['no_permission', 'channel', 'guild', 'author', 'different_button', 'forged_source']) {
    const f = fixture(); await f.submit();
    const r = f.reviewer();
    if (change === 'no_permission') r.raw.memberPermissions.remove(PermissionFlagsBits.ModerateMembers);
    if (change === 'channel') r.raw.channelId = MINECRAFT;
    if (change === 'guild') r.raw.guildId = 'unrelated';
    if (change === 'author') r.raw.message.author.id = 'other-bot';
    if (change === 'different_button') r.raw.customId = BUTTON.replace(USERNAME, 'OtherPlayer');
    if (change === 'forged_source') f.message.author.id = 'other-bot';
    await f.service.review(r.button, f.config.applicationId);
    assert.equal(f.edits.length, 0, change);
    assert.equal(f.announcements.length, 0, change);
  }
});

test('concurrent clicks close a request once and do not race a second announcement', async () => {
  const f = fixture(); await f.submit();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const editing = new Promise<void>(resolve => { entered = resolve; });
  f.options.beforeEdit = async () => { entered(); await gate; };
  const first = f.service.review(f.reviewer().button, f.config.applicationId);
  await editing;
  const second = f.reviewer();
  try {
    await f.service.review(second.button, f.config.applicationId);
    assert.match(messageText(second.replies[0]), /Review in progress/);
  } finally { release(); await first; }
  assert.equal(f.announcements.length, 1);
});

test('unconfirmed saves do not ping, and unconfirmed pings leave a closed card and safe diagnostics', async () => {
  const f = fixture(); await f.submit();
  f.options.failDecision = true;
  const unsaved = f.reviewer();
  await f.service.review(unsaved.button, f.config.applicationId);
  assert.match(messageText(unsaved.replies.at(-1)), /Review not confirmed/);
  assert.deepEqual(f.announcements, []);
  f.options.failDecision = false; f.options.failAnnouncement = true;
  const unsent = f.reviewer();
  await f.service.review(unsent.button, f.config.applicationId);
  await f.audit.flush();
  assert.match(messageText(f.edits[0]), /Delivery not confirmed yet/);
  assert.match(messageText(unsent.replies.at(-1)), /notification unconfirmed/);
  assert.ok(f.auditEvents.some(e => e.event === 'cherry_notice_failed' && e.priority === 'critical'));
  assert.ok(!JSON.stringify(f.consoleLogs).includes('private REST details'));
  f.options.failAnnouncement = false;
  await f.freshService().review(f.reviewer().button, f.config.applicationId);
  assert.equal(f.announcements.length, 0);
});

test('failure to update the receipt leaves the sent announcement available and never prompts a second ping', async () => {
  const f = fixture(); await f.submit();
  f.options.failReceipt = true;
  const r = f.reviewer();
  await f.service.review(r.button, f.config.applicationId);
  await f.audit.flush();
  assert.match(messageText(r.replies.at(-1)), /Request accepted/);
  assert.equal(f.announcements.length, 1);
  assert.ok(f.auditEvents.some(e => e.event === 'cherry_receipt_failed'));
  assert.ok(f.auditEvents.some(e => e.event === 'cherry_notice_sent'));
});
