import { userMention, type Message, type PartialMessage } from 'discord.js';
import type { AuditLog } from './audit.js';
import type { Config } from './config.js';
import { brandedTitle, discordTime, displayText, type CardField } from './ui.js';

const MAX_RECENT_MESSAGES = 1_000;
const MAX_COPY_POINTS = 500;
type ObservedMessage = Message | PartialMessage;

interface MessageSnapshot {
  authorId: string | undefined;
  ignored: boolean;
  editedAt: number | null;
  text: string | undefined;
}

interface Dependencies {
  config: Pick<Config, 'guildId' | 'logsChannelId' | 'messageLogContent' | 'emoji'>;
  audit: AuditLog;
  isReady: () => boolean;
}

function excerpt(text: string): string {
  const points = Array.from(text);
  if (!text.trim()) return '*No text in this message.*';
  return displayText(points.slice(0, MAX_COPY_POINTS).join(''), MAX_COPY_POINTS)
    + (points.length > MAX_COPY_POINTS ? '\n… *(Text shortened)*' : '');
}

export class MessageActivity {
  // Keep only small excerpts and metadata. discord.js's normal message cache stays off.
  private readonly recent = new Map<string, MessageSnapshot>();

  constructor(private readonly deps: Dependencies) {}

  private accepts(message: ObservedMessage): boolean {
    const { config, isReady } = this.deps;
    if (!isReady() || message.guildId !== config.guildId || message.channelId === config.logsChannelId) return false;
    const channel = message.channel;
    return !channel?.isThread() || channel.parentId !== config.logsChannelId;
  }

  private snapshot(message: ObservedMessage, previous?: MessageSnapshot): MessageSnapshot {
    const ignored = previous?.ignored === true || !!(message.author?.bot || message.webhookId || message.system);
    return {
      authorId: message.author?.id ?? previous?.authorId,
      ignored,
      editedAt: message.editedTimestamp ?? previous?.editedAt ?? null,
      text: this.deps.config.messageLogContent && !ignored
        ? typeof message.content === 'string' ? excerpt(message.content) : previous?.text
        : undefined,
    };
  }

  private remember(id: string, snapshot: MessageSnapshot): void {
    this.recent.delete(id);
    this.recent.set(id, snapshot);
    if (this.recent.size > MAX_RECENT_MESSAGES) this.recent.delete(this.recent.keys().next().value!);
  }

  private author(snapshot: MessageSnapshot): CardField {
    return { name: 'Message author', value: snapshot.authorId ? userMention(snapshot.authorId) : 'Unavailable' };
  }

  created(message: Message): void {
    if (this.accepts(message) && !this.recent.has(message.id)) this.remember(message.id, this.snapshot(message));
  }

  updated(before: ObservedMessage, after: ObservedMessage): void {
    if (!this.accepts(after)) return;
    const previous = this.recent.get(after.id) ?? this.snapshot(before);
    const editedAt = after.editedTimestamp;
    // Pin changes and link previews also trigger message updates. Only log a new edit timestamp.
    if (!editedAt || !Number.isFinite(editedAt) || editedAt <= (previous.editedAt ?? 0)) return;
    // An uncached embed-only update can repeat an old edit timestamp without carrying the author or text.
    if (!previous.authorId && !after.author && typeof after.content !== 'string') return;
    const current = this.snapshot(after, previous);
    this.remember(after.id, current);
    if (current.ignored) return;
    const link = 'https://discord.com/channels/' + after.guildId + '/' + after.channelId + '/' + after.id;
    this.deps.audit.record({ event: 'message_edited', title: brandedTitle('Message edited', this.deps.config.emoji),
      outcome: 'edited', channelId: after.channelId, fields: [this.author(current),
        { name: 'Message', value: '[Open message](' + link + ') · `' + after.id + '`' },
        { name: 'Edited at', value: discordTime(editedAt) }],
      ...(this.deps.config.messageLogContent ? { discordFields: [
        { name: 'Before', value: previous.text ?? '*Previous text unavailable.*' },
        { name: 'After', value: (typeof after.content === 'string' ? current.text : undefined) ?? '*Edited text unavailable.*' },
      ] } : {}),
    });
  }

  private takeDeleted(message: ObservedMessage): MessageSnapshot | undefined {
    if (!this.accepts(message)) return undefined;
    const snapshot = this.snapshot(message, this.recent.get(message.id));
    this.recent.delete(message.id);
    return snapshot.ignored ? undefined : snapshot;
  }

  deleted(message: ObservedMessage): void {
    const snapshot = this.takeDeleted(message);
    if (!snapshot) return;
    this.deps.audit.record({ event: 'message_deleted', title: brandedTitle('Message deleted', this.deps.config.emoji),
      outcome: 'deleted', channelId: message.channelId,
      fields: [this.author(snapshot), { name: 'Message ID', value: '`' + message.id + '`' }],
      ...(this.deps.config.messageLogContent ? { discordFields: [
        { name: 'Deleted text', value: snapshot.text ?? '*Text unavailable; the bot did not have a copy.*' },
      ] } : {}),
    });
  }

  bulkDeleted(messages: Iterable<ObservedMessage>, channelId: string): void {
    let count = 0;
    const copies: CardField[] = [];
    for (const message of messages) {
      const snapshot = this.takeDeleted(message);
      if (!snapshot) continue;
      count++;
      if (snapshot.text !== undefined && copies.length < 2) {
        copies.push({ name: 'Deleted message ' + message.id, value: this.author(snapshot).value + '\n' + snapshot.text });
      }
    }
    if (!count) return;
    this.deps.audit.record({ event: 'messages_bulk_deleted', title: brandedTitle('Messages deleted in bulk', this.deps.config.emoji),
      outcome: 'deleted', channelId, fields: [{ name: 'Messages', value: String(count) }],
      ...(this.deps.config.messageLogContent ? { discordFields: [
        ...copies,
        { name: 'Text copies', value: copies.length ? `Showing ${copies.length} of ${count} messages (up to two cached copies).`
          : 'No cached text was available.' },
      ] } : {}),
    });
  }
}
