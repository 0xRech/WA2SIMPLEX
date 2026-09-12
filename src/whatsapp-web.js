import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrTerminal from 'qrcode-terminal';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openWhatsAppAuth } from './whatsapp-auth.js';
import { normalizeWebMessage, readBoundedStream } from './whatsapp-web-message.js';
import { safeFileName, whatsappMediaType } from './media.js';
import { isWhatsAppGroup } from './whatsapp-address.js';

export class WhatsAppWebClient {
  constructor({ authPath, qrPath, logger, onMessage, maxBytes = 32 * 1024 * 1024, socketFactory = makeWASocket, groupsEnabled = true }) {
    Object.assign(this, { authPath, qrPath, logger, onMessage, maxBytes });
    this.status = 'stopped';
    this.stopped = true;
    this.attempt = 0;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.queued = 0;
    this.libraryLogger = pino({ level: 'silent' });
    this.socketFactory = socketFactory;
    this.groupsEnabled = groupsEnabled;
    this.groupCache = new Map();
  }
  async start() {
    this.stopped = false;
    this.auth = openWhatsAppAuth(this.authPath);
    await this.connect();
  }
  async connect() {
    if (this.stopped) return;
    this.status = 'connecting';
    const socket = this.socketFactory({
      auth: this.auth.state, logger: this.libraryLogger,
      browser: Browsers.ubuntu('Rechgroup WA2SimpleX'),
      markOnlineOnConnect: false, syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async () => undefined,
      cachedGroupMetadata: async jid => this.cachedGroup(jid),
      shouldIgnoreJid: jid => (!this.groupsEnabled && jid.endsWith('@g.us')) || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')
    });
    this.socket = socket;
    this.groupCache.clear();
    socket.ev.on('groups.update', updates => { for (const group of updates) this.groupCache.delete(group.id); });
    socket.ev.on('group-participants.update', update => this.groupCache.delete(update.id));
    socket.ev.on('creds.update', () => this.auth.saveCreds());
    socket.ev.on('connection.update', update => {
      if (this.stopped || this.socket !== socket) return;
      if (update.qr) {
        this.status = 'pairing_required';
        mkdirSync(dirname(this.qrPath), { recursive: true, mode: 0o700 });
        qrTerminal.generate(update.qr, { small: true }, code => {
          writeFileSync(`${this.qrPath}.tmp`, `WhatsApp > Verknüpfte Geräte > Gerät hinzufügen\n${code}\n`, { mode: 0o600 });
          renameSync(`${this.qrPath}.tmp`, this.qrPath);
        });
        this.logger.info('WhatsApp QR ready; use wa2simplex-pair over SSH');
      }
      if (update.connection === 'open') {
        this.status = 'connected';
        this.attempt = 0;
        this.clearQr();
        this.logger.info('WhatsApp linked-device connection established');
      }
      if (update.connection === 'close') {
        this.clearQr();
        const code = update.lastDisconnect?.error?.output?.statusCode;
        const permanent = [DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced, DisconnectReason.forbidden, DisconnectReason.multideviceMismatch].includes(code);
        this.status = permanent ? 'relink_required' : 'reconnecting';
        socket.ev.removeAllListeners('connection.update');
        socket.ev.removeAllListeners('messages.upsert');
        socket.ev.removeAllListeners('creds.update');
        socket.ev.removeAllListeners('groups.update');
        socket.ev.removeAllListeners('group-participants.update');
        this.logger.warn('WhatsApp connection closed', { code, status: this.status });
        if (!permanent) {
          const delay = code === DisconnectReason.restartRequired ? 1000 : Math.min(60000, 3000 * 2 ** Math.min(this.attempt++, 5));
          this.timer = setTimeout(() => this.connect().catch(error => {
            this.status = 'failed';
            this.logger.error('WhatsApp reconnect failed', { error: error.message });
          }), delay);
        }
      }
    });
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' || this.stopped) return;
      for (const raw of messages) {
        if (this.queued >= 100) { this.logger.warn('WhatsApp receive queue full'); break; }
        this.queued++;
        this.queue = this.queue.then(async () => {
          if (this.stopped) return;
          const message = await normalizeWebMessage(raw, lid => socket.signalRepository?.lidMapping?.getPNForLID(lid), { groupsEnabled: this.groupsEnabled });
          if (!message) return;
          if (message.chatType === 'group') {
            const metadata = await this.getGroup(message.from).catch(() => null);
            message.name = metadata?.subject || `Gruppe ${message.from.split('@')[0].slice(-6)}`;
          }
          this.pending.set(message.id, raw);
          try { await this.onMessage(message); }
          finally { this.pending.delete(message.id); }
        }).catch(error => this.logger.error('WhatsApp incoming message failed', { error: error.message }))
          .finally(() => { this.queued--; });
      }
    });
  }
  clearQr() { rmSync(this.qrPath, { force: true }); }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.clearQr();
    this.socket?.end(new Error('Bridge stopping'));
    await this.queue;
    this.socket?.ev.removeAllListeners('creds.update');
    this.auth?.close();
    this.status = 'stopped';
  }
  connectedSocket() {
    if (this.status !== 'connected') throw new Error('WhatsApp is not connected');
    return this.socket;
  }
  cachedGroup(jid) {
    const entry = this.groupCache.get(jid);
    if (entry && entry.expires > Date.now()) return entry.metadata;
    this.groupCache.delete(jid);
  }
  async getGroup(jid) {
    const cached = this.cachedGroup(jid);
    if (cached) return cached;
    const metadata = await this.connectedSocket().groupMetadata(jid);
    if (this.groupCache.size >= 200) this.groupCache.delete(this.groupCache.keys().next().value);
    this.groupCache.set(jid, { metadata, expires: Date.now() + 5 * 60 * 1000 });
    return metadata;
  }
  jid(to) {
    if (isWhatsAppGroup(to)) {
      if (!this.groupsEnabled) throw new Error('WhatsApp group support is disabled');
      return to;
    }
    if (!/^\d{6,20}$/.test(String(to))) throw new Error('Invalid WhatsApp telephone number');
    return `${to}@s.whatsapp.net`;
  }
  sendText(to, text) { return this.connectedSocket().sendMessage(this.jid(to), { text: String(text) }); }
  async getProfilePicture(to) {
    let timer;
    let url;
    try {
      url = await Promise.race([
        this.connectedSocket().profilePictureUrl(this.jid(to), 'image', 10000),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Profile picture timeout')), 12000); })
      ]);
    } catch (error) {
      const status = error?.output?.statusCode;
      if (status === 401 || status === 403 || status === 404) return null;
      throw error;
    } finally { clearTimeout(timer); }
    if (!url) return null;
    const target = new URL(url);
    if (target.protocol !== 'https:' || !['whatsapp.net', 'fbcdn.net'].some(domain => target.hostname === domain || target.hostname.endsWith(`.${domain}`))) {
      throw new Error('Unexpected profile picture host');
    }
    const response = await fetch(target, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!response.ok) throw new Error('Profile picture download failed');
    if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('Profile picture too large');
    return readBoundedStream(response.body, 2 * 1024 * 1024);
  }
  async markRead(id) {
    const raw = this.pending.get(id);
    if (raw) await this.connectedSocket().readMessages([raw.key]);
  }
  async downloadMedia(id, maxBytes = this.maxBytes) {
    const raw = this.pending.get(id);
    if (!raw) throw new Error('Incoming WhatsApp media is no longer available');
    const socket = this.connectedSocket();
    const stream = await downloadMediaMessage(raw, 'stream', {}, {
      logger: this.libraryLogger, reuploadRequest: socket.updateMediaMessage
    });
    const buffer = await readBoundedStream(stream, maxBytes);
    return { buffer, fileSize: buffer.length };
  }
  async sendFile(to, { filePath, mimeType, fileName, caption = '', maxBytes = this.maxBytes }) {
    const info = await stat(filePath);
    if (info.size > maxBytes) throw new Error('SimpleX file exceeds configured limit');
    const type = whatsappMediaType(mimeType, fileName || filePath);
    const payload = { [type]: { url: filePath }, mimetype: mimeType };
    if (type === 'document') payload.fileName = safeFileName(fileName || filePath);
    if (type !== 'audio' && caption) payload.caption = String(caption);
    const result = await this.connectedSocket().sendMessage(this.jid(to), payload);
    if (type === 'audio' && caption) await this.sendText(to, caption);
    return result;
  }
}
