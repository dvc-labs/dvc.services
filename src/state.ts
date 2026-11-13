import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SetupError } from './errors.js';

const DATABASE_NAME = 'dvc-services.sqlite';

interface ApprovalKey { guildId: string; requestId: string }
export interface CherryApproval extends ApprovalKey {
  applicantId: string;
  moderatorId: string;
  roleId: string;
  approvedAt: number;
}

export interface CherryApprovalStore {
  get(key: ApprovalKey): SavedCherryApproval | undefined;
  begin(approval: CherryApproval): void;
  cancelUnconfirmed(key: ApprovalKey): void;
  confirmRole(key: ApprovalKey): void;
  recordNotice(key: ApprovalKey, messageId: string): void;
}

export interface SavedCherryApproval extends CherryApproval {
  roleConfirmed: boolean;
  announcementId: string | null;
}

// Keep state on the volume, separate from code and from Hall conversation storage.
export class BotState implements CherryApprovalStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    const path = join(dataDir, DATABASE_NAME);
    let db: DatabaseSync | undefined;
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const existing = lstatSync(path, { throwIfNoEntry: false });
      if (existing && !existing.isFile()) throw new Error('Invalid state file');
      if (existing) chmodSync(path, 0o600);
      db = new DatabaseSync(path);
      chmodSync(path, 0o600);
      db.exec('PRAGMA busy_timeout = 1000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      db.exec(
        'CREATE TABLE IF NOT EXISTS bot_meta (key TEXT PRIMARY KEY) STRICT;' +
        'CREATE TABLE IF NOT EXISTS cherry_approvals (' +
        'guild_id TEXT NOT NULL, request_id TEXT NOT NULL, applicant_id TEXT NOT NULL, ' +
        'moderator_id TEXT NOT NULL, role_id TEXT NOT NULL, approved_at INTEGER NOT NULL, ' +
        'role_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (role_confirmed IN (0, 1)), announcement_id TEXT, ' +
        'PRIMARY KEY (guild_id, request_id)) STRICT;'
      );
    } catch (error) {
      try { db?.close(); } catch { /* Keep the setup error useful. */ }
      throw new SetupError('Could not open the bot database. Check that DATA_DIR is a writable persistent directory.', { cause: error });
    }
    this.db = db;
  }

  hasMarker(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM bot_meta WHERE key = ?').get(key);
  }

  mark(key: string): void {
    this.db.prepare('INSERT OR IGNORE INTO bot_meta (key) VALUES (?)').run(key);
  }

  get(key: ApprovalKey): SavedCherryApproval | undefined {
    const row = this.db.prepare(
      'SELECT applicant_id, moderator_id, role_id, approved_at, role_confirmed, announcement_id ' +
      'FROM cherry_approvals WHERE guild_id = ? AND request_id = ?',
    ).get(key.guildId, key.requestId);
    if (!row) return undefined;
    return { ...key, applicantId: String(row.applicant_id), moderatorId: String(row.moderator_id), roleId: String(row.role_id),
      approvedAt: Number(row.approved_at), roleConfirmed: row.role_confirmed === 1,
      announcementId: typeof row.announcement_id === 'string' ? row.announcement_id : null };
  }

  begin(approval: CherryApproval): void {
    this.db.prepare(
      'INSERT INTO cherry_approvals (guild_id, request_id, applicant_id, moderator_id, role_id, approved_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(approval.guildId, approval.requestId, approval.applicantId, approval.moderatorId, approval.roleId, approval.approvedAt);
  }

  cancelUnconfirmed(key: ApprovalKey): void {
    const { changes } = this.db.prepare(
      'DELETE FROM cherry_approvals WHERE guild_id = ? AND request_id = ? AND role_confirmed = 0 AND announcement_id IS NULL',
    ).run(key.guildId, key.requestId);
    if (changes !== 1) throw new Error('Unconfirmed approval record missing');
  }

  confirmRole(key: ApprovalKey): void {
    const { changes } = this.db.prepare('UPDATE cherry_approvals SET role_confirmed = 1 WHERE guild_id = ? AND request_id = ?')
      .run(key.guildId, key.requestId);
    if (changes !== 1) throw new Error('Approval record missing');
  }

  recordNotice(key: ApprovalKey, messageId: string): void {
    const { changes } = this.db.prepare(
      'UPDATE cherry_approvals SET announcement_id = ? WHERE guild_id = ? AND request_id = ? AND role_confirmed = 1',
    ).run(messageId, key.guildId, key.requestId);
    if (changes !== 1) throw new Error('Confirmed approval record missing');
  }

  close(): void { this.db.close(); }
}
