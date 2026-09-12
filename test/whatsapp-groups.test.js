import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWebMessage} from '../src/whatsapp-web-message.js';
import {normalizeChatAddress} from '../src/whatsapp-address.js';
import {WhatsAppWebClient} from '../src/whatsapp-web.js';
import {WhatsAppClient} from '../src/whatsapp.js';
import {BridgeStore} from '../src/storage.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const jid='120363123456789@g.us';
const message=(participant='491701234567@s.whatsapp.net')=>({
  key:{id:'same-id',remoteJid:jid,participant,fromMe:false},pushName:'Alice',message:{conversation:'Hello'}
});

test('group normalization uses group route and participant-specific deduplication',async()=>{
  const a=await normalizeWebMessage(message());
  const b=await normalizeWebMessage(message('123456789@lid'));
  assert.equal(a.from,jid); assert.equal(a.chatType,'group'); assert.equal(a.senderName,'Alice');
  assert.equal(b.from,jid); assert.notEqual(a.id,b.id);
  assert.equal(await normalizeWebMessage(message(),undefined,{groupsEnabled:false}),null);
  assert.equal(await normalizeWebMessage({...message(),key:{...message().key,fromMe:true}}),null);
});

test('group destinations are not converted to numbers or confused with LIDs',()=>{
  assert.equal(normalizeChatAddress(jid),jid);
  assert.equal(normalizeChatAddress('491701234567-1234567890@g.us'),'491701234567-1234567890@g.us');
  assert.equal(normalizeChatAddress('123456789@lid'),'');
  assert.equal(normalizeChatAddress('evil120363123456789@g.us'),'');
  assert.equal(normalizeChatAddress('+49 170 1234567'),'491701234567');
});

test('web sends use the exact group destination and cloud explicitly rejects group routes',async()=>{
  const client=new WhatsAppWebClient({}); client.status='connected';
  client.socket={sendMessage:async(...args)=>args};
  assert.deepEqual(await client.sendText(jid,'hello'),[jid,{text:'hello'}]);
  client.groupsEnabled=false;
  assert.throws(()=>client.sendText(jid,'hello'),/disabled/);
  const cloud=new WhatsAppClient({});
  await assert.rejects(cloud.sendText(jid,'hello'),/phone numbers only/);
  await assert.rejects(cloud.sendFile(jid,{filePath:'/not-read'}),/phone numbers only/);
});

test('existing direct mappings and new group mappings persist together across reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wa-group-store-'));
  try {
    let store=new BridgeStore(join(dir,'store.db'));
    store.upsertContact('120363123456789','Direct');store.bindGroup('120363123456789',17);store.close();
    store=new BridgeStore(join(dir,'store.db'));
    store.upsertContact(jid,'Group');store.bindGroup(jid,18);store.close();
    store=new BridgeStore(join(dir,'store.db'));
    assert.equal(store.getByGroupId(17).phone,'120363123456789');
    assert.equal(store.getByGroupId(18).phone,jid);store.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
