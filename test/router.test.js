import test from 'node:test';
import assert from 'node:assert/strict';
import { chatRefFromInfo, extractMarker, messageContentText, parseWaCommand } from '../src/router.js';

test('parses explicit /wa command', () => {
  assert.deepEqual(parseWaCommand('/wa +49 170 1234567 Hallo Welt'), {
    phone: '491701234567',
    text: 'Hallo Welt'
  });
});

test('extracts WhatsApp marker from quoted message', () => {
  assert.equal(extractMarker('Von: +491701234567\n⟦WA:491701234567⟧\nHallo'), '491701234567');
});

test('derives SimpleX direct and group refs', () => {
  assert.equal(chatRefFromInfo({ type: 'direct', contact: { contactId: 9 } }), '@9');
  assert.equal(chatRefFromInfo({ type: 'group', groupInfo: { groupId: 4 } }), '#4');
});

test('extracts received SimpleX text', () => {
  assert.equal(messageContentText({ type: 'rcvMsgContent', msgContent: { type: 'text', text: 'Hi' } }), 'Hi');
  assert.equal(messageContentText({ type: 'text', text: 'quoted' }), 'quoted');
});
