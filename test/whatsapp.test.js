import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { extractWhatsAppMessages, normalizeWhatsAppNumber, verifyMetaSignature } from '../src/whatsapp.js';

test('verifies Meta webhook signature', () => {
  const secret = 'test-secret';
  const body = Buffer.from('{"hello":"world"}');
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, signature, secret), true);
  assert.equal(verifyMetaSignature(body, 'sha256=deadbeef', secret), false);
});

test('extracts WhatsApp text message', () => {
  const payload = {
    entry: [{ changes: [{ field: 'messages', value: {
      contacts: [{ wa_id: '491701234567', profile: { name: 'Max' } }],
      messages: [{ id: 'wamid.1', from: '491701234567', timestamp: '1', type: 'text', text: { body: 'Hallo' } }]
    } }] }]
  };
  assert.deepEqual(extractWhatsAppMessages(payload)[0], {
    id: 'wamid.1', from: '491701234567', name: 'Max', timestamp: '1', type: 'text', text: 'Hallo', raw: payload.entry[0].changes[0].value.messages[0]
  });
});

test('normalizes phone numbers', () => {
  assert.equal(normalizeWhatsAppNumber('+49 (170) 123-4567'), '491701234567');
});
