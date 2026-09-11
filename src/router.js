const MARKER_RE = /⟦WA:(\d{6,20})⟧/;
const COMMAND_RE = /^\/wa\s+([+\d][\d\s().-]{5,24})\s+([\s\S]+)$/i;
const NEW_RE = /^\/new\s+([+\d][\d\s().-]{5,24})(?:\s+([\s\S]+))?$/i;
const TARGET_RE = /^\/(archive|unarchive|repair)\s+(.+)$/i;
const RENAME_RE = /^\/rename\s+([\s\S]+)$/i;
const READY_STATUSES = new Set(['connected', 'complete', 'creator']);

export class BridgeRouter {
  constructor({ simplex, whatsapp, store, controlTarget, ownerContactId, groupPrefix = 'WA', markWhatsAppRead = true, logger }) {
    this.simplex = simplex;
    this.whatsapp = whatsapp;
    this.store = store;
    this.controlTarget = controlTarget;
    this.ownerContactId = ownerContactId;
    this.groupPrefix = groupPrefix;
    this.markWhatsAppRead = markWhatsAppRead;
    this.logger = logger;
    this.contactLocks = new Map();
  }

  async initialize() {
    this.store.pruneProcessedMessages();
    try {
      const groups = await this.simplex.listGroups();
      let recovered = 0;
      for (const group of groups) {
        const meta = group?.customData?.wa2simplex;
        const phone = normalizeNumber(meta?.phone);
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
    if (!message?.id || !this.store.claimMessage(message.id)) return;

    const phone = normalizeNumber(message.from);
    if (!phone) return;
    const displayName = cleanDisplayName(message.name || phone);
    let contact = await this.#ensureContactGroup(phone, displayName);

    if (contact.archived) contact = this.store.setArchived(phone, false);
    if (!contact.ready) contact = await this.#refreshReady(contact);

    const displayText = message.text || `[${message.type || 'message'}]`;
    const groupRef = `#${contact.simplexGroupId}`;
    await this.simplex.sendText(groupRef, displayText);

    if (!contact.ready) {
      await this.simplex.sendText(this.controlTarget, [
        `📲 ${contact.displayName} · +${phone}`,
        displayText,
        '',
        `⏳ Chat ${groupRef} wurde angelegt. Bitte die SimpleX-Gruppeneinladung einmalig annehmen.`,
        'Bis dahin werden neue Nachrichten zusätzlich hier gespiegelt.'
      ].join('\n'));
    }

    this.logger.info('Forwarded WhatsApp message to SimpleX contact chat', {
      whatsappMessageId: message.id,
      from: maskPhone(phone),
      simplexGroupId: contact.simplexGroupId,
      ready: contact.ready,
      type: message.type
    });

    if (this.markWhatsAppRead) {
      this.whatsapp.markRead(message.id).catch((error) => {
        this.logger.warn('Could not mark WhatsApp message as read', { error: error.message });
      });
    }
  }

  async handleSimplexEvent(event) {
    this.#observeMembershipEvent(event);
    if (event?.type !== 'newChatItems') return;

    for (const item of event.chatItems ?? []) {
      const chatRef = chatRefFromInfo(item.chatInfo);
      const chatItem = item.chatItem;
      if (!isReceived(chatItem?.chatDir?.type)) continue;
      if (chatItem?.content?.type !== 'rcvMsgContent') continue;
      const text = messageContentText(chatItem.content.msgContent)?.trim();
      if (!text) continue;

      if (chatRef === this.controlTarget) {
        await this.#handleControlMessage(text, chatItem);
        continue;
      }

      const groupId = groupIdFromChatRef(chatRef);
      if (!groupId) continue;
      const contact = this.store.getByGroupId(groupId);
      if (!contact) continue;

      this.store.setReadyByGroup(groupId, true);
      if (text.startsWith('/')) {
        await this.#handleContactChatCommand(contact, text);
        continue;
      }

      if (contact.archived) this.store.setArchived(contact.phone, false);
      await this.#sendToWhatsApp(contact.phone, text, `#${groupId}`);
    }
  }

  async #handleControlMessage(text, chatItem) {
    if (text === '/help' || text === '/wa') {
      await this.simplex.sendText(this.controlTarget, controlHelpText());
      return;
    }

    if (text === '/status') {
      const stats = this.store.stats();
      await this.simplex.sendText(this.controlTarget, [
        '⚡ WA2SimpleX Status',
        '',
        `Kontakte: ${stats.total}`,
        `Aktiv: ${stats.active}`,
        `Archiviert: ${stats.archived}`,
        `Bereite Kontakt-Chats: ${stats.ready}`
      ].join('\n'));
      return;
    }

    if (text === '/contacts') {
      const contacts = this.store.listContacts(50);
      const lines = contacts.length
        ? contacts.map((c) => `${c.archived ? '📦' : c.ready ? '🟢' : '🟡'} ${c.displayName} · +${c.phone}${c.simplexGroupId ? ` · #${c.simplexGroupId}` : ''}`)
        : ['Noch keine WhatsApp-Kontakte.'];
      await this.simplex.sendText(this.controlTarget, ['📇 WA2SimpleX Kontakte', '', ...lines].join('\n'));
      return;
    }

    const create = text.match(NEW_RE);
    if (create) {
      const phone = normalizeNumber(create[1]);
      const name = cleanDisplayName(create[2] || phone);
      const contact = await this.#ensureContactGroup(phone, name);
      await this.simplex.sendText(this.controlTarget, `✅ Kontakt-Chat #${contact.simplexGroupId} für ${contact.displayName} (+${contact.phone}) ist angelegt. Bitte die Gruppeneinladung annehmen.`);
      return;
    }

    const targetCommand = text.match(TARGET_RE);
    if (targetCommand) {
      await this.#handleTargetCommand(targetCommand[1].toLowerCase(), targetCommand[2]);
      return;
    }

    const explicit = parseWaCommand(text);
    if (explicit) {
      await this.#ensureContactGroup(explicit.phone, explicit.phone);
      await this.#sendToWhatsApp(explicit.phone, explicit.text, this.controlTarget);
      return;
    }

    const quotedText = messageContentText(chatItem?.quotedItem?.content) || '';
    const quotedPhone = extractMarker(quotedText);
    if (quotedPhone) {
      await this.#ensureContactGroup(quotedPhone, quotedPhone);
      await this.#sendToWhatsApp(quotedPhone, text, this.controlTarget);
      return;
    }

    await this.simplex.sendText(this.controlTarget, 'ℹ️ Das ist der WA2SimpleX-Control-Chat. Nutze /help für Befehle oder schreibe direkt im Kontakt-Chat.');
  }

  async #handleContactChatCommand(contact, text) {
    if (text === '/help') {
      await this.simplex.sendText(`#${contact.simplexGroupId}`, contactHelpText(contact));
      return;
    }
    if (text === '/info') {
      await this.simplex.sendText(`#${contact.simplexGroupId}`, [
        `📱 ${contact.displayName}`,
        `WhatsApp: +${contact.phone}`,
        `SimpleX: #${contact.simplexGroupId}`,
        `Status: ${contact.archived ? 'archiviert' : 'aktiv'}`
      ].join('\n'));
      return;
    }
    if (text === '/archive') {
      this.store.setArchived(contact.phone, true);
      await this.simplex.sendText(`#${contact.simplexGroupId}`, '📦 Archiviert. Bei einer neuen WhatsApp-Nachricht wird der Chat automatisch wieder aktiviert.');
      return;
    }
    const rename = text.match(RENAME_RE);
    if (rename) {
      const name = cleanDisplayName(rename[1]);
      const groupName = makeGroupName(this.groupPrefix, name, contact.phone);
      await this.simplex.updateGroupName(contact.simplexGroupId, groupName);
      this.store.rename(contact.phone, name);
      await this.simplex.sendText(`#${contact.simplexGroupId}`, `✅ Kontaktname auf „${name}“ geändert.`);
      return;
    }
    await this.simplex.sendText(`#${contact.simplexGroupId}`, 'ℹ️ Unbekannter WA2SimpleX-Befehl. /help zeigt die lokalen Befehle. Befehle werden nicht an WhatsApp gesendet.');
  }

  async #handleTargetCommand(command, rawTarget) {
    const contact = this.#resolveContact(rawTarget);
    if (!contact) {
      await this.simplex.sendText(this.controlTarget, `❌ Kein WA2SimpleX-Kontakt für „${rawTarget.trim()}“ gefunden.`);
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
      await this.simplex.sendText(this.controlTarget, `🛠️ Neuer SimpleX-Chat #${repaired.simplexGroupId} für ${repaired.displayName} erstellt. Bitte die neue Einladung annehmen.`);
    }
  }

  #resolveContact(rawTarget) {
    const target = String(rawTarget || '').trim();
    if (/^#\d+$/.test(target)) return this.store.getByGroupId(Number(target.slice(1)));
    const phone = normalizeNumber(target);
    if (phone) return this.store.getContact(phone);
    return null;
  }

  async #ensureContactGroup(phone, displayName) {
    const normalized = normalizeNumber(phone);
    const existing = this.store.upsertContact(normalized, displayName || normalized);
    if (existing.simplexGroupId) return existing;

    if (this.contactLocks.has(normalized)) return this.contactLocks.get(normalized);
    const pending = this.#createContactGroup(existing).finally(() => this.contactLocks.delete(normalized));
    this.contactLocks.set(normalized, pending);
    return pending;
  }

  async #createContactGroup(contact) {
    const groupName = makeGroupName(this.groupPrefix, contact.displayName, contact.phone);
    const groupInfo = await this.simplex.createGroup({
      displayName: groupName,
      description: `Private WA2SimpleX bridge for +${contact.phone}. No WhatsApp message history is stored by WA2SimpleX.`
    });
    const groupId = groupInfo.groupId;
    await this.simplex.addMember(groupId, this.ownerContactId, 'admin');
    await this.simplex.setGroupCustomData(groupId, {
      wa2simplex: {
        version: 1,
        phone: contact.phone,
        displayName: contact.displayName
      }
    }).catch((error) => this.logger.warn('Could not set SimpleX group custom data', { groupId, error: error.message }));

    const bound = this.store.bindGroup(contact.phone, groupId);
    this.logger.info('Created SimpleX contact chat', { phone: maskPhone(contact.phone), groupId });
    return bound;
  }

  async #refreshReady(contact) {
    if (contact.ready || !contact.simplexGroupId) return contact;
    try {
      const response = await this.simplex.listGroupMembers(contact.simplexGroupId);
      const members = response?.group?.members ?? response?.members ?? [];
      const owner = members.find((member) => Number(member?.memberContactId) === Number(this.ownerContactId));
      if (owner && READY_STATUSES.has(owner.memberStatus)) {
        return this.store.setReadyByGroup(contact.simplexGroupId, true);
      }
    } catch (error) {
      this.logger.debug('Could not refresh SimpleX group member status', { groupId: contact.simplexGroupId, error: error.message });
    }
    return contact;
  }

  #observeMembershipEvent(event) {
    const groupId = Number(event?.groupInfo?.groupId || event?.group?.groupInfo?.groupId || event?.member?.groupId || 0);
    const member = event?.member;
    if (!groupId || !member) return;
    if (Number(member.memberContactId) !== Number(this.ownerContactId)) return;
    if (READY_STATUSES.has(member.memberStatus)) this.store.setReadyByGroup(groupId, true);
  }

  async #sendToWhatsApp(phone, text, errorTarget) {
    const normalized = normalizeNumber(phone);
    try {
      const result = await this.whatsapp.sendText(normalized, text);
      this.logger.info('Forwarded SimpleX message to WhatsApp', { to: maskPhone(normalized), whatsappMessageId: result?.messages?.[0]?.id });
    } catch (error) {
      this.logger.error('WhatsApp send failed', { to: maskPhone(normalized), error: error.message });
      await this.simplex.sendText(errorTarget || this.controlTarget, `❌ WhatsApp-Versand an +${normalized} fehlgeschlagen.\n${safeError(error)}`);
    }
  }
}

export function parseWaCommand(text) {
  const match = String(text).match(COMMAND_RE);
  if (!match) return null;
  return { phone: normalizeNumber(match[1]), text: match[2].trim() };
}

export function extractMarker(text) { return String(text || '').match(MARKER_RE)?.[1] || null; }

export function chatRefFromInfo(chatInfo) {
  if (chatInfo?.type === 'direct' && Number.isInteger(chatInfo.contact?.contactId)) return `@${chatInfo.contact.contactId}`;
  if (chatInfo?.type === 'group' && Number.isInteger(chatInfo.groupInfo?.groupId)) return `#${chatInfo.groupInfo.groupId}`;
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
  const suffix = normalizeNumber(phone).slice(-4) || 'WA';
  return `${cleanDisplayName(prefix || 'WA')} · ${name} · ${suffix}`.slice(0, 64);
}

function groupIdFromChatRef(chatRef) { return /^#\d+$/.test(chatRef || '') ? Number(chatRef.slice(1)) : null; }
function isReceived(type) { return type === 'directRcv' || type === 'groupRcv' || type === 'localRcv' || type === 'channelRcv'; }
function normalizeNumber(value) { return String(value || '').replace(/[^0-9]/g, ''); }
function cleanDisplayName(value) { return String(value || 'WhatsApp').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'WhatsApp'; }
function maskPhone(phone) { const value = String(phone); return value.length <= 6 ? '***' : `${value.slice(0, 3)}***${value.slice(-3)}`; }
function safeError(error) { return String(error?.message || error || 'unknown error').replace(/EA[A-Za-z0-9_-]{10,}/g, '[token-redacted]').slice(0, 800); }

function controlHelpText() {
  return [
    '⚡ WA2SimpleX Control', '',
    '/status — Status und Kontaktzahlen',
    '/contacts — WhatsApp-Kontakte und SimpleX-Chats',
    '/new +491701234567 Max — Kontakt-Chat vorab anlegen',
    '/archive +491701234567 — Kontakt archivieren',
    '/unarchive +491701234567 — Archivierung aufheben',
    '/repair +491701234567 — SimpleX-Chat neu erstellen',
    '/wa +491701234567 Nachricht — direkte WhatsApp-Nachricht', '',
    'Im Normalfall schreibst du direkt im jeweiligen WA-Kontakt-Chat.'
  ].join('\n');
}

function contactHelpText(contact) {
  return [
    `📱 ${contact.displayName}`, '',
    'Schreibe hier einfach deine Nachricht — sie wird an WhatsApp weitergeleitet.', '',
    '/info — Zuordnung anzeigen',
    '/rename Neuer Name — lokalen Kontakt-Chat umbenennen',
    '/archive — Chat archivieren',
    '/help — diese Hilfe', '',
    'WA2SimpleX-Befehle werden nie an WhatsApp weitergeleitet.'
  ].join('\n');
}
