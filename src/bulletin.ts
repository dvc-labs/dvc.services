import { Cooldown } from './policy.js';

export interface BulletinMember { verified: boolean; subscribed: boolean; bot: boolean }

export interface BulletinGateway {
  getMember(userId: string): Promise<BulletinMember>;
  assertRoleAssignable(): Promise<void>;
  setRole(userId: string, subscribed: boolean): Promise<void>;
}

export type BulletinStatus = 'on' | 'off' | 'not_verified' | 'bot';
export type BulletinResult =
  | { outcome: 'subscribed' | 'unsubscribed' | 'already_subscribed' | 'already_unsubscribed' | 'not_verified' | 'bot'; status: BulletinStatus }
  | { outcome: 'processing' | 'cooldown'; status?: never };

function memberStatus(member: BulletinMember): BulletinStatus {
  if (member.bot) return 'bot';
  if (member.subscribed) return 'on'; // Members who lost access can still opt out.
  return member.verified ? 'off' : 'not_verified';
}

// Optional news-ping role. Like verification, this port only ever changes the clicking
// member and one configured role; the caller never supplies a target or a role.
export class BulletinService {
  private readonly inFlight = new Set<string>();
  private readonly cooldown: Cooldown;

  constructor(private readonly gateway: BulletinGateway, now: () => number = Date.now) {
    this.cooldown = new Cooldown(3_000, now);
  }

  async status(userId: string): Promise<BulletinStatus> {
    return memberStatus(await this.gateway.getMember(userId));
  }

  async set(userId: string, subscribe: boolean): Promise<BulletinResult> {
    if (this.inFlight.has(userId)) return { outcome: 'processing' };
    if (!this.cooldown.take(userId)) return { outcome: 'cooldown' };
    this.inFlight.add(userId);
    try {
      const member = await this.gateway.getMember(userId);
      const status = memberStatus(member);
      if (member.bot) return { outcome: 'bot', status };
      // Opting out is always allowed, even if the member has since lost the verification role.
      if (subscribe && !member.verified) return { outcome: 'not_verified', status };
      if (member.subscribed === subscribe) {
        return { outcome: subscribe ? 'already_subscribed' : 'already_unsubscribed', status };
      }
      await this.gateway.assertRoleAssignable();
      await this.gateway.setRole(userId, subscribe);
      return { outcome: subscribe ? 'subscribed' : 'unsubscribed', status: memberStatus({ ...member, subscribed: subscribe }) };
    } finally {
      this.inFlight.delete(userId);
    }
  }
}
