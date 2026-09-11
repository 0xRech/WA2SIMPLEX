import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeRouter, chatRefFromInfo, extractMarker, makeGroupName, messageContentText, parseWaCommand } from '../src/router.js';
import { BridgeStore } from '../src/storage.js';

function setup({ memberStatus = 'invited' } = {}) {
  const sentSimplex = [];
  const sentWhatsApp = [];
  let groupCreates = 0;
  const simplex = {
    async sendText(ref, text) { sentSimplex.push({ ref, text }); return {}; },
    async createGroup() { groupCreates += 1; return { groupId: 17, groupProfile: {} }; },
    async addMember() { return { type: 'sentGroupInvitation' }; },
    async setGroupCustomData() { return { type: 'cmdOk' }; },
    async listGroupMembers() { return { group: { members: [{ memberContactId: 2, memberStatus }] } }; },
    async listGroups() { return []; },
    async updateGroupName() { return {}; }
  };
  const whatsapp = {
    async sendText(to, text) { sentWhatsApp.push({ to, text }); return { messages: [{ id: 'wamid.out' }] }; },
    async markRead() { return {}; }
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const store = new BridgeStore(':memory:');
  const router = new BridgeRouter({ simplex, whatsapp, store, controlTarget: '@2', ownerContactId: 2, groupPrefix: 'WA', logger });
  return { router, store, sentSimplex, sentWhatsApp, groupCreates: () => groupCreates };
}

test('creates one SimpleX contact group on first WhatsApp message and reuses it', async () => {
  const ctx = setup();
  try {
    await ctx.router.handleWhatsApp({ id: 'in-1', from: '491701234567', name: 'Max', type: 'text', text: 'Hallo' });
    await ctx.router.handleWhatsApp({ id: 'in-2', from: '491701234567', name: 'Max', type: 'text', text: 'Noch da?' });
    assert.equal(ctx.groupCreates(), 1);
    assert.equal(ctx.store.getContact('491701234567').simplexGroupId, 17);
    assert.ok(ctx.sentSimplex.some((m) => m.ref === '#17' && m.text === 'Hallo'));
    assert.ok(ctx.sentSimplex.some((m) => m.ref === '@2' && m.text.includes('Gruppeneinladung')));
  } finally { ctx.store.close(); }
});

test('routes normal messages from mapped SimpleX group to WhatsApp without markers', async () => {
  const ctx = setup({ memberStatus: 'complete' });
  try {
    ctx.store.upsertContact('491701234567', 'Max');
    ctx.store.bindGroup('491701234567', 17);
    await ctx.router.handleSimplexEvent({
      type: 'newChatItems',
      chatItems: [{
        chatInfo: { type: 'group', groupInfo: { groupId: 17 } },
        chatItem: { chatDir: { type: 'groupRcv' }, content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: 'Antwort' } } }
      }]
    });
    assert.deepEqual(ctx.sentWhatsApp, [{ to: '491701234567', text: 'Antwort' }]);
    assert.equal(ctx.store.getContact('491701234567').ready, true);
  } finally { ctx.store.close(); }
});

test('control chat can create a new contact chat', async () => {
  const ctx = setup();
  try {
    await ctx.router.handleSimplexEvent({
      type: 'newChatItems',
      chatItems: [{
        chatInfo: { type: 'direct', contact: { contactId: 2 } },
        chatItem: { chatDir: { type: 'directRcv' }, content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: '/new +49 170 1234567 Max Test' } } }
      }]
    });
    const contact = ctx.store.getContact('491701234567');
    assert.equal(contact.displayName, 'Max Test');
    assert.equal(contact.simplexGroupId, 17);
  } finally { ctx.store.close(); }
});

test('keeps v0.1 parsing helpers for migration and fallback commands', () => {
  assert.deepEqual(parseWaCommand('/wa +49 170 1234567 Hallo Welt'), { phone: '491701234567', text: 'Hallo Welt' });
  assert.equal(extractMarker('⟦WA:491701234567⟧'), '491701234567');
  assert.equal(chatRefFromInfo({ type: 'direct', contact: { contactId: 9 } }), '@9');
  assert.equal(chatRefFromInfo({ type: 'group', groupInfo: { groupId: 4 } }), '#4');
  assert.equal(messageContentText({ type: 'text', text: 'quoted' }), 'quoted');
  assert.match(makeGroupName('WA', 'Max Mustermann', '491701234567'), /^WA · Max Mustermann · 4567$/);
});
