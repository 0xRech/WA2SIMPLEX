import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { openWhatsAppAuth } from '../src/whatsapp-auth.js';
import { normalizeWebMessage, readBoundedStream } from '../src/whatsapp-web-message.js';
import { WhatsAppWebClient } from '../src/whatsapp-web.js';
import { loadConfig } from '../src/config.js';

const raw = (overrides = {}) => ({
  key: { id: 'abc', fromMe: false, remoteJid: '491701234567@s.whatsapp.net' },
  pushName: 'Example', messageTimestamp: 123, message: { conversation: 'Hello' }, ...overrides
});
const logger = { info() {}, warn() {}, error() {} };

test('web configuration does not require Meta secrets and permits pairing before SimpleX setup', () => {
  const before = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('WHATSAPP_') || key.startsWith('SIMPLEX_')) delete process.env[key];
    process.env.WHATSAPP_PROVIDER = 'web';
    assert.equal(loadConfig().whatsapp.provider, 'web');
    assert.equal(loadConfig().simplex.controlTarget, '');
    process.env.SIMPLEX_CONTROL_TARGET = '@1';
    assert.equal(loadConfig().simplex.ownerContactId, 1);
    process.env.WHATSAPP_PROVIDER = 'cloud';
    assert.throws(() => loadConfig(), /WHATSAPP_VERIFY_TOKEN/);
    process.env.WHATSAPP_PROVIDER = 'typo';
    assert.throws(() => loadConfig(), /WHATSAPP_PROVIDER/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
});

test('normalizes live direct text and isolates deduplication IDs by sender', async () => {
  const message = await normalizeWebMessage(raw());
  assert.equal(message.from, '491701234567');
  assert.equal(message.text, 'Hello');
  assert.equal(message.id, 'web:491701234567:abc');
  assert.equal(message.media, null);
});

test('ignores own messages, groups, broadcasts, newsletters and protocol events', async () => {
  for (const jid of ['12345@g.us', 'status@broadcast', '123@newsletter']) {
    assert.equal(await normalizeWebMessage(raw({ key: { id: 'abc', remoteJid: jid } })), null);
  }
  assert.equal(await normalizeWebMessage(raw({ key: { ...raw().key, fromMe: true } })), null);
  assert.equal(await normalizeWebMessage(raw({ message: { protocolMessage: {} } })), null);
});

test('LIDs require a verified phone mapping, never numeric string stripping', async () => {
  const input = raw({ key: { id: 'abc', remoteJid: '123456789012@lid' } });
  assert.equal(await normalizeWebMessage(input), null);
  assert.equal((await normalizeWebMessage(input, async () => '491701234567@s.whatsapp.net')).from, '491701234567');
  input.key.remoteJidAlt = '491701234568@s.whatsapp.net';
  assert.equal((await normalizeWebMessage(input)).from, '491701234568');
});

test('unwraps normal media but does not forward view-once content', async () => {
  const body = { imageMessage: { mimetype: 'image/jpeg', caption: 'Image' } };
  const message = await normalizeWebMessage(raw({ message: { ephemeralMessage: { message: body } } }));
  assert.equal(message.media.kind, 'image');
  assert.equal(message.media.caption, 'Image');
  assert.equal(await normalizeWebMessage(raw({ message: { viewOnceMessageV2: { message: body } } })), null);
});

test('media downloads enforce limits while streaming', async () => {
  assert.deepEqual(await readBoundedStream(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 4), Buffer.from('abcd'));
  await assert.rejects(readBoundedStream(Readable.from([Buffer.alloc(3), Buffer.alloc(3)]), 4), /limit/);
});

test('authentication keys survive reopen with binary serialization and deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-auth-test-'));
  try {
    let auth = openWhatsAppAuth(join(dir, 'auth.db'));
    const publicKey = auth.state.creds.noiseKey.public;
    await auth.state.keys.set({ session: { one: Buffer.from([0, 255, 8]), two: { token: Buffer.from('secret') } } });
    auth.state.creds.registered = true;
    auth.saveCreds(); auth.close();
    auth = openWhatsAppAuth(join(dir, 'auth.db'));
    assert.deepEqual(auth.state.creds.noiseKey.public, publicKey);
    assert.equal(auth.state.creds.registered, true);
    assert.deepEqual((await auth.state.keys.get('session', ['one'])).one, Buffer.from([0, 255, 8]));
    await auth.state.keys.set({ session: { one: null } });
    assert.equal((await auth.state.keys.get('session', ['one'])).one, undefined);
    auth.close();
    assert.equal(statSync(join(dir, 'auth.db')).mode & 0o777, 0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('QR stays in a private file, logout stops retrying, history is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-socket-test-'));
  const ev = new EventEmitter();
  const delivered = [];
  let options;
  const socket = { ev, end() {}, signalRepository: {}, sendMessage: async (...args) => args };
  const client = new WhatsAppWebClient({
    authPath: join(dir, 'auth.db'), qrPath: join(dir, 'qr.txt'), logger,
    onMessage: async message => delivered.push(message),
    socketFactory: opts => { options = opts; return socket; }
  });
  try {
    await client.start();
    assert.equal(options.syncFullHistory, false);
    assert.equal(options.shouldSyncHistoryMessage(), false);
    ev.emit('connection.update', { qr: 'test-pairing-only' });
    assert.equal(client.status, 'pairing_required');
    assert.match(readFileSync(join(dir, 'qr.txt'), 'utf8'), /Verknüpfte Geräte/);
    assert.equal(statSync(join(dir, 'qr.txt')).mode & 0o777, 0o600);
    ev.emit('messages.upsert', { type: 'append', messages: [raw()] });
    ev.emit('messages.upsert', { type: 'notify', messages: [raw()] });
    await client.queue;
    assert.equal(delivered.length, 1);
    assert.equal(client.pending.size, 0);
    ev.emit('connection.update', { connection: 'open' });
    assert.equal(existsSync(join(dir, 'qr.txt')), false);
    assert.deepEqual(await client.sendText('491701234567', 'test'), ['491701234567@s.whatsapp.net', { text: 'test' }]);
    ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    assert.equal(client.status, 'relink_required');
    assert.equal(client.timer, undefined);
    assert.throws(() => client.sendText('491701234567', 'test'), /not connected/);
  } finally { await client.stop(); rmSync(dir, { recursive: true, force: true }); }
});
