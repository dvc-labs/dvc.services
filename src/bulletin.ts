import { Cooldown } from './policy.js';

export interface BulletinGateway {
  getMember(userId: string): Promise<{ verified: boolean; subscribed: boolean; bot: boolean }>;
  assertRoleAssignable(): Promise<void>;
  setRole(userId: string, subscribed: boolean): Promise<void>;
}

export type BulletinResult = 'subscribed' | 'unsubscribed' | 'already_subscribed' | 'already_unsubscribed'
  | 'not_verified' | 'bot' | 'processing' | 'cooldown';

// Optional news-ping role. Like verification, this port only ever changes the clicking
// member and one configured role; the caller never supplies a target or a role.
export class BulletinService {
  private readonly inFlight = new Set<string>();
  private readonly cooldown: Cooldown;

  constructor(private readonly gateway: BulletinGateway, now: () => number = Date.now) {
    this.cooldown = new Cooldown(3_000, now);
  }

  async set(userId: string, subscribe: boolean): Promise<BulletinResult> {
    if (this.inFlight.has(userId)) return 'processing';
    if (!this.cooldown.take(userId)) return 'cooldown';
    this.inFlight.add(userId);
    try {
      const member = await this.gateway.getMember(userId);
      if (member.bot) return 'bot';
      // Opting out is always allowed, even if the member has since lost the verification role.
      if (subscribe && !member.verified) return 'not_verified';
      if (member.subscribed === subscribe) return subscribe ? 'already_subscribed' : 'already_unsubscribed';
      await this.gateway.assertRoleAssignable();
      await this.gateway.setRole(userId, subscribe);
      return subscribe ? 'subscribed' : 'unsubscribed';
    } finally {
      this.inFlight.delete(userId);
    }
  }
}
