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

      CREATE TABLE IF NOT EXISTS discovered_groups (
        whatsapp_jid TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        announced_at TEXT
      );

      CREATE TABLE IF NOT EXISTS group_bridges (
        whatsapp_jid TEXT PRIMARY KEY,
        simplex_group_id INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        whatsapp_to_simplex INTEGER NOT NULL DEFAULT 1,
        simplex_to_whatsapp INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_discovered_groups_last_seen_at
        ON discovered_groups(last_seen_at);
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

  observeWhatsAppGroup(whatsappJid, displayName) {
    const jid = String(whatsappJid || '').trim();
    const existing = this.getDiscoveredGroup(jid);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO discovered_groups(whatsapp_jid, display_name, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(whatsapp_jid) DO UPDATE SET
        display_name = excluded.display_name,
        last_seen_at = excluded.last_seen_at
    `).run(jid, cleanName(displayName, jid), now, now);
    return { group: this.getDiscoveredGroup(jid), isNew: !existing };
  }

  getDiscoveredGroup(whatsappJid) {
    return mapDiscoveredGroup(this.db.prepare(
      'SELECT * FROM discovered_groups WHERE whatsapp_jid = ?'
    ).get(String(whatsappJid || '').trim()));
  }

  markDiscoveredGroupAnnounced(whatsappJid) {
    this.db.prepare('UPDATE discovered_groups SET announced_at = ? WHERE whatsapp_jid = ?')
      .run(new Date().toISOString(), String(whatsappJid || '').trim());
    return this.getDiscoveredGroup(whatsappJid);
  }

  listPendingGroups(limit = 50) {
    return this.db.prepare(`
      SELECT d.*
      FROM discovered_groups d
      LEFT JOIN group_bridges b ON b.whatsapp_jid = d.whatsapp_jid
      WHERE b.whatsapp_jid IS NULL
      ORDER BY d.last_seen_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(Number(limit) || 50, 200))).map(mapDiscoveredGroup);
  }

  upsertGroupBridge(bridge) {
    const now = new Date().toISOString();
    const whatsappJid = String(bridge?.whatsappJid || '').trim();
    const simplexGroupId = Number(bridge?.simplexGroupId);
    const name = cleanName(bridge?.name, whatsappJid);
    this.db.prepare(`
      INSERT INTO group_bridges(
        whatsapp_jid, simplex_group_id, name, enabled,
        whatsapp_to_simplex, simplex_to_whatsapp, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(whatsapp_jid) DO UPDATE SET
        simplex_group_id = excluded.simplex_group_id,
        name = excluded.name,
        enabled = excluded.enabled,
        whatsapp_to_simplex = excluded.whatsapp_to_simplex,
        simplex_to_whatsapp = excluded.simplex_to_whatsapp,
        updated_at = excluded.updated_at
    `).run(
      whatsappJid,
      simplexGroupId,
      name,
      bridge?.enabled === false ? 0 : 1,
      bridge?.whatsappToSimplex === false ? 0 : 1,
      bridge?.simplexToWhatsapp === false ? 0 : 1,
      now,
      now
    );
    return this.getGroupBridgeByWhatsApp(whatsappJid);
  }

  getGroupBridgeByWhatsApp(whatsappJid) {
    return mapGroupBridge(this.db.prepare(
      'SELECT * FROM group_bridges WHERE whatsapp_jid = ?'
    ).get(String(whatsappJid || '').trim()));
  }

  getGroupBridgeBySimplex(groupId) {
    return mapGroupBridge(this.db.prepare(
      'SELECT * FROM group_bridges WHERE simplex_group_id = ?'
    ).get(Number(groupId)));
  }

  listGroupBridges() {
    return this.db.prepare(
      'SELECT * FROM group_bridges ORDER BY name COLLATE NOCASE, simplex_group_id'
    ).all().map(mapGroupBridge);
  }

  setGroupBridgeEnabled(whatsappJid, enabled) {
    this.db.prepare(
      'UPDATE group_bridges SET enabled = ?, updated_at = ? WHERE whatsapp_jid = ?'
    ).run(enabled ? 1 : 0, new Date().toISOString(), String(whatsappJid || '').trim());
    return this.getGroupBridgeByWhatsApp(whatsappJid);
  }

  deleteGroupBridgeByWhatsApp(whatsappJid) {
    return this.db.prepare('DELETE FROM group_bridges WHERE whatsapp_jid = ?')
      .run(String(whatsappJid || '').trim()).changes > 0;
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

function mapDiscoveredGroup(row) {
  if (!row) return null;
  return {
    whatsappJid: row.whatsapp_jid,
    displayName: row.display_name,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    announcedAt: row.announced_at
  };
}

function mapGroupBridge(row) {
  if (!row) return null;
  return {
    whatsappJid: row.whatsapp_jid,
    simplexGroupId: Number(row.simplex_group_id),
    name: row.name,
    enabled: Boolean(row.enabled),
    whatsappToSimplex: Boolean(row.whatsapp_to_simplex),
    simplexToWhatsapp: Boolean(row.simplex_to_whatsapp),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function cleanName(value, fallback) {
  const name = String(value || fallback || 'WhatsApp').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return name.slice(0, 120) || String(fallback || 'WhatsApp');
}
