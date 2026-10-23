import { Cooldown } from './policy.js';

export interface VerificationGateway {
  getMember(userId: string): Promise<{ hasRole: boolean; pending: boolean; bot: boolean }>;
  assertRoleAssignable(): Promise<void>;
  addRole(userId: string): Promise<void>;
}

export type VerificationResult = 'awarded' | 'already_verified' | 'screening_pending' | 'bot' | 'processing' | 'cooldown';

export class VerificationService {
  private readonly inFlight = new Set<string>();
  private readonly cooldown = new Cooldown();

  constructor(private readonly gateway: VerificationGateway) {}

  async verify(userId: string): Promise<VerificationResult> {
    if (this.inFlight.has(userId)) return 'processing';
    if (!this.cooldown.take(userId)) return 'cooldown';
    this.inFlight.add(userId);
    try {
      const member = await this.gateway.getMember(userId);
      if (member.bot) return 'bot';
      if (member.pending) return 'screening_pending';
      if (member.hasRole) return 'already_verified';
      await this.gateway.assertRoleAssignable();
      // This port only accepts the clicking user, never an arbitrary target or role.
      await this.gateway.addRole(userId);
      return 'awarded';
    } finally {
      this.inFlight.delete(userId);
    }
  }
}
