import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeStore } from '../src/storage.js';

test('stores persistent contact routing metadata and deduplicates webhook ids', () => {
  const store = new BridgeStore(':memory:');
  try {
    const contact = store.upsertContact('491701234567', 'Max');
    assert.equal(contact.displayName, 'Max');
    assert.equal(contact.simplexGroupId, null);

    store.bindGroup('491701234567', 17);
    assert.equal(store.getByGroupId(17).phone, '491701234567');

    assert.equal(store.claimMessage('wamid.1'), true);
    assert.equal(store.claimMessage('wamid.1'), false);

    store.setReadyByGroup(17, true);
    store.setArchived('491701234567', true);
    const updated = store.getContact('491701234567');
    assert.equal(updated.ready, true);
    assert.equal(updated.archived, true);
  } finally {
    store.close();
  }
});

test('stores discovered WhatsApp groups and persistent group bridge mappings', () => {
  const store = new BridgeStore(':memory:');
  try {
    const observed = store.observeWhatsAppGroup('120363999999999@g.us', 'Projektgruppe');
    assert.equal(observed.isNew, true);
    assert.equal(observed.group.displayName, 'Projektgruppe');

    const seenAgain = store.observeWhatsAppGroup('120363999999999@g.us', 'Projektgruppe Neu');
    assert.equal(seenAgain.isNew, false);
    assert.equal(seenAgain.group.displayName, 'Projektgruppe Neu');

    assert.equal(store.listPendingGroups().length, 1);
    store.markDiscoveredGroupAnnounced('120363999999999@g.us');
    assert.ok(store.getDiscoveredGroup('120363999999999@g.us').announcedAt);

    store.upsertGroupBridge({
      whatsappJid: '120363999999999@g.us',
      simplexGroupId: 77,
      name: 'Projektgruppe Neu'
    });

    assert.equal(store.listPendingGroups().length, 0);
    assert.equal(store.getGroupBridgeBySimplex(77).whatsappJid, '120363999999999@g.us');

    store.setGroupBridgeEnabled('120363999999999@g.us', false);
    assert.equal(store.getGroupBridgeByWhatsApp('120363999999999@g.us').enabled, false);

    assert.equal(store.deleteGroupBridgeByWhatsApp('120363999999999@g.us'), true);
    assert.equal(store.listPendingGroups().length, 1);
  } finally {
    store.close();
  }
});
