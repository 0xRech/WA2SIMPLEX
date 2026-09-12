const MEDIA = ['image', 'video', 'audio', 'document', 'sticker'];
export function phoneFromJid(jid) {
  const match = /^(\d{6,20})(?::\d+)?@s\.whatsapp\.net$/.exec(String(jid || ''));
  return match?.[1] || null;
}

export async function normalizeWebMessage(raw, resolveLid = async () => null) {
  const key = raw?.key;
  const jid = key?.remoteJid || '';
  if (!key?.id || key.fromMe || (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid'))) return null;
  let from = phoneFromJid(jid);
  if (!from && jid.endsWith('@lid')) from = phoneFromJid(key.remoteJidAlt) || phoneFromJid(await resolveLid(jid));
  if (!from) return null; // Never interpret a LID as a telephone number.
  let body = raw.message;
  for (let i = 0; i < 5; i++) {
    // View-once media is deliberately not copied to a persistent bridge.
    if (body?.viewOnceMessage || body?.viewOnceMessageV2 || body?.viewOnceMessageV2Extension) return null;
    const inner = body?.ephemeralMessage?.message || body?.documentWithCaptionMessage?.message;
    if (!inner) break;
    body = inner;
  }
  if (!body) return null;
  const id = `web:${from}:${key.id}`;
  const base = { id, from, name: raw.pushName || from, timestamp: String(raw.messageTimestamp || ''), raw };
  const text = body.conversation ?? body.extendedTextMessage?.text;
  if (typeof text === 'string' && text) return { ...base, type: 'text', text, media: null };
  for (const kind of MEDIA) {
    const media = body[`${kind}Message`];
    if (!media) continue;
    if (media.viewOnce) return null;
    return { ...base, type: kind, text: media.caption || `[${kind}]`, media: {
      id, kind, mimeType: media.mimetype || null, fileName: media.fileName || null,
      caption: media.caption || '', voice: Boolean(media.ptt)
    } };
  }
  if (body.locationMessage) {
    const l = body.locationMessage;
    return { ...base, type: 'location', text: `📍 ${l.name || 'Location'} (${l.degreesLatitude}, ${l.degreesLongitude})`, media: null };
  }
  return null; // Ignore receipts, protocol messages, reactions and unsupported events.
}

export async function readBoundedStream(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('WhatsApp media exceeds configured limit');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  } finally { stream.destroy?.(); }
}
