import { randomUUID } from 'node:crypto';
import { Cooldown } from './policy.js';

export const MAX_HALL_PROMPT = 1_000;
const MAX_REPLY = 16_000;
const MAX_RESPONSE_BYTES = 128 * 1_024;
const TIMEOUT_MS = 80_000;

export interface HallScope { guildId: string; channelId: string; userId: string; private: boolean }

export interface HallReply {
  reply: string;
  webSearch: boolean;
  truncated: boolean;
  contextFresh: boolean;
  safety: 'checked' | 'redirected' | 'support' | undefined;
}

export interface HallCommands {
  ask(scope: HallScope, prompt: string, reset: boolean): Promise<HallReply>;
  forget(scope: HallScope): Promise<void>;
}

export class HallError extends Error {
  constructor(readonly kind: 'busy' | 'rate_limited' | 'access_denied' | 'unavailable',
    readonly status?: number, readonly reference?: string) {
    super(kind);
    this.name = 'HallError';
  }
}

async function responseObject(response: Response): Promise<Record<string, unknown> | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Never surface an upstream error body. */ }
  return undefined;
}

function referenceId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value : undefined;
}

// Hall owns moderation, model selection, web search and conversation storage.
// The bot has no transcript store and never retries a paid generation.
export class HallClient implements HallCommands {
  private readonly active = new Set<string>();
  private readonly cooldown: Cooldown;
  private readonly stopped = new AbortController();

  constructor(private readonly origin: string, private readonly apiKey: string,
    private readonly request: typeof fetch = fetch, now: () => number = Date.now) {
    this.cooldown = new Cooldown(12_000, now);
  }

  close(): void { this.stopped.abort(); }

  async ask(scope: HallScope, prompt: string, reset: boolean): Promise<HallReply> {
    if (!prompt.trim() || prompt.length > MAX_HALL_PROMPT) throw new HallError('unavailable');
    return this.run(scope, async (identity, signal) => {
      if (reset) await this.reset(identity, signal);
      const data = await this.send('/api/chat', { ...identity, prompt, request_id: randomUUID() }, signal);
      if (typeof data.reply !== 'string' || !data.reply.trim() || data.reply.length > MAX_REPLY || data.memory !== 'session') {
        throw new HallError('unavailable', 200, referenceId(data.request_id));
      }
      const { safety } = data;
      return { reply: data.reply, webSearch: data.web_search === true, truncated: data.truncated === true,
        contextFresh: data.context_fresh === true,
        safety: safety === 'checked' || safety === 'redirected' || safety === 'support' ? safety : undefined };
    });
  }

  forget(scope: HallScope): Promise<void> {
    return this.run(scope, (identity, signal) => this.reset(identity, signal));
  }

  private async run<T>(scope: HallScope, action: (identity: Record<string, string>, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopped.signal.aborted) throw new HallError('unavailable');
    if (this.active.has(scope.userId) || this.active.size >= 2) throw new HallError('busy');
    if (!this.cooldown.take(scope.userId)) throw new HallError('rate_limited');
    this.active.add(scope.userId);
    try {
      const signal = AbortSignal.any([this.stopped.signal, AbortSignal.timeout(TIMEOUT_MS)]);
      return await action({ source: 'discord', guild_id: scope.guildId, channel_id: scope.channelId,
        user_id: scope.userId, visibility: scope.private ? 'private' : 'public' }, signal);
    } finally { this.active.delete(scope.userId); }
  }

  private async reset(identity: Record<string, string>, signal: AbortSignal): Promise<void> {
    const data = await this.send('/api/reset', identity, signal);
    if (data.ok !== true) throw new HallError('unavailable', 200, referenceId(data.request_id));
  }

  private async send(path: '/api/chat' | '/api/reset', body: Record<string, string>, signal: AbortSignal) {
    let response: Response;
    let data: Record<string, unknown> | undefined;
    try {
      response = await this.request(new URL(path, this.origin), { method: 'POST', redirect: 'error', signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body) });
      data = await responseObject(response);
    } catch { throw new HallError('unavailable'); }
    const reference = referenceId(data?.request_id);
    if (response.status === 401 || response.status === 403) throw new HallError('access_denied', response.status, reference);
    if (response.status === 429) throw new HallError('rate_limited', response.status, reference);
    if (response.status === 409) throw new HallError('busy', response.status, reference);
    if (response.status !== 200 || !data) throw new HallError('unavailable', response.status, reference);
    return data;
  }
}
