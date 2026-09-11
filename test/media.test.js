import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTempPath,
  extensionForMime,
  mimeFromFileName,
  safeFileName,
  whatsappMediaType
} from '../src/media.js';

test('sanitizes media filenames and maps MIME types', () => {
  assert.equal(safeFileName('../../Mein Bild (1).jpg'), 'Mein_Bild_1_.jpg');
  assert.equal(mimeFromFileName('voice.ogg'), 'audio/ogg');
  assert.equal(extensionForMime('application/pdf'), '.pdf');
  assert.equal(whatsappMediaType('image/jpeg', 'x.jpg'), 'image');
  assert.equal(whatsappMediaType('audio/ogg', 'x.ogg'), 'audio');
  assert.equal(whatsappMediaType('application/pdf', 'x.pdf'), 'document');
});

test('creates media temp paths below configured directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa2simplex-media-'));
  try {
    const path = createTempPath(root, 'whatsapp', 'wamid.1', '../photo.jpg', 'image/jpeg');
    assert.ok(path.startsWith(root));
    assert.ok(path.endsWith('photo.jpg'));
    assert.ok(path.includes('whatsapp-in'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
