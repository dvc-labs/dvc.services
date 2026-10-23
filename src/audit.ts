import { channelMention, roleMention, userMention, type TextChannel } from 'discord.js';
import { errorSummary, type Logger } from './logger.js';
import { embed } from './ui.js';

export interface AuditEvent {
  event: string;
  title: string;
  outcome: string;
  userId?: string;
  channelId?: string;
  command?: string;
  roleId?: string;
  detail?: string;
}

export type AuditSink = (event: AuditEvent) => Promise<void>;

export function discordAuditSink(channel: TextChannel): AuditSink {
  return async event => {
    const fields = [{ name: 'Result', value: event.outcome }];
    if (event.userId) fields.push({ name: 'Member', value: userMention(event.userId) });
    if (event.channelId) fields.push({ name: 'Channel', value: channelMention(event.channelId) });
    if (event.command) fields.push({ name: 'Command', value: `/${event.command}` });
    if (event.roleId) fields.push({ name: 'Role', value: roleMention(event.roleId) });
    await channel.send({
      embeds: [embed(event.title, event.detail).addFields(fields).setTimestamp()],
      allowedMentions: { parse: [] },
    });
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
      command: event.command, roleId: event.roleId, detail: event.detail,
    });
    if (!this.sink) return;
    if (this.queue.length >= 100) {
      this.logger.write('warn', 'audit_queue_full', { outcome: 'Discord copy dropped; console copy retained' });
      return;
    }
    this.queue.push(event);
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
