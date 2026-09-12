import crypto from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { safeFileName, whatsappMediaType } from './media.js';

export class WhatsAppClient {
  constructor({ accessToken, phoneNumberId, apiVersion, logger }) {
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.apiVersion = apiVersion;
    this.logger = logger;
    this.baseUrl = `https://graph.facebook.com/${apiVersion}`;
  }

  async sendText(to, text) {
    if (String(to).includes('@')) throw new Error('Cloud provider supports phone numbers only');
    return this.#jsonRequest(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizeWhatsAppNumber(to),
      type: 'text',
      text: { preview_url: false, body: String(text) }
    });
  }

  async markRead(messageId) {
    return this.#jsonRequest(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId
    });
  }

  async getMediaMetadata(mediaId) {
    const response = await fetch(`${this.baseUrl}/${encodeURIComponent(mediaId)}`, {
      headers: this.#authHeaders()
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw apiError(response.status, payload);
    return payload;
  }

  async downloadMedia(mediaId, maxBytes) {
    const metadata = await this.getMediaMetadata(mediaId);
    const declared = Number(metadata.file_size || 0);
    if (maxBytes && declared > maxBytes) {
      throw new Error(`WhatsApp media exceeds configured limit (${declared} > ${maxBytes} bytes)`);
    }

    const response = await fetch(metadata.url, { headers: this.#authHeaders() });
    if (!response.ok) throw new Error(`WhatsApp media download failed with HTTP ${response.status}`);

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (maxBytes && contentLength > maxBytes) {
      throw new Error(`WhatsApp media exceeds configured limit (${contentLength} > ${maxBytes} bytes)`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (maxBytes && buffer.length > maxBytes) {
      throw new Error(`WhatsApp media exceeds configured limit (${buffer.length} > ${maxBytes} bytes)`);
    }

    return {
      buffer,
      mimeType: metadata.mime_type || response.headers.get('content-type') || 'application/octet-stream',
      fileSize: buffer.length,
      sha256: metadata.sha256
    };
  }

  async uploadMedia(filePath, { mimeType = 'application/octet-stream', fileName, maxBytes } = {}) {
    const info = await stat(filePath);
    if (maxBytes && info.size > maxBytes) {
      throw new Error(`SimpleX file exceeds configured limit (${info.size} > ${maxBytes} bytes)`);
    }

    const data = await readFile(filePath);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([data], { type: mimeType }), safeFileName(fileName || filePath));

    const response = await fetch(`${this.baseUrl}/${this.phoneNumberId}/media`, {
      method: 'POST',
      headers: this.#authHeaders(),
      body: form
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw apiError(response.status, payload);
    if (!payload.id) throw new Error('WhatsApp media upload returned no media ID');
    return payload.id;
  }

  async sendFile(to, { filePath, mimeType, fileName, caption = '', maxBytes } = {}) {
    if (String(to).includes('@')) throw new Error('Cloud provider supports phone numbers only');
    const type = whatsappMediaType(mimeType, fileName || filePath);
    const mediaId = await this.uploadMedia(filePath, { mimeType, fileName, maxBytes });
    const media = { id: mediaId };

    if (type === 'document') media.filename = safeFileName(fileName || filePath);
    if ((type === 'document' || type === 'image' || type === 'video') && caption) {
      media.caption = String(caption).slice(0, 1024);
    }

    const result = await this.#jsonRequest(`/${this.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizeWhatsAppNumber(to),
      type,
      [type]: media
    });

    // WhatsApp audio messages do not carry a caption field; keep the text as a separate message.
    if (type === 'audio' && caption) await this.sendText(to, caption);
    return result;
  }

  async #jsonRequest(path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { ...this.#authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw apiError(response.status, payload);
    return payload;
  }

  #authHeaders() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

export function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !signatureHeader || !appSecret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(String(signatureHeader));
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
          media: extractWhatsAppMedia(message),
          raw: message
        });
      }
    }
  }
  return messages;
}

export function extractWhatsAppMedia(message) {
  const type = message?.type;
  if (!['image', 'video', 'audio', 'voice', 'document', 'sticker'].includes(type)) return null;
  const source = message?.[type] || (type === 'voice' ? message?.audio : null);
  if (!source?.id) return null;
  return {
    id: source.id,
    kind: type === 'voice' ? 'audio' : type,
    mimeType: source.mime_type || null,
    fileName: source.filename || null,
    caption: source.caption || '',
    voice: Boolean(source.voice) || type === 'voice'
  };
}

export function extractMessageText(message) {
  switch (message?.type) {
    case 'text': return message.text?.body || '';
    case 'button': return message.button?.text || message.button?.payload || '[Button]';
    case 'interactive': return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[Interactive response]';
    case 'image': return message.image?.caption || '🖼️ Bild';
    case 'video': return message.video?.caption || '🎬 Video';
    case 'audio': return message.audio?.voice ? '🎙️ Sprachnachricht' : '🎵 Audio';
    case 'voice': return '🎙️ Sprachnachricht';
    case 'document': return message.document?.caption || `📎 ${message.document?.filename || 'Dokument'}`;
    case 'sticker': return '🧩 Sticker';
    case 'location': {
      const { latitude, longitude, name, address } = message.location ?? {};
      return `📍 ${name || 'Location'}${address ? ` — ${address}` : ''}${latitude != null && longitude != null ? ` (${latitude}, ${longitude})` : ''}`;
    }
    case 'contacts': return `👤 [Contact${message.contacts?.[0]?.name?.formatted_name ? `: ${message.contacts[0].name.formatted_name}` : ''}]`;
    case 'reaction': return `↩️ [Reaction: ${message.reaction?.emoji || 'removed'}]`;
    default: return `[Unsupported WhatsApp message type: ${message?.type || 'unknown'}]`;
  }
}

function apiError(status, payload) {
  const error = new Error(`WhatsApp API ${status}: ${JSON.stringify(payload)}`);
  error.status = status;
  error.payload = payload;
  return error;
}
