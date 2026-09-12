import { isWhatsAppGroup, normalizeChatAddress, displayChatAddress } from './whatsapp-address.js';
import {
  createTempPath,
  extensionForMime,
  isManagedMediaPath,
  mimeFromFileName,
  pruneMediaDir,
  removeTempFile,
  safeFileName,
  writeTempFile
} from './media.js';

const MARKER_RE = /⟦WA:(\d{6,20})⟧/;
const COMMAND_RE = /^\/wa\s+([+\d][\d\s().-]{5,24})\s+([\s\S]+)$/i;
const NEW_RE = /^\/new\s+([+\d][\d\s().-]{5,24})(?:\s+([\s\S]+))?$/i;
const TARGET_RE = /^\/(archive|unarchive|repair)\s+(.+)$/i;
const RENAME_RE = /^\/rename\s+([\s\S]+)$/i;
const READY_STATUSES = new Set(['connected', 'complete', 'creator']);

export class BridgeRouter {
  constructor({
    simplex,
    whatsapp,
    store,
    controlTarget,
    ownerContactId,
    groupPrefix = 'WA',
    markWhatsAppRead = true,
    mediaEnabled = true,
    mediaDir = './data/media',
    maxMediaBytes = 32 * 1024 * 1024,
    mediaRetentionMs = 60 * 60 * 1000,
    logger
  }) {
    Object.assign(this, {
      simplex,
      whatsapp,
      store,
      controlTarget,
      ownerContactId,
      groupPrefix,
      markWhatsAppRead,
      mediaEnabled,
      mediaDir,
      maxMediaBytes,
      mediaRetentionMs,
      logger
    });
    this.contactLocks = new Map();
    this.pendingSimplexReceives = new Map();
    this.pendingSimplexSends = new Map();
    this.pendingPathRefs = new Map();
  }

  async initialize() {
    this.store.pruneProcessedMessages();
    if (this.mediaEnabled) {
      const removed = pruneMediaDir(this.mediaDir, this.mediaRetentionMs, this.logger);
      if (removed) this.logger.info('Removed stale temporary media files', { removed });
    }

    try {
      const groups = await this.simplex.listGroups();
      let recovered = 0;
      for (const group of groups) {
        const meta = group?.customData?.wa2simplex;
        const phone = normalizeNumber(meta?.chatId || meta?.phone);
        if (!phone || !Number.isInteger(group?.groupId)) continue;
        const existing = this.store.getContact(phone);
        this.store.upsertContact(phone, meta?.displayName || existing?.displayName || phone, { touch: false });
        if (!existing?.simplexGroupId) {
          this.store.bindGroup(phone, group.groupId);
          recovered += 1;
        }
      }
      if (recovered) this.logger.info('Recovered WA2SimpleX mappings from SimpleX custom data', { recovered });
    } catch (error) {
      this.logger.warn('Could not scan SimpleX groups for mapping recovery', { error: error.message });
    }
  }

  async handleWhatsApp(message) {
    const phone = normalizeNumber(message?.from);
    if (!phone) return;
    if (!message?.id || !this.store.claimMessage(message.id)) return;
    const displayName = cleanDisplayName(message.name || phone);
    let contact = await this.#ensureContactGroup(phone, displayName);
    if (contact.archived) contact = this.store.setArchived(phone, false);
    if (!contact.ready) contact = await this.#refreshReady(contact);

    const groupRef = `#${contact.simplexGroupId}`;
    if (this.mediaEnabled && message.media?.id) {
      await this.#forwardWhatsAppMedia(message, contact, groupRef);
    } else {
      const displayText = incomingText(message, message.text || `[${message.type || 'message'}]`);
      await this.simplex.sendText(groupRef, displayText);
      if (!contact.ready) await this.#mirrorPendingText(contact, phone, displayText, groupRef);
    }

    this.logger.info('Forwarded WhatsApp message to SimpleX contact chat', {
      whatsappMessageId: message.id,
      from: maskPhone(phone),
      simplexGroupId: contact.simplexGroupId,
      ready: contact.ready,
      type: message.type,
      media: Boolean(message.media?.id)
    });

    if (this.markWhatsAppRead) {
      this.whatsapp.markRead(message.id).catch((error) => {
        this.logger.warn('Could not mark WhatsApp message as read', { error: error.message });
      });
    }
  }

  async handleSimplexEvent(event) {
    this.#observeMembershipEvent(event);

    if (event?.type === 'rcvFileComplete') {
      await this.#handleSimplexFileComplete(event.chatItem);
      return;
    }
    if (event?.type === 'sndFileCompleteXFTP') {
      this.#completeSimplexSend(fileIdFromAChatItem(event.chatItem));
      return;
    }
    if (event?.type === 'sndFileError') {
      this.#completeSimplexSend(fileIdFromAChatItem(event.chatItem_));
      return;
    }
    if (event?.type !== 'newChatItems') return;

    for (const item of event.chatItems ?? []) {
      const chatRef = chatRefFromInfo(item.chatInfo);
      const chatItem = item.chatItem;
      if (!isReceived(chatItem?.chatDir?.type) || chatItem?.content?.type !== 'rcvMsgContent') continue;
      const text = messageContentText(chatItem.content.msgContent)?.trim() || '';

      if (chatRef === this.controlTarget) {
        if (chatItem.file) {
          await this.simplex.sendText(
            this.controlTarget,
            'ℹ️ Dateien im Control-Chat werden nicht zu WhatsApp geroutet. Sende sie im jeweiligen WA-Kontakt-Chat.'
          );
        } else if (text) {
          await this.#handleControlMessage(text, chatItem);
        }
        continue;
      }

      const groupId = groupIdFromChatRef(chatRef);
      if (!groupId) continue;
      const contact = this.store.getByGroupId(groupId);
      if (!contact) continue;
      this.store.setReadyByGroup(groupId, true);

      if (chatItem.file && this.mediaEnabled) {
        await this.#beginSimplexFileReceive(item, contact);
        continue;
      }
      if (!text) continue;
      if (text.startsWith('/')) {
        await this.#handleContactChatCommand(contact, text);
        continue;
      }
      if (contact.archived) this.store.setArchived(contact.phone, false);
      await this.#sendToWhatsApp(contact.phone, text, `#${groupId}`);
    }
  }

  async #forwardWhatsAppMedia(message, contact, groupRef) {
    let path;
    try {
      const downloaded = await this.whatsapp.downloadMedia(message.media.id, this.maxMediaBytes);
      const mimeType = message.media.mimeType || downloaded.mimeType || 'application/octet-stream';
      const fileName = safeFileName(
        message.media.fileName || `whatsapp-${message.id}${extensionForMime(mimeType) || '.bin'}`
      );
      path = createTempPath(this.mediaDir, 'whatsapp', message.id, fileName, mimeType);
      writeTempFile(path, downloaded.buffer);
      const caption = incomingText(message, message.media.caption || mediaLabel(message.media.kind, fileName));

      const groupResult = await this.simplex.sendFile(groupRef, path, caption);
      this.#trackSimplexSend(groupResult, path);

      if (!contact.ready) {
        const controlResult = await this.simplex.sendFile(
          this.controlTarget,
          path,
          `📲 ${contact.displayName} · ${displayChatAddress(contact.phone)}\n${caption}`
        );
        this.#trackSimplexSend(controlResult, path);
        await this.simplex.sendText(
          this.controlTarget,
          `⏳ Chat ${groupRef} wurde angelegt. Bitte die SimpleX-Gruppeneinladung einmalig annehmen.`
        );
      }

      // If the SimpleX response did not expose a file ID, keep a bounded fallback cleanup timer.
      if (!this.pendingPathRefs.has(path)) this.#scheduleCleanup(path);
    } catch (error) {
      // Do not delete a source that is still being consumed by another successful SimpleX XFTP send.
      if (!this.pendingPathRefs.has(path)) removeTempFile(path, this.logger);
      const notice = `❌ Medium von ${contact.displayName} konnte nicht übertragen werden.\n${safeError(error)}`;
      await this.simplex.sendText(groupRef, notice).catch(() => {});
      await this.simplex.sendText(this.controlTarget, notice).catch(() => {});
      this.logger.error('WhatsApp media forwarding failed', {
        from: maskPhone(contact.phone),
        error: error.message
      });
    }
  }

  async #beginSimplexFileReceive(item, contact) {
    const file = item.chatItem.file;
    const groupId = contact.simplexGroupId;
    const errorTarget = `#${groupId}`;

    if (Number(file.fileSize || 0) > this.maxMediaBytes) {
      await this.simplex.sendText(
        errorTarget,
        `❌ Datei ist größer als das WA2SimpleX-Limit (${formatBytes(this.maxMediaBytes)}).`
      );
      return;
    }

    const existingPath = filePathFromFile(file);
    if (file.fileStatus?.type === 'rcvComplete' && existingPath) {
      await this.#sendSimplexFileToWhatsApp(item, contact, existingPath);
      return;
    }

    const destination = createTempPath(
      this.mediaDir,
      'simplex',
      file.fileId,
      file.fileName || 'attachment.bin',
      mimeFromFileName(file.fileName)
    );
    this.pendingSimplexReceives.set(Number(file.fileId), {
      path: destination,
      groupId,
      phone: contact.phone
    });

    try {
      await this.simplex.receiveFile(file.fileId, destination);
      this.logger.info('Accepted SimpleX file for WhatsApp forwarding', {
        groupId,
        fileId: file.fileId,
        size: file.fileSize
      });
    } catch (error) {
      this.pendingSimplexReceives.delete(Number(file.fileId));
      removeTempFile(destination, this.logger);
      await this.simplex.sendText(
        errorTarget,
        `❌ SimpleX-Datei konnte nicht angenommen werden.\n${safeError(error)}`
      );
    }
  }

  async #handleSimplexFileComplete(aChatItem) {
    if (!aChatItem?.chatItem?.file) return;
    const groupId = groupIdFromChatRef(chatRefFromInfo(aChatItem.chatInfo));
    if (!groupId) return;
    const contact = this.store.getByGroupId(groupId);
    if (!contact) return;

    const file = aChatItem.chatItem.file;
    const pending = this.pendingSimplexReceives.get(Number(file.fileId));
    const path = filePathFromFile(file) || pending?.path;
    if (!path) {
      await this.simplex.sendText(
        `#${groupId}`,
        '❌ SimpleX-Datei wurde empfangen, aber der lokale Dateipfad fehlt.'
      );
      return;
    }

    await this.#sendSimplexFileToWhatsApp(aChatItem, contact, path);
    this.pendingSimplexReceives.delete(Number(file.fileId));
  }

  async #sendSimplexFileToWhatsApp(aChatItem, contact, path) {
    const chatItem = aChatItem.chatItem;
    const file = chatItem.file;
    const caption = messageContentText(chatItem.content?.msgContent)?.trim() || '';
    const fileName = safeFileName(file.fileName || path);
    const mimeType = mimeFromFileName(fileName);

    try {
      const result = await this.whatsapp.sendFile(contact.phone, {
        filePath: path,
        mimeType,
        fileName,
        caption,
        maxBytes: this.maxMediaBytes
      });
      this.logger.info('Forwarded SimpleX file to WhatsApp', {
        to: maskPhone(contact.phone),
        fileId: file.fileId,
        whatsappMessageId: result?.messages?.[0]?.id
      });
      if (contact.archived) this.store.setArchived(contact.phone, false);
    } catch (error) {
      this.logger.error('SimpleX media forwarding failed', {
        to: maskPhone(contact.phone),
        fileId: file.fileId,
        error: error.message
      });
      await this.simplex.sendText(
        `#${contact.simplexGroupId}`,
        `❌ Datei konnte nicht an WhatsApp gesendet werden.\n${safeError(error)}`
      );
    } finally {
      // Only remove paths that WA2SimpleX itself created. Never delete SimpleX-owned files.
      if (isManagedMediaPath(path, this.mediaDir)) removeTempFile(path, this.logger);
    }
  }

  #trackSimplexSend(response, path) {
    const fileIds = (response?.chatItems ?? [])
      .map(fileIdFromAChatItem)
      .filter(Number.isInteger);

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
    const timer = setTimeout(() => removeTempFile(path, this.logger), this.mediaRetentionMs);
    timer.unref?.();
  }

  async #mirrorPendingText(contact, phone, displayText, groupRef) {
    await this.simplex.sendText(this.controlTarget, [
      `📲 ${contact.displayName} · ${displayChatAddress(phone)}`,
      displayText,
      '',
      `⏳ Chat ${groupRef} wurde angelegt. Bitte die SimpleX-Gruppeneinladung einmalig annehmen.`,
      'Bis dahin werden neue Nachrichten zusätzlich hier gespiegelt.'
    ].join('\n'));
  }

  async #handleControlMessage(text, chatItem) {
    if (text === '/help' || text === '/wa') {
      await this.simplex.sendText(this.controlTarget, controlHelpText(this.mediaEnabled));
      return;
    }

    if (text === '/status') {
      const stats = this.store.stats();
      await this.simplex.sendText(this.controlTarget, [
        '⚡ WA2SimpleX Status',
        '',
        `Chats (Kontakte und Gruppen): ${stats.total}`,
        `Aktiv: ${stats.active}`,
        `Archiviert: ${stats.archived}`,
        `Bereite Kontakt-Chats: ${stats.ready}`,
        `Medien-Bridge: ${this.mediaEnabled ? 'aktiv' : 'aus'}`,
        `Medienlimit: ${formatBytes(this.maxMediaBytes)}`
      ].join('\n'));
      return;
    }

    if (text === '/contacts' || text === '/groups') {
      const contacts = this.store.listContacts(text === '/groups' ? 500 : 50);
      const selected = text === '/groups' ? contacts.filter(c => isWhatsAppGroup(c.phone)).slice(0, 50) : contacts;
      const lines = selected.length
        ? selected.map((contact) => `${contact.archived ? '📦' : contact.ready ? '🟢' : '🟡'} ${contact.displayName} · ${displayChatAddress(contact.phone)}${contact.simplexGroupId ? ` · #${contact.simplexGroupId}` : ''}`)
        : ['Noch keine passenden WhatsApp-Chats.'];
      await this.simplex.sendText(this.controlTarget, ['📇 WA2SimpleX Chats', '', ...lines].join('\n'));
      return;
    }

    const create = text.match(NEW_RE);
    if (create) {
      const phone = normalizeNumber(create[1]);
      const name = cleanDisplayName(create[2] || phone);
      const contact = await this.#ensureContactGroup(phone, name);
      await this.simplex.sendText(
        this.controlTarget,
        `✅ Kontakt-Chat #${contact.simplexGroupId} für ${contact.displayName} (+${contact.phone}) ist angelegt. Bitte die Gruppeneinladung annehmen.`
      );
      return;
    }

    const target = text.match(TARGET_RE);
    if (target) {
      await this.#handleTargetCommand(target[1].toLowerCase(), target[2]);
      return;
    }

    const explicit = parseWaCommand(text);
    if (explicit) {
      await this.#ensureContactGroup(explicit.phone, explicit.phone);
      await this.#sendToWhatsApp(explicit.phone, explicit.text, this.controlTarget);
      return;
    }

    const quotedPhone = extractMarker(messageContentText(chatItem?.quotedItem?.content) || '');
    if (quotedPhone) {
      await this.#ensureContactGroup(quotedPhone, quotedPhone);
      await this.#sendToWhatsApp(quotedPhone, text, this.controlTarget);
      return;
    }

    await this.simplex.sendText(
      this.controlTarget,
      'ℹ️ Das ist der WA2SimpleX-Control-Chat. Nutze /help für Befehle oder schreibe direkt im Kontakt-Chat.'
    );
  }

  async #handleContactChatCommand(contact, text) {
    const ref = `#${contact.simplexGroupId}`;

    if (text === '/help') {
      await this.simplex.sendText(ref, contactHelpText(contact, this.mediaEnabled));
      return;
    }
    if (text === '/info') {
      await this.simplex.sendText(ref, [
        `📱 ${contact.displayName}`,
        `WhatsApp: ${displayChatAddress(contact.phone)}`,
        `SimpleX: #${contact.simplexGroupId}`,
        `Status: ${contact.archived ? 'archiviert' : 'aktiv'}`,
        `Medien: ${this.mediaEnabled ? 'aktiv' : 'aus'}`
      ].join('\n'));
      return;
    }
    if (text === '/archive') {
      this.store.setArchived(contact.phone, true);
      await this.simplex.sendText(
        ref,
        '📦 Archiviert. Bei einer neuen WhatsApp-Nachricht wird der Chat automatisch wieder aktiviert.'
      );
      return;
    }

    const rename = text.match(RENAME_RE);
    if (rename) {
      const name = cleanDisplayName(rename[1]);
      await this.simplex.updateGroupName(
        contact.simplexGroupId,
        makeGroupName(this.groupPrefix, name, contact.phone)
      );
      this.store.rename(contact.phone, name);
      await this.simplex.sendText(ref, `✅ Kontaktname auf „${name}“ geändert.`);
      return;
    }

    await this.simplex.sendText(
      ref,
      'ℹ️ Unbekannter WA2SimpleX-Befehl. /help zeigt die lokalen Befehle. Befehle werden nicht an WhatsApp gesendet.'
    );
  }

  async #handleTargetCommand(command, rawTarget) {
    const contact = this.#resolveContact(rawTarget);
    if (!contact) {
      await this.simplex.sendText(
        this.controlTarget,
        `❌ Kein WA2SimpleX-Kontakt für „${rawTarget.trim()}“ gefunden.`
      );
      return;
    }

    if (command === 'archive') {
      this.store.setArchived(contact.phone, true);
      await this.simplex.sendText(this.controlTarget, `📦 ${contact.displayName} archiviert.`);
      return;
    }
    if (command === 'unarchive') {
      this.store.setArchived(contact.phone, false);
      await this.simplex.sendText(this.controlTarget, `📤 ${contact.displayName} wieder aktiviert.`);
      return;
    }
    if (command === 'repair') {
      this.store.clearGroup(contact.phone);
      const repaired = await this.#ensureContactGroup(contact.phone, contact.displayName);
      await this.simplex.sendText(
        this.controlTarget,
        `🛠️ Neuer SimpleX-Chat #${repaired.simplexGroupId} für ${repaired.displayName} erstellt. Bitte die neue Einladung annehmen.`
      );
    }
  }

  #resolveContact(rawTarget) {
    const target = String(rawTarget || '').trim();
    if (/^#\d+$/.test(target)) return this.store.getByGroupId(Number(target.slice(1)));
    const phone = normalizeNumber(target);
    return phone ? this.store.getContact(phone) : null;
  }

  async #ensureContactGroup(phone, displayName) {
    const normalized = normalizeNumber(phone);
    const previous = this.store.getContact(normalized);
    const existing = this.store.upsertContact(normalized, displayName || normalized);
    if (isWhatsAppGroup(normalized) && previous?.simplexGroupId && previous.displayName !== existing.displayName) {
      await this.simplex.updateGroupName(previous.simplexGroupId, makeGroupName(this.groupPrefix, existing.displayName, normalized))
        .catch(error => this.logger.warn('Could not refresh WhatsApp group title', { error: error.message }));
    }
    if (existing.simplexGroupId) return existing;
    if (this.contactLocks.has(normalized)) return this.contactLocks.get(normalized);

    const pending = this.#createContactGroup(existing)
      .finally(() => this.contactLocks.delete(normalized));
    this.contactLocks.set(normalized, pending);
    return pending;
  }

  async #createContactGroup(contact) {
    const groupName = makeGroupName(this.groupPrefix, contact.displayName, contact.phone);
    const groupInfo = await this.simplex.createGroup({
      displayName: groupName,
      description: isWhatsAppGroup(contact.phone)
        ? `WhatsApp group bridge: ${contact.displayName}. Replies go to the WhatsApp group using the linked account. WhatsApp participants are not added to this SimpleX group.`
        : `Private WA2SimpleX bridge for +${contact.phone}. No WhatsApp message history is stored by WA2SimpleX.`
    });
    const groupId = groupInfo.groupId;

    await this.simplex.addMember(groupId, this.ownerContactId, 'admin');
    await this.simplex.setGroupCustomData(groupId, {
      wa2simplex: {
        version: 3,
        chatId: contact.phone,
        kind: isWhatsAppGroup(contact.phone) ? 'group' : 'direct',
        phone: contact.phone,
        displayName: contact.displayName
      }
    }).catch((error) => {
      this.logger.warn('Could not set SimpleX group custom data', { groupId, error: error.message });
    });

    const bound = this.store.bindGroup(contact.phone, groupId);
    this.logger.info('Created SimpleX contact chat', {
      phone: maskPhone(contact.phone),
      groupId
    });
    return bound;
  }

  async #refreshReady(contact) {
    if (contact.ready || !contact.simplexGroupId) return contact;
    try {
      const response = await this.simplex.listGroupMembers(contact.simplexGroupId);
      const members = response?.group?.members ?? response?.members ?? [];
      const owner = members.find(
        (member) => Number(member?.memberContactId) === Number(this.ownerContactId)
      );
      if (owner && READY_STATUSES.has(owner.memberStatus)) {
        return this.store.setReadyByGroup(contact.simplexGroupId, true);
      }
    } catch (error) {
      this.logger.debug('Could not refresh SimpleX group member status', {
        groupId: contact.simplexGroupId,
        error: error.message
      });
    }
    return contact;
  }

  #observeMembershipEvent(event) {
    const groupId = Number(
      event?.groupInfo?.groupId ||
      event?.group?.groupInfo?.groupId ||
      event?.member?.groupId ||
      0
    );
    const member = event?.member;
    if (!groupId || !member) return;
    if (Number(member.memberContactId) !== Number(this.ownerContactId)) return;
    if (READY_STATUSES.has(member.memberStatus)) this.store.setReadyByGroup(groupId, true);
  }

  async #sendToWhatsApp(phone, text, errorTarget) {
    const normalized = normalizeNumber(phone);
    try {
      const result = await this.whatsapp.sendText(normalized, text);
      this.logger.info('Forwarded SimpleX message to WhatsApp', {
        to: maskPhone(normalized),
        whatsappMessageId: result?.messages?.[0]?.id
      });
    } catch (error) {
      this.logger.error('WhatsApp send failed', {
        to: maskPhone(normalized),
        error: error.message
      });
      await this.simplex.sendText(
        errorTarget || this.controlTarget,
        `❌ WhatsApp-Versand an ${displayChatAddress(normalized)} fehlgeschlagen.\n${safeError(error)}`
      );
    }
  }
}

export function parseWaCommand(text) {
  const match = String(text).match(COMMAND_RE);
  return match ? { phone: normalizeNumber(match[1]), text: match[2].trim() } : null;
}

export function extractMarker(text) {
  return String(text || '').match(MARKER_RE)?.[1] || null;
}

export function chatRefFromInfo(chatInfo) {
  if (chatInfo?.type === 'direct' && Number.isInteger(chatInfo.contact?.contactId)) {
    return `@${chatInfo.contact.contactId}`;
  }
  if (chatInfo?.type === 'group' && Number.isInteger(chatInfo.groupInfo?.groupId)) {
    return `#${chatInfo.groupInfo.groupId}`;
  }
  return null;
}

export function messageContentText(content) {
  if (!content || typeof content !== 'object') return '';
  if (typeof content.text === 'string') return content.text;
  if (typeof content.msgContent?.text === 'string') return content.msgContent.text;
  return '';
}

export function makeGroupName(prefix, displayName, phone) {
  const name = cleanDisplayName(displayName || phone).slice(0, 42);
  if (isWhatsAppGroup(phone)) return `${cleanDisplayName(prefix || 'WA')} Gruppe · ${name} · ${phone.split('@')[0].slice(-4)}`.slice(0, 64);
  const suffix = normalizeNumber(phone).slice(-4) || 'WA';
  return `${cleanDisplayName(prefix || 'WA')} · ${name} · ${suffix}`.slice(0, 64);
}

export function filePathFromFile(file) {
  return file?.fileSource?.filePath || file?.fileStatus?.filePath || file?.fileStatus?.filePath_ || null;
}

export function fileIdFromAChatItem(aChatItem) {
  const id = aChatItem?.chatItem?.file?.fileId;
  return Number.isInteger(id) ? id : null;
}

function groupIdFromChatRef(chatRef) {
  return /^#\d+$/.test(chatRef || '') ? Number(chatRef.slice(1)) : null;
}

function isReceived(type) {
  return ['directRcv', 'groupRcv', 'localRcv', 'channelRcv'].includes(type);
}

function normalizeNumber(value) {
  return normalizeChatAddress(value);
}

function incomingText(message, text) {
  return isWhatsAppGroup(message.from) ? `${cleanDisplayName(message.senderName || 'Teilnehmer')}:\n${text}` : text;
}

function cleanDisplayName(value) {
  return String(value || 'WhatsApp')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'WhatsApp';
}

function maskPhone(phone) {
  const value = String(phone);
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/EA[A-Za-z0-9_-]{10,}/g, '[token-redacted]')
    .slice(0, 800);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function mediaLabel(kind, fileName) {
  const icons = { image: '🖼️', video: '🎬', audio: '🎵', document: '📎', sticker: '🧩' };
  return `${icons[kind] || '📎'} ${fileName}`;
}

function controlHelpText(mediaEnabled) {
  return [
    '⚡ WA2SimpleX Control',
    '',
    '/status — Status und Kontaktzahlen',
    '/contacts — WhatsApp-Kontakte und Gruppen',
    '/groups — bereits verknüpfte WhatsApp-Gruppen',
    '/new +491701234567 Max — Kontakt-Chat vorab anlegen',
    '/archive +491701234567 — Kontakt archivieren',
    '/unarchive +491701234567 — Archivierung aufheben',
    '/repair +491701234567 — SimpleX-Chat neu erstellen',
    '/repair #12 — zugeordneten SimpleX-Chat neu erstellen (auch Gruppen)',
    '/wa +491701234567 Nachricht — direkte WhatsApp-Nachricht',
    '',
    `Medien-Bridge: ${mediaEnabled ? 'aktiv — Dateien im Kontakt-Chat werden übertragen' : 'deaktiviert'}`,
    'Im Normalfall schreibst du direkt im jeweiligen WA-Kontakt-Chat.'
  ].join('\n');
}

function contactHelpText(contact, mediaEnabled) {
  return [
    `📱 ${contact.displayName}`,
    '',
    'Schreibe hier einfach deine Nachricht — sie wird an WhatsApp weitergeleitet.',
    mediaEnabled
      ? 'Bilder, Videos, Audio und Dateien kannst du hier ebenfalls senden.'
      : 'Medienübertragung ist deaktiviert.',
    '',
    '/info — Zuordnung anzeigen',
    '/rename Neuer Name — lokalen Kontakt-Chat umbenennen',
    '/archive — Chat archivieren',
    '/help — diese Hilfe',
    '',
    'WA2SimpleX-Befehle werden nie an WhatsApp weitergeleitet.'
  ].join('\n');
}
