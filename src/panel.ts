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
  update(id: string, kind: PanelKind): Promise<void>;
  create(kind: PanelKind): Promise<string>;
}

interface PanelResult { id: string; created: boolean }
export interface VerificationPanels { verification: PanelResult; bulletin?: PanelResult }

export async function ensureVerificationPanels(
  repository: PanelRepository,
  botId: string,
  bulletinEnabled: boolean,
  preferredId?: string,
): Promise<VerificationPanels> {
  const found: Partial<Record<PanelKind, string>> = {};

  if (preferredId) {
    const message = await repository.get(preferredId);
    if (!message || message.authorId !== botId || message.kind !== 'verification') {
      throw new SetupError('VERIFICATION_MESSAGE_ID must identify an existing verification panel sent by this bot.');
    }
    found.verification = message.id;
  }

  // Find both cards in a single history walk, including a Bulletin card we need to disable.
  let before: string | undefined;
  while (!found.verification || !found.bulletin) {
    const messages = await repository.list(before);
    for (const message of messages) {
      if (message.authorId === botId && message.kind && !found[message.kind]) {
        found[message.kind] = message.id;
      }
    }
    if (messages.length === 0 || (found.verification && found.bulletin)) break;
    const next = messages.at(-1)!.id;
    if (next === before) throw new SetupError('Verification history pagination did not advance.');
    before = next;
  }
  async function ensure(kind: PanelKind): Promise<PanelResult> {
    const id = found[kind];
    if (!id) return { id: await repository.create(kind), created: true };
    await repository.update(id, kind);
    return { id, created: false };
  }
  const verification = await ensure('verification');
  if (bulletinEnabled) return { verification, bulletin: await ensure('bulletin') };
  if (found.bulletin) await repository.update(found.bulletin, 'bulletin');
  return { verification };
}
