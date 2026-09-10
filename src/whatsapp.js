import crypto from 'node:crypto';

export class WhatsAppClient {
  constructor({ accessToken, phoneNumberId, apiVersion, logger }) {
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.apiVersion = apiVersion;
    this.logger = logger;
    this.baseUrl = `https://graph.facebook.com/${apiVersion}`;
  }

  async sendText(to, text) {
    return this.#request(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizeWhatsAppNumber(to),
      type: 'text',
      text: { preview_url: false, body: text }
    });
  }

  async markRead(messageId) {
    return this.#request(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    });
  }

  async #request(path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`WhatsApp API ${response.status}: ${JSON.stringify(payload)}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
}

export function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !signatureHeader || !appSecret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const provided = String(signatureHeader);
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

export function normalizeWhatsAppNumber(value) {
  return String(value).replace(/[^0-9]/g, '');
}

export function extractWhatsAppMessages(payload) {
  const messages = [];

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      const value = change?.value ?? {};
      const contacts = new Map((value.contacts ?? []).map((c) => [c.wa_id, c]));

      for (const message of value.messages ?? []) {
        const contact = contacts.get(message.from);
        messages.push({
          id: message.id,
          from: message.from,
          name: contact?.profile?.name || message.from,
          timestamp: message.timestamp,
          type: message.type,
          text: extractMessageText(message),
          raw: message
        });
      }
    }
  }

  return messages;
}

export function extractMessageText(message) {
  switch (message?.type) {
    case 'text':
      return message.text?.body || '';
    case 'button':
      return message.button?.text || message.button?.payload || '[Button]';
    case 'interactive':
      return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[Interactive response]';
    case 'image':
      return message.image?.caption ? `🖼️ ${message.image.caption}` : '🖼️ [Image]';
    case 'video':
      return message.video?.caption ? `🎬 ${message.video.caption}` : '🎬 [Video]';
    case 'audio':
      return '🎵 [Audio]';
    case 'voice':
      return '🎙️ [Voice message]';
    case 'document':
      return `📎 [Document${message.document?.filename ? `: ${message.document.filename}` : ''}]${message.document?.caption ? ` ${message.document.caption}` : ''}`;
    case 'sticker':
      return '🧩 [Sticker]';
    case 'location': {
      const { latitude, longitude, name, address } = message.location ?? {};
      return `📍 ${name || 'Location'}${address ? ` — ${address}` : ''}${latitude != null && longitude != null ? ` (${latitude}, ${longitude})` : ''}`;
    }
    case 'contacts':
      return `👤 [Contact${message.contacts?.[0]?.name?.formatted_name ? `: ${message.contacts[0].name.formatted_name}` : ''}]`;
    case 'reaction':
      return `↩️ [Reaction: ${message.reaction?.emoji || 'removed'}]`;
    default:
      return `[Unsupported WhatsApp message type: ${message?.type || 'unknown'}]`;
  }
}
