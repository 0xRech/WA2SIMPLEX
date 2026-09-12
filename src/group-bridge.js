import {
  createTempPath,
  extensionForMime,
  isManagedMediaPath,
  mimeFromFileName,
  removeTempFile,
  safeFileName,
  writeTempFile
} from './media.js';

const GROUP_JID_RE = /^[0-9-]{6,64}@g\.us$/;

export class GroupBridgeRouter {
  constructor({ simplex, whatsapp, store, bridges = [], markWhatsAppRead = true, mediaEnabled = true, mediaDir = './data/media', maxMediaBytes = 32 * 1024 * 1024, logger }) {
    Object.assign(this, { simplex, whatsapp, store, markWhatsAppRead, mediaEnabled, mediaDir, maxMediaBytes, logger });
    this.byWhatsApp = new Map();
    this.bySimplex = new Map();
    this.pendingReceives = new Map();
    this.pendingSimplexSends = new Map();
    this.pendingPathRefs = new Map();
    for (const bridge of bridges) this.addBridge(bridge);
  }

  addBridge(bridge) {
    const normalized = normalizeBridge(bridge);
    if (this.byWhatsApp.has(normalized.whatsappJid)) throw new Error(`Duplicate WhatsApp group bridge: ${normalized.whatsappJid}`);
    if (this.bySimplex.has(normalized.simplexGroupId)) throw new Error(`Duplicate SimpleX group bridge: #${normalized.simplexGroupId}`);
    this.byWhatsApp.set(normalized.whatsappJid, normalized);
    this.bySimplex.set(normalized.simplexGroupId, normalized);
    return normalized;
  }

  get size() { return this.byWhatsApp.size; }

  list() { return [...this.byWhatsApp.values()].map(bridge => ({ ...bridge })); }

  async handleWhatsApp(message) {
    if (!message?.groupJid) return false;
    const bridge = this.byWhatsApp.get(message.groupJid);
    if (!bridge) {
      this.logger?.debug?.('Ignoring unconfigured WhatsApp group', { whatsappGroupJid: message.groupJid });
      return true;
    }
    if (!bridge.enabled || !bridge.whatsappToSimplex) return true;
    if (!message.id || !this.store.claimMessage(message.id)) return true;

    const target = `#${bridge.simplexGroupId}`;
    const sender = cleanName(message.name || message.from || 'WhatsApp');
    try {
      if (this.mediaEnabled && message.media?.id) {
        await this.#forwardWhatsAppMedia(message, target, sender);
      } else {
        const body = message.text || `[${message.type || 'message'}]`;
        await this.simplex.sendText(target, formatWhatsAppMessage(sender, body));
      }
      this.logger?.info?.('Forwarded WhatsApp group message to SimpleX', {
        bridge: bridge.name,
        whatsappGroupJid: bridge.whatsappJid,
        simplexGroupId: bridge.simplexGroupId,
        type: message.type
      });
      if (this.markWhatsAppRead) {
        this.whatsapp.markRead(message.id).catch(error => this.logger?.warn?.('Could not mark WhatsApp group message as read', { error: error.message }));
      }
    } catch (error) {
      this.logger?.error?.('WhatsApp group forwarding failed', { bridge: bridge.name, error: error.message });
      await this.simplex.sendText(target, `❌ Gruppen-Bridge von WhatsApp fehlgeschlagen.\n${safeError(error)}`).catch(() => {});
    }
    return true;
  }

  async handleSimplexEvent(event) {
    if (event?.type === 'sndFileCompleteXFTP') {
      this.#completeSimplexSend(fileIdFromAChatItem(event.chatItem));
      return false;
    }
    if (event?.type === 'sndFileError') {
      this.#completeSimplexSend(fileIdFromAChatItem(event.chatItem_));
      return false;
    }
    if (event?.type === 'rcvFileComplete') return this.#handleSimplexFileComplete(event.chatItem);
    if (event?.type !== 'newChatItems') return false;

    let handled = false;
    for (const item of event.chatItems ?? []) {
      const groupId = simplexGroupId(item.chatInfo);
      const bridge = this.bySimplex.get(groupId);
      if (!bridge) continue;
      handled = true;
      const chatItem = item.chatItem;
      if (!isReceived(chatItem?.chatDir?.type) || chatItem?.content?.type !== 'rcvMsgContent') continue;
      const sender = simplexSenderName(chatItem);
      const text = messageContentText(chatItem.content.msgContent)?.trim() || '';

      if (text === '/bridge status') {
        await this.simplex.sendText(`#${groupId}`, bridgeStatusText(bridge, this.mediaEnabled));
        continue;
      }
      if (text === '/bridge pause') {
        bridge.enabled = false;
        await this.simplex.sendText(`#${groupId}`, '⏸️ WA2SimpleX Gruppen-Bridge pausiert. /bridge resume aktiviert sie wieder.');
        continue;
      }
      if (text === '/bridge resume') {
        bridge.enabled = true;
        await this.simplex.sendText(`#${groupId}`, '▶️ WA2SimpleX Gruppen-Bridge wieder aktiv.');
        continue;
      }
      if (!bridge.enabled || !bridge.simplexToWhatsapp) continue;
      if (chatItem.file && this.mediaEnabled) {
        await this.#beginSimplexFileReceive(item, bridge, sender);
        continue;
      }
      if (!text) continue;
      await this.#sendTextToWhatsApp(bridge, formatSimplexMessage(sender, text), `#${groupId}`);
    }
    return handled;
  }

  async #forwardWhatsAppMedia(message, target, sender) {
    let path;
    try {
      const downloaded = await this.whatsapp.downloadMedia(message.media.id, this.maxMediaBytes);
      const mimeType = message.media.mimeType || downloaded.mimeType || 'application/octet-stream';
      const fileName = safeFileName(message.media.fileName || `whatsapp-${message.id}${extensionForMime(mimeType) || '.bin'}`);
      path = createTempPath(this.mediaDir, 'whatsapp', message.id, fileName, mimeType);
      writeTempFile(path, downloaded.buffer);
      const caption = message.media.caption || mediaLabel(message.media.kind, fileName);
      const result = await this.simplex.sendFile(target, path, formatWhatsAppMessage(sender, caption));
      this.#trackSimplexSend(result, path);
      if (!this.pendingPathRefs.has(path)) this.#scheduleCleanup(path);
    } catch (error) {
      if (!this.pendingPathRefs.has(path)) removeTempFile(path, this.logger);
      throw error;
    }
  }

  async #beginSimplexFileReceive(item, bridge, sender) {
    const file = item.chatItem.file;
    const errorTarget = `#${bridge.simplexGroupId}`;
    if (Number(file.fileSize || 0) > this.maxMediaBytes) {
      await this.simplex.sendText(errorTarget, `❌ Datei ist größer als das WA2SimpleX-Limit (${formatBytes(this.maxMediaBytes)}).`);
      return;
    }
    const existingPath = filePathFromFile(file);
    if (file.fileStatus?.type === 'rcvComplete' && existingPath) {
      await this.#sendSimplexFileToWhatsApp({ ...item, bridgeSender: sender }, bridge, existingPath);
      return;
    }
    const destination = createTempPath(this.mediaDir, 'simplex', file.fileId, file.fileName || 'attachment.bin', mimeFromFileName(file.fileName));
    this.pendingReceives.set(Number(file.fileId), { path: destination, bridge, sender });
    try {
      await this.simplex.receiveFile(file.fileId, destination);
    } catch (error) {
      this.pendingReceives.delete(Number(file.fileId));
      removeTempFile(destination, this.logger);
      await this.simplex.sendText(errorTarget, `❌ SimpleX-Datei konnte nicht angenommen werden.\n${safeError(error)}`);
    }
  }

  async #handleSimplexFileComplete(aChatItem) {
    if (!aChatItem?.chatItem?.file) return false;
    const groupId = simplexGroupId(aChatItem.chatInfo);
    const bridge = this.bySimplex.get(groupId);
    if (!bridge || !bridge.enabled || !bridge.simplexToWhatsapp) return false;
    const file = aChatItem.chatItem.file;
    const pending = this.pendingReceives.get(Number(file.fileId));
    const path = filePathFromFile(file) || pending?.path;
    if (!path) {
      await this.simplex.sendText(`#${groupId}`, '❌ SimpleX-Datei wurde empfangen, aber der lokale Dateipfad fehlt.');
      return true;
    }
    await this.#sendSimplexFileToWhatsApp({ ...aChatItem, bridgeSender: pending?.sender }, bridge, path);
    this.pendingReceives.delete(Number(file.fileId));
    return true;
  }

  async #sendSimplexFileToWhatsApp(aChatItem, bridge, path) {
    const chatItem = aChatItem.chatItem;
    const file = chatItem.file;
    const sender = aChatItem.bridgeSender || simplexSenderName(chatItem);
    const rawCaption = messageContentText(chatItem.content?.msgContent)?.trim() || mediaLabelFromFile(file.fileName);
    const fileName = safeFileName(file.fileName || path);
    const mimeType = mimeFromFileName(fileName);
    try {
      await this.whatsapp.sendFile(bridge.whatsappJid, {
        filePath: path,
        mimeType,
        fileName,
        caption: formatSimplexMessage(sender, rawCaption),
        maxBytes: this.maxMediaBytes
      });
    } catch (error) {
      this.logger?.error?.('SimpleX group media forwarding failed', { bridge: bridge.name, error: error.message });
      await this.simplex.sendText(`#${bridge.simplexGroupId}`, `❌ Datei konnte nicht in die WhatsApp-Gruppe gesendet werden.\n${safeError(error)}`);
    } finally {
      if (isManagedMediaPath(path, this.mediaDir)) removeTempFile(path, this.logger);
    }
  }

  async #sendTextToWhatsApp(bridge, text, errorTarget) {
    try {
      await this.whatsapp.sendText(bridge.whatsappJid, text);
    } catch (error) {
      this.logger?.error?.('WhatsApp group send failed', { bridge: bridge.name, error: error.message });
      await this.simplex.sendText(errorTarget, `❌ Versand in die WhatsApp-Gruppe fehlgeschlagen.\n${safeError(error)}`);
    }
  }

  #trackSimplexSend(response, path) {
    const fileIds = (response?.chatItems ?? []).map(fileIdFromAChatItem).filter(Number.isInteger);
    for (const fileId of fileIds) {
      this.pendingSimplexSends.set(fileId, path);
      this.pendingPathRefs.set(path, (this.pendingPathRefs.get(path) || 0) + 1);
    }
  }

  #completeSimplexSend(fileId) {
    if (!Number.isInteger(fileId)) return;
    const path = this.pendingSimplexSends.get(fileId);
    if (!path) return;
    this.pendingSimplexSends.delete(fileId);
    const next = (this.pendingPathRefs.get(path) || 1) - 1;
    if (next <= 0) {
      this.pendingPathRefs.delete(path);
      removeTempFile(path, this.logger);
    } else {
      this.pendingPathRefs.set(path, next);
    }
  }

  #scheduleCleanup(path) {
    const timer = setTimeout(() => removeTempFile(path, this.logger), 60 * 60 * 1000);
    timer.unref?.();
  }
}

export function normalizeBridge(bridge) {
  const simplexGroupId = Number(bridge?.simplexGroupId);
  const whatsappJid = String(bridge?.whatsappJid || '').trim();
  if (!Number.isInteger(simplexGroupId) || simplexGroupId <= 0) throw new Error('Group bridge simplexGroupId must be a positive integer');
  if (!GROUP_JID_RE.test(whatsappJid)) throw new Error(`Invalid WhatsApp group JID: ${whatsappJid || '(empty)'}`);
  return {
    name: cleanName(bridge?.name || `#${simplexGroupId}`),
    simplexGroupId,
    whatsappJid,
    enabled: bridge?.enabled !== false,
    whatsappToSimplex: bridge?.whatsappToSimplex !== false,
    simplexToWhatsapp: bridge?.simplexToWhatsapp !== false
  };
}

export function formatWhatsAppMessage(sender, text) { return `🟢 ${cleanName(sender)} · WhatsApp\n${String(text || '')}`; }
export function formatSimplexMessage(sender, text) { return `🟣 ${cleanName(sender)} · SimpleX\n${String(text || '')}`; }

export function simplexSenderName(chatItem) {
  const dir = chatItem?.chatDir || {};
  const candidates = [
    dir?.groupMember?.memberProfile?.displayName,
    dir?.groupMember?.displayName,
    dir?.sender?.displayName,
    chatItem?.meta?.itemMember?.memberProfile?.displayName,
    chatItem?.meta?.itemMember?.displayName,
    chatItem?.senderDisplayName
  ];
  return cleanName(candidates.find(Boolean) || 'SimpleX');
}

function simplexGroupId(chatInfo) {
  const id = chatInfo?.type === 'group' ? chatInfo.groupInfo?.groupId : null;
  return Number.isInteger(id) ? id : null;
}
function messageContentText(content) {
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.msgContent?.text === 'string') return content.msgContent.text;
  return '';
}
function isReceived(type) { return ['groupRcv', 'localRcv', 'channelRcv'].includes(type); }
function filePathFromFile(file) { return file?.fileSource?.filePath || file?.fileStatus?.filePath || file?.fileStatus?.filePath_ || null; }
function fileIdFromAChatItem(aChatItem) { const id = aChatItem?.chatItem?.file?.fileId; return Number.isInteger(id) ? id : null; }
function cleanName(value) { return String(value || 'Unknown').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Unknown'; }
function safeError(error) { return String(error?.message || error || 'unknown error').replace(/EA[A-Za-z0-9_-]{10,}/g, '[token-redacted]').slice(0, 800); }
function formatBytes(bytes) { const value = Number(bytes || 0); if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; return `${(value / 1024 ** 2).toFixed(1)} MB`; }
function mediaLabel(kind, fileName) { const icons = { image: '🖼️', video: '🎬', audio: '🎵', document: '📎', sticker: '🧩' }; return `${icons[kind] || '📎'} ${fileName}`; }
function mediaLabelFromFile(fileName) { return `📎 ${safeFileName(fileName || 'attachment.bin')}`; }
function bridgeStatusText(bridge, mediaEnabled) {
  return [
    `🌉 ${bridge.name}`,
    `Status: ${bridge.enabled ? 'aktiv' : 'pausiert'}`,
    `SimpleX: #${bridge.simplexGroupId}`,
    `WhatsApp: ${bridge.whatsappJid}`,
    `Richtung: ${bridge.simplexToWhatsapp ? 'SimpleX→WA' : ''}${bridge.simplexToWhatsapp && bridge.whatsappToSimplex ? ' + ' : ''}${bridge.whatsappToSimplex ? 'WA→SimpleX' : ''}`,
    `Medien: ${mediaEnabled ? 'aktiv' : 'aus'}`
  ].join('\n');
}