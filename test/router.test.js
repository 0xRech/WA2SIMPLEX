import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeRouter,
  chatRefFromInfo,
  extractMarker,
  makeGroupName,
  messageContentText,
  parseWaCommand
} from '../src/router.js';
import { BridgeStore } from '../src/storage.js';

function setup({ memberStatus = 'invited', mediaEnabled = true } = {}) {
  const sentSimplex = [];
  const sentFiles = [];
  const receivedFiles = [];
  const sentWhatsApp = [];
  const sentWhatsAppFiles = [];
  let groupCreates = 0;
  let nextSimplexFileId = 70;
  const mediaDir = mkdtempSync(join(tmpdir(), 'wa2simplex-router-'));

  const simplex = {
    async sendText(ref, text) {
      sentSimplex.push({ ref, text });
      return {};
    },
    async sendFile(ref, filePath, text) {
      const fileId = nextSimplexFileId++;
      sentFiles.push({ ref, filePath, text, fileId });
      return { chatItems: [{ chatItem: { file: { fileId } } }] };
    },
    async receiveFile(fileId, filePath) {
      receivedFiles.push({ fileId, filePath });
      return { type: 'rcvFileAccepted' };
    },
    async createGroup() {
      groupCreates += 1;
      return { groupId: 17, groupProfile: {} };
    },
    async addMember() { return { type: 'sentGroupInvitation' }; },
    async setGroupCustomData() { return { type: 'cmdOk' }; },
    async listGroupMembers() {
      return { group: { members: [{ memberContactId: 2, memberStatus }] } };
    },
    async listGroups() { return []; },
    async updateGroupName() { return {}; }
  };

  const whatsapp = {
    async sendText(to, text) {
      sentWhatsApp.push({ to, text });
      return { messages: [{ id: 'wamid.out' }] };
    },
    async sendFile(to, file) {
      sentWhatsAppFiles.push({ to, ...file });
      return { messages: [{ id: 'wamid.media.out' }] };
    },
    async downloadMedia() {
      return { buffer: Buffer.from('fake-image'), mimeType: 'image/jpeg', fileSize: 10 };
    },
    async markRead() { return {}; }
  };

  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const store = new BridgeStore(':memory:');
  const router = new BridgeRouter({
    simplex,
    whatsapp,
    store,
    controlTarget: '@2',
    ownerContactId: 2,
    groupPrefix: 'WA',
    logger,
    mediaEnabled,
    mediaDir,
    maxMediaBytes: 1024 * 1024
  });

  return {
    router,
    store,
    sentSimplex,
    sentFiles,
    receivedFiles,
    sentWhatsApp,
    sentWhatsAppFiles,
    groupCreates: () => groupCreates,
    close() {
      store.close();
      rmSync(mediaDir, { recursive: true, force: true });
    }
  };
}

test('creates one SimpleX contact group on first WhatsApp message and reuses it', async () => {
  const ctx = setup();
  try {
    await ctx.router.handleWhatsApp({
      id: 'in-1', from: '491701234567', name: 'Max', type: 'text', text: 'Hallo'
    });
    await ctx.router.handleWhatsApp({
      id: 'in-2', from: '491701234567', name: 'Max', type: 'text', text: 'Noch da?'
    });
    assert.equal(ctx.groupCreates(), 1);
    assert.equal(ctx.store.getContact('491701234567').simplexGroupId, 17);
    assert.ok(ctx.sentSimplex.some((message) => message.ref === '#17' && message.text === 'Hallo'));
    assert.ok(ctx.sentSimplex.some((message) => message.ref === '@2' && message.text.includes('Gruppeneinladung')));
  } finally {
    ctx.close();
  }
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
        chatItem: {
          chatDir: { type: 'groupRcv' },
          content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: 'Antwort' } }
        }
      }]
    });
    assert.deepEqual(ctx.sentWhatsApp, [{ to: '491701234567', text: 'Antwort' }]);
    assert.equal(ctx.store.getContact('491701234567').ready, true);
  } finally {
    ctx.close();
  }
});

test('forwards WhatsApp binary media to the mapped SimpleX group and cleans it after XFTP completion', async () => {
  const ctx = setup({ memberStatus: 'complete' });
  try {
    ctx.store.upsertContact('491701234567', 'Max');
    ctx.store.bindGroup('491701234567', 17);
    ctx.store.setReadyByGroup(17, true);

    await ctx.router.handleWhatsApp({
      id: 'wa-media-1',
      from: '491701234567',
      name: 'Max',
      type: 'image',
      text: 'Foto',
      media: {
        id: 'm1',
        kind: 'image',
        mimeType: 'image/jpeg',
        fileName: 'foto.jpg',
        caption: 'Foto'
      }
    });

    assert.equal(ctx.sentFiles.length, 1);
    assert.equal(ctx.sentFiles[0].ref, '#17');
    assert.equal(existsSync(ctx.sentFiles[0].filePath), true);

    await ctx.router.handleSimplexEvent({
      type: 'sndFileCompleteXFTP',
      chatItem: { chatItem: { file: { fileId: ctx.sentFiles[0].fileId } } }
    });
    assert.equal(existsSync(ctx.sentFiles[0].filePath), false);
  } finally {
    ctx.close();
  }
});

test('receives a SimpleX file and forwards it to WhatsApp', async () => {
  const ctx = setup({ memberStatus: 'complete' });
  try {
    ctx.store.upsertContact('491701234567', 'Max');
    ctx.store.bindGroup('491701234567', 17);
    ctx.store.setReadyByGroup(17, true);

    const item = {
      chatInfo: { type: 'group', groupInfo: { groupId: 17 } },
      chatItem: {
        chatDir: { type: 'groupRcv' },
        content: { type: 'rcvMsgContent', msgContent: { type: 'file', text: 'Rechnung' } },
        file: {
          fileId: 81,
          fileName: 'rechnung.pdf',
          fileSize: 4,
          fileStatus: { type: 'rcvInvitation' }
        }
      }
    };

    await ctx.router.handleSimplexEvent({ type: 'newChatItems', chatItems: [item] });
    assert.equal(ctx.receivedFiles.length, 1);
    writeFileSync(ctx.receivedFiles[0].filePath, Buffer.from('test'));

    await ctx.router.handleSimplexEvent({
      type: 'rcvFileComplete',
      chatItem: {
        chatInfo: item.chatInfo,
        chatItem: {
          ...item.chatItem,
          file: {
            ...item.chatItem.file,
            fileSource: { filePath: ctx.receivedFiles[0].filePath },
            fileStatus: { type: 'rcvComplete' }
          }
        }
      }
    });

    assert.equal(ctx.sentWhatsAppFiles.length, 1);
    assert.equal(ctx.sentWhatsAppFiles[0].to, '491701234567');
    assert.equal(ctx.sentWhatsAppFiles[0].fileName, 'rechnung.pdf');
    assert.equal(ctx.sentWhatsAppFiles[0].caption, 'Rechnung');
    assert.equal(existsSync(ctx.receivedFiles[0].filePath), false);
  } finally {
    ctx.close();
  }
});

test('control chat can create a new contact chat', async () => {
  const ctx = setup();
  try {
    await ctx.router.handleSimplexEvent({
      type: 'newChatItems',
      chatItems: [{
        chatInfo: { type: 'direct', contact: { contactId: 2 } },
        chatItem: {
          chatDir: { type: 'directRcv' },
          content: {
            type: 'rcvMsgContent',
            msgContent: { type: 'text', text: '/new +49 170 1234567 Max Test' }
          }
        }
      }]
    });
    const contact = ctx.store.getContact('491701234567');
    assert.equal(contact.displayName, 'Max Test');
    assert.equal(contact.simplexGroupId, 17);
  } finally {
    ctx.close();
  }
});

test('keeps v0.1 parsing helpers for migration and fallback commands', () => {
  assert.deepEqual(parseWaCommand('/wa +49 170 1234567 Hallo Welt'), {
    phone: '491701234567',
    text: 'Hallo Welt'
  });
  assert.equal(extractMarker('⟦WA:491701234567⟧'), '491701234567');
  assert.equal(chatRefFromInfo({ type: 'direct', contact: { contactId: 9 } }), '@9');
  assert.equal(chatRefFromInfo({ type: 'group', groupInfo: { groupId: 4 } }), '#4');
  assert.equal(messageContentText({ type: 'text', text: 'quoted' }), 'quoted');
  assert.match(makeGroupName('WA', 'Max Mustermann', '491701234567'), /^WA · Max Mustermann · 4567$/);
});
