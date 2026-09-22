import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupBridgeRouter, normalizeBridge } from '../src/group-bridge.js';
import { normalizeWebMessage } from '../src/whatsapp-web-message.js';
import { BridgeStore } from '../src/storage.js';

function setup({ withInitialBridge = true } = {}) {
  const sentSimplex = [];
  const sentWhatsApp = [];
  const sentSimplexFiles = [];
  const sentWhatsAppFiles = [];
  const receivedFiles = [];
  const mediaDir = mkdtempSync(join(tmpdir(), 'wa2group-'));
  const store = new BridgeStore(':memory:');
  let nextFileId = 10;

  const simplex = {
    async sendText(ref, text) {
      sentSimplex.push({ ref, text });
      return {};
    },
    async sendFile(ref, filePath, text) {
      const fileId = nextFileId++;
      sentSimplexFiles.push({ ref, filePath, text, fileId });
      return { chatItems: [{ chatItem: { file: { fileId } } }] };
    },
    async receiveFile(fileId, filePath) {
      receivedFiles.push({ fileId, filePath });
      return {};
    }
  };

  const whatsapp = {
    async sendText(to, text) {
      sentWhatsApp.push({ to, text });
      return {};
    },
    async sendFile(to, file) {
      sentWhatsAppFiles.push({ to, ...file });
      return {};
    },
    async downloadMedia() {
      return { buffer: Buffer.from('image'), mimeType: 'image/jpeg' };
    },
    async markRead() {}
  };

  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  if (withInitialBridge) {
    store.upsertGroupBridge({
      name: 'Referat',
      simplexGroupId: 42,
      whatsappJid: '120363123456789@g.us'
    });
  }

  const router = new GroupBridgeRouter({
    simplex,
    whatsapp,
    store,
    bridges: store.listGroupBridges(),
    controlTarget: '@2',
    mediaDir,
    maxMediaBytes: 1024 * 1024,
    logger
  });

  return {
    router,
    store,
    sentSimplex,
    sentWhatsApp,
    sentSimplexFiles,
    sentWhatsAppFiles,
    receivedFiles,
    close() {
      store.close();
      rmSync(mediaDir, { recursive: true, force: true });
    }
  };
}

const simplexText = (text, groupId = 42) => ({
  type: 'newChatItems',
  chatItems: [{
    chatInfo: { type: 'group', groupInfo: { groupId } },
    chatItem: {
      chatDir: {
        type: 'groupRcv',
        groupMember: { memberProfile: { displayName: 'Thorben' } }
      },
      content: {
        type: 'rcvMsgContent',
        msgContent: { type: 'text', text }
      }
    }
  }]
});

test('validates explicit group mappings', () => {
  assert.equal(
    normalizeBridge({ simplexGroupId: 42, whatsappJid: '120363123456789@g.us' }).simplexGroupId,
    42
  );
  assert.throws(() => normalizeBridge({ simplexGroupId: 0, whatsappJid: 'x@g.us' }));
});

test('normalizes WhatsApp group messages with participant identity', async () => {
  const message = await normalizeWebMessage({
    key: {
      id: 'g1',
      remoteJid: '120363123456789@g.us',
      participant: '491701234567@s.whatsapp.net',
      fromMe: false
    },
    pushName: 'Anna',
    message: { conversation: 'Hallo' }
  });
  assert.equal(message.groupJid, '120363123456789@g.us');
  assert.equal(message.from, '491701234567');
  assert.equal(message.name, 'Anna');
});

test('routes configured WhatsApp groups and discovers unknown groups', async () => {
  const ctx = setup();
  try {
    assert.equal(await ctx.router.handleWhatsApp({
      id: 'g2',
      groupJid: '120363123456789@g.us',
      from: '491701234567',
      name: 'Anna',
      type: 'text',
      text: 'Hallo'
    }), true);
    assert.deepEqual(ctx.sentSimplex[0], {
      ref: '#42',
      text: '🟢 Anna · WhatsApp\nHallo'
    });

    await ctx.router.handleWhatsApp({
      id: 'g3',
      groupJid: '999999999999@g.us',
      groupName: 'Testgruppe',
      from: '491701234567',
      text: 'nicht routen'
    });

    const pending = ctx.store.listPendingGroups();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].displayName, 'Testgruppe');
    assert.ok(ctx.sentSimplex.some(message =>
      message.ref === '@2' &&
      message.text.includes('🆕 WhatsApp-Gruppe erkannt') &&
      message.text.includes('999999999999@g.us')
    ));

    const noticesBefore = ctx.sentSimplex.filter(message =>
      message.ref === '@2' && message.text.includes('🆕 WhatsApp-Gruppe erkannt')
    ).length;
    await ctx.router.handleWhatsApp({
      id: 'g4',
      groupJid: '999999999999@g.us',
      groupName: 'Testgruppe',
      from: '491701234567',
      text: 'noch eine'
    });
    const noticesAfter = ctx.sentSimplex.filter(message =>
      message.ref === '@2' && message.text.includes('🆕 WhatsApp-Gruppe erkannt')
    ).length;
    assert.equal(noticesAfter, noticesBefore);
  } finally {
    ctx.close();
  }
});

test('binds a discovered WhatsApp group from the target SimpleX group and persists it', async () => {
  const ctx = setup({ withInitialBridge: false });
  try {
    await ctx.router.handleWhatsApp({
      id: 'discover-1',
      groupJid: '999999999999@g.us',
      groupName: 'Projektgruppe',
      from: '491701234567',
      type: 'text',
      text: 'Hallo'
    });

    await ctx.router.handleSimplexEvent(simplexText('/bridge bind 1', 77));

    const stored = ctx.store.getGroupBridgeBySimplex(77);
    assert.equal(stored.whatsappJid, '999999999999@g.us');
    assert.equal(stored.name, 'Projektgruppe');
    assert.ok(ctx.sentSimplex.some(message =>
      message.ref === '#77' && message.text.includes('✅ WhatsApp-Gruppe verbunden')
    ));

    await ctx.router.handleWhatsApp({
      id: 'after-bind',
      groupJid: '999999999999@g.us',
      groupName: 'Projektgruppe',
      from: '491701234567',
      name: 'Anna',
      type: 'text',
      text: 'Jetzt verbunden'
    });
    assert.ok(ctx.sentSimplex.some(message =>
      message.ref === '#77' && message.text === '🟢 Anna · WhatsApp\nJetzt verbunden'
    ));
  } finally {
    ctx.close();
  }
});

test('lists pending groups and supports binding from the control chat', async () => {
  const ctx = setup({ withInitialBridge: false });
  try {
    ctx.store.observeWhatsAppGroup('999999999999@g.us', 'Testgruppe');

    await ctx.router.handleSimplexEvent({
      type: 'newChatItems',
      chatItems: [{
        chatInfo: { type: 'direct', contact: { contactId: 2 } },
        chatItem: {
          chatDir: { type: 'directRcv' },
          content: {
            type: 'rcvMsgContent',
            msgContent: { type: 'text', text: '/bridge pending' }
          }
        }
      }]
    });
    assert.ok(ctx.sentSimplex.some(message =>
      message.ref === '@2' && message.text.includes('1. Testgruppe')
    ));

    await ctx.router.handleSimplexEvent({
      type: 'newChatItems',
      chatItems: [{
        chatInfo: { type: 'direct', contact: { contactId: 2 } },
        chatItem: {
          chatDir: { type: 'directRcv' },
          content: {
            type: 'rcvMsgContent',
            msgContent: { type: 'text', text: '/bridge bind 1 #81' }
          }
        }
      }]
    });

    assert.equal(ctx.store.getGroupBridgeBySimplex(81).whatsappJid, '999999999999@g.us');
  } finally {
    ctx.close();
  }
});

test('routes SimpleX group text to WhatsApp group and persists pause/resume', async () => {
  const ctx = setup();
  try {
    await ctx.router.handleSimplexEvent(simplexText('Termin 14 Uhr?'));
    assert.deepEqual(ctx.sentWhatsApp, [{
      to: '120363123456789@g.us',
      text: '🟣 Thorben · SimpleX\nTermin 14 Uhr?'
    }]);

    await ctx.router.handleSimplexEvent(simplexText('/bridge pause'));
    assert.equal(ctx.router.list()[0].enabled, false);
    assert.equal(ctx.store.getGroupBridgeBySimplex(42).enabled, false);

    await ctx.router.handleSimplexEvent(simplexText('/bridge resume'));
    assert.equal(ctx.router.list()[0].enabled, true);
    assert.equal(ctx.store.getGroupBridgeBySimplex(42).enabled, true);
  } finally {
    ctx.close();
  }
});

test('forwards WhatsApp group media and cleans temporary file after SimpleX send', async () => {
  const ctx = setup();
  try {
    await ctx.router.handleWhatsApp({
      id: 'media1',
      groupJid: '120363123456789@g.us',
      from: '491701234567',
      name: 'Anna',
      type: 'image',
      media: {
        id: 'media1',
        kind: 'image',
        mimeType: 'image/jpeg',
        fileName: 'bild.jpg',
        caption: 'Foto'
      }
    });
    assert.equal(ctx.sentSimplexFiles.length, 1);
    assert.equal(ctx.sentSimplexFiles[0].text, '🟢 Anna · WhatsApp\nFoto');
    assert.equal(existsSync(ctx.sentSimplexFiles[0].filePath), true);

    await ctx.router.handleSimplexEvent({
      type: 'sndFileCompleteXFTP',
      chatItem: { chatItem: { file: { fileId: ctx.sentSimplexFiles[0].fileId } } }
    });
    assert.equal(existsSync(ctx.sentSimplexFiles[0].filePath), false);
  } finally {
    ctx.close();
  }
});

test('forwards SimpleX group files to mapped WhatsApp group', async () => {
  const ctx = setup();
  try {
    const base = {
      chatInfo: { type: 'group', groupInfo: { groupId: 42 } },
      chatItem: {
        chatDir: {
          type: 'groupRcv',
          groupMember: { memberProfile: { displayName: 'Chef' } }
        },
        content: {
          type: 'rcvMsgContent',
          msgContent: { type: 'file', text: 'Dokument' }
        },
        file: {
          fileId: 88,
          fileName: 'test.pdf',
          fileSize: 4,
          fileStatus: { type: 'rcvInvitation' }
        }
      }
    };

    await ctx.router.handleSimplexEvent({ type: 'newChatItems', chatItems: [base] });
    writeFileSync(ctx.receivedFiles[0].filePath, 'test');
    await ctx.router.handleSimplexEvent({
      type: 'rcvFileComplete',
      chatItem: {
        ...base,
        chatItem: {
          ...base.chatItem,
          file: {
            ...base.chatItem.file,
            fileStatus: { type: 'rcvComplete' },
            fileSource: { filePath: ctx.receivedFiles[0].filePath }
          }
        }
      }
    });

    assert.equal(ctx.sentWhatsAppFiles[0].to, '120363123456789@g.us');
    assert.equal(ctx.sentWhatsAppFiles[0].caption, '🟣 Chef · SimpleX\nDokument');
  } finally {
    ctx.close();
  }
});
