import type { Config } from '../src/config.js';
import { DVC_EMOJI } from '../src/version.js';

export function messageText(payload: unknown): string {
  const data: unknown = JSON.parse(JSON.stringify(payload));
  function walk(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap(walk);
    const result: string[] = [];
    if ('content' in value && typeof value.content === 'string') result.push(value.content);
    for (const [key, item] of Object.entries(value)) if (key !== 'content') result.push(...walk(item));
    return result;
  }
  return walk(data).join('\n');
}

export function testConfig(): Config {
  return { token: 'test-token', guildId: '111111111111111111', applicationId: '222222222222222222',
    verificationRoleId: '333333333333333333', adminRoleId: undefined, verificationChannelId: '444444444444444444',
    commandsChannelId: '555555555555555555', logsChannelId: '666666666666666666',
    verificationMessageId: undefined, bulletinRoleId: undefined, hallWorkerUrl: undefined, hallApiKey: undefined,
    port: 8080, logLevel: 'error', emoji: DVC_EMOJI };
}
