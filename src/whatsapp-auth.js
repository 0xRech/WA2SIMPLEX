import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

// Authentication keys only: never store message bodies or chat history here.
export function openWhatsAppAuth(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS auth (category TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(category,id))');
  const get = db.prepare('SELECT value FROM auth WHERE category=? AND id=?');
  const put = db.prepare('INSERT OR REPLACE INTO auth VALUES(?,?,?)');
  const del = db.prepare('DELETE FROM auth WHERE category=? AND id=?');
  const read = (category, id) => {
    const row = get.get(category, id);
    return row ? JSON.parse(row.value, BufferJSON.reviver) : undefined;
  };
  const creds = read('creds', 'current') || initAuthCreds();
  let closed = false;
  const saveCreds = () => {
    if (!closed) put.run('creds', 'current', JSON.stringify(creds, BufferJSON.replacer));
  };
  saveCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const values = {};
          for (const id of ids) {
            const value = read(type, id);
            values[id] = type === 'app-state-sync-key' && value
              ? proto.Message.AppStateSyncKeyData.fromObject(value) : value;
          }
          return values;
        },
        set: async (data) => {
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const [type, values] of Object.entries(data)) {
              for (const [id, value] of Object.entries(values)) {
                if (value == null) del.run(type, id);
                else put.run(type, id, JSON.stringify(value, BufferJSON.replacer));
              }
            }
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        }
      }
    },
    saveCreds,
    close: () => { if (!closed) { saveCreds(); closed = true; db.close(); } }
  };
}
