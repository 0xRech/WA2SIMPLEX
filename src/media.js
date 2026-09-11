import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const MIME_BY_EXT = new Map([
  ['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.png','image/png'],['.webp','image/webp'],['.gif','image/gif'],
  ['.mp4','video/mp4'],['.3gp','video/3gpp'],['.mov','video/quicktime'],
  ['.mp3','audio/mpeg'],['.mpeg','audio/mpeg'],['.ogg','audio/ogg'],['.opus','audio/ogg'],['.wav','audio/wav'],['.m4a','audio/mp4'],['.aac','audio/aac'],['.amr','audio/amr'],
  ['.pdf','application/pdf'],['.txt','text/plain'],['.csv','text/csv'],['.json','application/json'],['.zip','application/zip']
]);

const EXT_BY_MIME = new Map([
  ['image/jpeg','.jpg'],['image/png','.png'],['image/webp','.webp'],['image/gif','.gif'],
  ['video/mp4','.mp4'],['video/3gpp','.3gp'],['video/quicktime','.mov'],
  ['audio/mpeg','.mp3'],['audio/ogg','.ogg'],['audio/opus','.opus'],['audio/wav','.wav'],['audio/mp4','.m4a'],['audio/aac','.aac'],['audio/amr','.amr'],
  ['application/pdf','.pdf'],['text/plain','.txt'],['application/zip','.zip']
]);

export function ensureMediaDir(baseDir) {
  const root = resolve(baseDir);
  mkdirSync(join(root, 'whatsapp-in'), { recursive: true });
  mkdirSync(join(root, 'simplex-in'), { recursive: true });
  return root;
}

export function safeFileName(value, fallback = 'attachment.bin') {
  const raw = basename(String(value || fallback)).replace(/[\r\n\0]/g, '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-180);
  return cleaned || fallback;
}

export function mimeFromFileName(fileName, fallback = 'application/octet-stream') {
  return MIME_BY_EXT.get(extname(String(fileName || '')).toLowerCase()) || fallback;
}

export function extensionForMime(mimeType) {
  return EXT_BY_MIME.get(String(mimeType || '').toLowerCase()) || '';
}

export function whatsappMediaType(mimeType, fileName = '') {
  const mime = String(mimeType || mimeFromFileName(fileName)).toLowerCase();
  if (mime.startsWith('image/') && mime !== 'image/gif') return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

export function createTempPath(baseDir, direction, id, fileName, mimeType) {
  const root = ensureMediaDir(baseDir);
  const folder = direction === 'simplex' ? 'simplex-in' : 'whatsapp-in';
  const fallback = `media-${String(id || Date.now())}${extensionForMime(mimeType) || '.bin'}`;
  return join(root, folder, `${safeToken(id)}-${safeFileName(fileName, fallback)}`);
}

export function writeTempFile(path, buffer) {
  writeFileSync(path, buffer, { mode: 0o600 });
  return path;
}

export function removeTempFile(path, logger) {
  if (!path) return;
  try { unlinkSync(path); }
  catch (error) {
    if (error?.code !== 'ENOENT') logger?.warn?.('Could not remove temporary media file', { error: error.message });
  }
}

export function pruneMediaDir(baseDir, maxAgeMs, logger) {
  const root = ensureMediaDir(baseDir);
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const folder of ['whatsapp-in', 'simplex-in']) {
    const dir = join(root, folder);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (stat.isFile() && stat.mtimeMs < cutoff) {
          unlinkSync(path);
          removed += 1;
        }
      } catch (error) {
        logger?.debug?.('Skipping media cleanup entry', { error: error.message });
      }
    }
  }
  return removed;
}

function safeToken(value) {
  return String(value || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '').slice(-80) || String(Date.now());
}
