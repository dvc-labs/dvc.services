import { channelMention, roleMention, userMention, type TextChannel } from 'discord.js';
import { errorSummary, type Logger } from './logger.js';
import { card, humanise, type CardField } from './ui.js';

export interface AuditEvent {
  event: string;
  title: string;
  outcome: string;
  userId?: string;
  channelId?: string;
  command?: string;
  durationMs?: number;
  roleId?: string;
  actorId?: string;
  targetUserId?: string;
  fields?: CardField[];
  detail?: string;
  // Defaults to true; false retains the console copy without queueing a Discord post.
  discord?: boolean;
  // Successes have reserved capacity, but cannot consume failure/lifecycle slots.
  priority?: 'routine' | 'important' | 'critical';
}

export type AuditSink = (event: AuditEvent) => Promise<void>;
const priorityRank = (event: AuditEvent): number => event.priority === 'critical' ? 2 : event.priority === 'important' ? 1 : 0;

export function discordAuditSink(channel: TextChannel): AuditSink {
  return async event => {
    const fields = [{ name: 'Result', value: humanise(event.outcome) }];
    if (event.userId) fields.push({ name: 'Member', value: userMention(event.userId) });
    if (event.channelId) fields.push({ name: 'Channel', value: channelMention(event.channelId) });
    if (event.command) fields.push({ name: 'Command', value: `/${event.command}` });
    if (event.durationMs !== undefined) fields.push({ name: 'Handled in', value: `${event.durationMs} ms` });
    if (event.roleId) fields.push({ name: 'Role', value: roleMention(event.roleId) });
    if (event.actorId) fields.push({ name: 'Performed by', value: userMention(event.actorId) });
    if (event.targetUserId) fields.push({ name: 'Target member', value: userMention(event.targetUserId) });
    if (event.fields) fields.push(...event.fields);
    await channel.send(card(event.title, event.detail, fields,
      { footer: `<t:${Math.floor(Date.now() / 1_000)}:f>` }));
  };
}

export class AuditLog {
  private sink: AuditSink | undefined;
  private readonly queue: AuditEvent[] = [];
  private draining: Promise<void> | undefined;

  constructor(private readonly logger: Logger) {}

  setSink(sink: AuditSink): void { this.sink = sink; }

  record(event: AuditEvent): void {
    this.logger.write('info', event.event, {
      outcome: event.outcome, userId: event.userId, channelId: event.channelId,
      command: event.command, durationMs: event.durationMs, roleId: event.roleId, detail: event.detail,
      actorId: event.actorId, targetUserId: event.targetUserId,
      context: event.fields?.map(field => `${field.name}: ${field.value}`).join(' | '),
    });
    if (!this.sink || event.discord === false) return;
    const rank = priorityRank(event);
    const nonCritical = this.queue.filter(queued => priorityRank(queued) < 2).length;
    const routine = this.queue.filter(queued => priorityRank(queued) === 0).length;
    if (rank === 0 && (routine >= 60 || nonCritical >= 80 || this.queue.length >= 100)) {
      this.logger.write('warn', 'audit_queue_full', { outcome: 'Discord copy dropped; console copy retained' });
      return;
    }
    if (this.queue.length >= 100 || (rank === 1 && nonCritical >= 80)) {
      // Evict the oldest record from the lowest available tier, never a peer or higher tier.
      let replace = -1;
      for (let tier = 0; tier < rank && replace === -1; tier++) {
        replace = this.queue.findIndex(queued => priorityRank(queued) === tier);
      }
      if (replace === -1) {
        this.logger.write('warn', 'audit_queue_full', { outcome: 'Discord copy dropped; console copy retained' });
        return;
      }
      this.queue.splice(replace, 1);
      this.logger.write('warn', 'audit_lower_priority_evicted', { outcome: 'Higher-priority record retained; console copies retained' });
    }
    const firstLower = this.queue.findIndex(queued => priorityRank(queued) < rank);
    if (firstLower !== -1) this.queue.splice(firstLower, 0, event);
    else this.queue.push(event);
    this.startDrain();
  }

  private startDrain(): void {
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
      if (this.queue.length) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const event = this.queue.shift()!;
      try { await this.sink!(event); }
      catch (error) {
        this.logger.write('warn', 'discord_audit_failed', { error: errorSummary(error), eventName: event.event });
      }
    }
  }

  async flush(): Promise<void> { while (this.draining) await this.draining; }
}
