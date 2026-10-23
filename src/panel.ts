import { SetupError } from './errors.js';
export interface PanelMessage {
  id: string;
  authorId: string;
  isVerificationPanel: boolean;
}

export interface PanelRepository {
  get(id: string): Promise<PanelMessage | null>;
  list(before: string | undefined): Promise<PanelMessage[]>;
  update(id: string): Promise<void>;
  create(): Promise<string>;
}

export async function ensureVerificationPanel(
  repository: PanelRepository,
  botId: string,
  preferredId?: string,
): Promise<{ id: string; created: boolean }> {
  const ownedPanel = (message: PanelMessage): boolean =>
    message.authorId === botId && message.isVerificationPanel;

  if (preferredId) {
    const message = await repository.get(preferredId);
    if (!message || !ownedPanel(message)) {
      throw new SetupError('VERIFICATION_MESSAGE_ID must identify an existing verification panel sent by this bot.');
    }
    await repository.update(message.id);
    return { id: message.id, created: false };
  }

  // Search all pages, not just the last 100 messages, to avoid restart duplicates.
  // Each page is discarded before the next request; messages are not cached.
  let before: string | undefined;
  for (;;) {
    const messages = await repository.list(before);
    const existing = messages.find(ownedPanel);
    if (existing) {
      await repository.update(existing.id);
      return { id: existing.id, created: false };
    }
    if (messages.length === 0) break;
    const next = messages.at(-1)!.id;
    if (next === before) throw new SetupError('Verification history pagination did not advance.');
    before = next;
  }
  return { id: await repository.create(), created: true };
}
