const MARKER_RE = /⟦WA:(\d{6,20})⟧/;
const COMMAND_RE = /^\/wa\s+([+\d][\d\s().-]{5,24})\s+([\s\S]+)$/i;

export class BridgeRouter {
  constructor({ simplex, whatsapp, simplexTarget, restrictToTarget = true, markWhatsAppRead = true, logger }) {
    this.simplex = simplex;
    this.whatsapp = whatsapp;
    this.simplexTarget = simplexTarget;
    this.restrictToTarget = restrictToTarget;
    this.markWhatsAppRead = markWhatsAppRead;
    this.logger = logger;
    this.seenWhatsAppIds = new Map();
    this.maxSeen = 5000;
  }

  async handleWhatsApp(message) {
    if (!message?.id || this.#alreadySeen(message.id)) return;
    this.#remember(message.id);

    const from = normalizeNumber(message.from);
    const displayText = message.text || `[${message.type || 'message'}]`;
    const bridgeText = [
      `📲 WhatsApp · ${message.name || from}`,
      `Von: +${from}`,
      `⟦WA:${from}⟧`,
      '',
      displayText,
      '',
      '↩️ Antworte in SimpleX direkt auf diese Nachricht.'
    ].join('\n');

    await this.simplex.sendText(this.simplexTarget, bridgeText);
    this.logger.info('Forwarded WhatsApp message to SimpleX', { whatsappMessageId: message.id, from: maskPhone(from), type: message.type });

    if (this.markWhatsAppRead) {
      this.whatsapp.markRead(message.id).catch((error) => {
        this.logger.warn('Could not mark WhatsApp message as read', { error: error.message });
      });
    }
  }

  async handleSimplexEvent(event) {
    if (event?.type !== 'newChatItems') return;

    for (const item of event.chatItems ?? []) {
      const chatRef = chatRefFromInfo(item.chatInfo);
      if (this.restrictToTarget && chatRef !== this.simplexTarget) continue;

      const chatItem = item.chatItem;
      if (!isReceived(chatItem?.chatDir?.type)) continue;
      if (chatItem?.content?.type !== 'rcvMsgContent') continue;

      const text = messageContentText(chatItem.content.msgContent)?.trim();
      if (!text) continue;

      if (text === '/help' || text === '/wa') {
        await this.simplex.sendText(this.simplexTarget, helpText());
        continue;
      }

      const explicit = parseWaCommand(text);
      if (explicit) {
        await this.#sendToWhatsApp(explicit.phone, explicit.text);
        continue;
      }

      const quotedText = messageContentText(chatItem?.quotedItem?.content) || '';
      const quotedPhone = extractMarker(quotedText);
      if (quotedPhone) {
        await this.#sendToWhatsApp(quotedPhone, text);
        continue;
      }

      this.logger.debug('Ignoring SimpleX message without WA route marker', { chatRef });
    }
  }

  async #sendToWhatsApp(phone, text) {
    const normalized = normalizeNumber(phone);
    try {
      const result = await this.whatsapp.sendText(normalized, text);
      this.logger.info('Forwarded SimpleX reply to WhatsApp', { to: maskPhone(normalized), whatsappMessageId: result?.messages?.[0]?.id });
    } catch (error) {
      this.logger.error('WhatsApp send failed', { to: maskPhone(normalized), error: error.message });
      await this.simplex.sendText(this.simplexTarget, `❌ WhatsApp-Versand an +${normalized} fehlgeschlagen.\n${safeError(error)}`);
    }
  }

  #alreadySeen(id) {
    return this.seenWhatsAppIds.has(id);
  }

  #remember(id) {
    this.seenWhatsAppIds.set(id, Date.now());
    while (this.seenWhatsAppIds.size > this.maxSeen) {
      this.seenWhatsAppIds.delete(this.seenWhatsAppIds.keys().next().value);
    }
  }
}

export function parseWaCommand(text) {
  const match = String(text).match(COMMAND_RE);
  if (!match) return null;
  return { phone: normalizeNumber(match[1]), text: match[2].trim() };
}

export function extractMarker(text) {
  return String(text || '').match(MARKER_RE)?.[1] || null;
}

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

function isReceived(type) {
  return type === 'directRcv' || type === 'groupRcv' || type === 'localRcv' || type === 'channelRcv';
}

function normalizeNumber(value) {
  return String(value).replace(/[^0-9]/g, '');
}

function maskPhone(phone) {
  const value = String(phone);
  if (value.length <= 6) return '***';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function safeError(error) {
  const message = String(error?.message || error || 'unknown error');
  return message.replace(/EA[A-Za-z0-9_-]{10,}/g, '[token-redacted]').slice(0, 800);
}

function helpText() {
  return [
    'WA2SimpleX Befehle',
    '',
    '• Am einfachsten: Auf eine weitergeleitete WhatsApp-Nachricht in SimpleX antworten.',
    '• Alternativ: /wa +491701234567 Deine Nachricht',
    '',
    'Normale SimpleX-Nachrichten ohne Zitat oder /wa werden nicht zu WhatsApp gesendet.'
  ].join('\n');
}
