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
