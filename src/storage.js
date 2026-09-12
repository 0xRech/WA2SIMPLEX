import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class BridgeStore {
  constructor(path = './data/wa2simplex.db') {
    this.path = path === ':memory:' ? path : resolve(path);
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path, { timeout: 5000 });
    this.#migrate();
  }

  #migrate() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    if (this.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        phone TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        simplex_group_id INTEGER UNIQUE,
        ready INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_processed_messages_seen_at
        ON processed_messages(seen_at);
    `);
  }

  claimMessage(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return false;
    const result = this.db.prepare(
      'INSERT OR IGNORE INTO processed_messages(message_id, seen_at) VALUES (?, ?)'
    ).run(id, Date.now());
    return result.changes === 1;
  }

  pruneProcessedMessages(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const threshold = Date.now() - maxAgeMs;
    return this.db.prepare('DELETE FROM processed_messages WHERE seen_at < ?').run(threshold).changes;
  }

  upsertContact(phone, displayName, { touch = true } = {}) {
    // The legacy "phone" column is a route key: phone number OR full @g.us JID.
    // Keeping the existing primary key preserves all direct-chat mappings on upgrade.
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO contacts(phone, display_name, created_at, updated_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET
        display_name = excluded.display_name,
        updated_at = excluded.updated_at,
        last_seen_at = CASE WHEN excluded.last_seen_at IS NULL THEN contacts.last_seen_at ELSE excluded.last_seen_at END
    `).run(String(phone), cleanName(displayName, phone), now, now, touch ? now : null);
    return this.getContact(phone);
  }

  getContact(phone) {
    return mapContact(this.db.prepare('SELECT * FROM contacts WHERE phone = ?').get(String(phone)));
  }

  getByGroupId(groupId) {
    return mapContact(this.db.prepare('SELECT * FROM contacts WHERE simplex_group_id = ?').get(Number(groupId)));
  }

  bindGroup(phone, groupId) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE contacts
      SET simplex_group_id = ?, ready = 0, archived = 0, updated_at = ?
      WHERE phone = ?
    `).run(Number(groupId), now, String(phone));
    return this.getContact(phone);
  }

  clearGroup(phone) {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE contacts
      SET simplex_group_id = NULL, ready = 0, updated_at = ?
      WHERE phone = ?
    `).run(now, String(phone));
    return this.getContact(phone);
  }

  setReadyByGroup(groupId, ready = true) {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE contacts SET ready = ?, updated_at = ? WHERE simplex_group_id = ?')
      .run(ready ? 1 : 0, now, Number(groupId));
    return this.getByGroupId(groupId);
  }

  setArchived(phone, archived = true) {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE contacts SET archived = ?, updated_at = ? WHERE phone = ?')
      .run(archived ? 1 : 0, now, String(phone));
    return this.getContact(phone);
  }

  rename(phone, displayName) {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE contacts SET display_name = ?, updated_at = ? WHERE phone = ?')
      .run(cleanName(displayName, phone), now, String(phone));
    return this.getContact(phone);
  }

  listContacts(limit = 100) {
    return this.db.prepare(`
      SELECT * FROM contacts
      ORDER BY archived ASC, COALESCE(last_seen_at, updated_at) DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(Number(limit) || 100, 500))).map(mapContact);
  }

  stats() {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived,
        SUM(CASE WHEN ready = 1 THEN 1 ELSE 0 END) AS ready
      FROM contacts
    `).get();
    return {
      total: Number(row?.total || 0),
      active: Number(row?.active || 0),
      archived: Number(row?.archived || 0),
      ready: Number(row?.ready || 0)
    };
  }

  close() {
    if (this.db?.isOpen) this.db.close();
  }
}

function mapContact(row) {
  if (!row) return null;
  return {
    phone: row.phone,
    displayName: row.display_name,
    simplexGroupId: row.simplex_group_id == null ? null : Number(row.simplex_group_id),
    ready: Boolean(row.ready),
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at
  };
}

function cleanName(value, fallback) {
  const name = String(value || fallback || 'WhatsApp').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return name.slice(0, 120) || String(fallback || 'WhatsApp');
}
