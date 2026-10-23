import type { LogLevel } from './config.js';

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
type Fields = Record<string, string | number | boolean | undefined>;

// Discord errors can carry request bodies, headers, and interaction tokens.
// Only retain a small, explicitly selected diagnostic summary.
export function errorSummary(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  const typed = error as Error & { code?: unknown; status?: unknown };
  const name = /^[\w.]{1,64}$/.test(typed.name) ? typed.name : 'Error';
  const code = typeof typed.code === 'number' ? ` code=${typed.code}` : '';
  const status = typeof typed.status === 'number' ? ` status=${typed.status}` : '';
  return `${name}${code}${status}`;
}

export class Logger {
  constructor(private readonly level: LogLevel, private readonly secret: string) {}

  write(level: LogLevel, event: string, fields: Fields = {}): void {
    if (priorities[level] < priorities[this.level]) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
    const redacted = this.secret ? line.replaceAll(this.secret, '[REDACTED]') : line;
    if (level === 'error') console.error(redacted);
    else if (level === 'warn') console.warn(redacted);
    else console.log(redacted);
  }
}
