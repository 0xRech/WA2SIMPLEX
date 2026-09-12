export function isWhatsAppGroup(value) {
  return /^\d{5,30}(?:-\d{5,20})?@g\.us$/.test(String(value || ''));
}

// Preserve group IDs verbatim. Never strip an arbitrary JID into a phone number.
export function normalizeChatAddress(value) {
  const text = String(value || '').trim();
  if (isWhatsAppGroup(text)) return text;
  if (!/^[+\d\s().-]+$/.test(text)) return '';
  const phone = text.replace(/\D/g, '');
  return /^\d{6,20}$/.test(phone) ? phone : '';
}

export function displayChatAddress(value) {
  return isWhatsAppGroup(value) ? 'WhatsApp-Gruppe' : `+${value}`;
}
