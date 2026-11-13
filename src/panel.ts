import { SetupError } from './errors.js';
export type PanelKind = 'verification' | 'bulletin';

export interface PanelMessage {
  id: string;
  authorId: string;
  kind: PanelKind | undefined;
}

export interface PanelRepository {
  get(id: string): Promise<PanelMessage | null>;
  list(before: string | undefined): Promise<PanelMessage[]>;
  update(id: string): Promise<void>;
  create(): Promise<string>;
  retireBulletin(id: string): Promise<void>;
}

export interface VerificationPanelResult { id: string; created: boolean; retiredBulletinCards: number }

export async function ensureVerificationPanel(
  repository: PanelRepository, botId: string, preferredId?: string, retireBulletin = true,
): Promise<VerificationPanelResult> {
  let verificationId: string | undefined;
  if (preferredId) {
    const message = await repository.get(preferredId);
    if (!message || message.authorId !== botId || message.kind !== 'verification') {
      throw new SetupError('VERIFICATION_MESSAGE_ID must identify an existing verification panel sent by this bot.');
    }
    verificationId = message.id;
  }

  let before: string | undefined;
  let retiredBulletinCards = 0;
  while (!verificationId || retireBulletin) {
    const messages = await repository.list(before);
    if (messages.length === 0) break;
    for (const message of messages) {
      if (message.authorId !== botId) continue;
      if (message.kind === 'verification') verificationId ??= message.id;
      if (retireBulletin && message.kind === 'bulletin') {
        await repository.retireBulletin(message.id);
        retiredBulletinCards++;
      }
    }
    const next = messages.at(-1)!.id;
    if (next === before) throw new SetupError('Verification history pagination did not advance.');
    before = next;
  }
  if (!verificationId) return { id: await repository.create(), created: true, retiredBulletinCards };
  await repository.update(verificationId);
  return { id: verificationId, created: false, retiredBulletinCards };
}
