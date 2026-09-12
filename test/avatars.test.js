import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { AvatarSync, encodeAvatar } from '../src/avatars.js';
import { BridgeStore } from '../src/storage.js';
import { SimplexClient } from '../src/simplex.js';
import { WhatsAppWebClient } from '../src/whatsapp-web.js';

const sample=()=>sharp({create:{width:200,height:150,channels:3,background:'#e84356'}}).png().toBuffer();
const logger={info(){},warn(){},error(){},debug(){}};

test('profile images become small SimpleX-compatible JPEGs and malformed images fail',async()=>{
  const result=await encodeAvatar(await sample());
  assert.match(result.data,/^data:image\/jpg;base64,/);
  assert.ok(result.data.length<12000);
  const metadata=await sharp(Buffer.from(result.data.split(',')[1],'base64')).metadata();
  assert.equal(metadata.width,96);assert.equal(metadata.height,96);
  await assert.rejects(encodeAvatar(Buffer.from('invalid image')));
  await assert.rejects(encodeAvatar(Buffer.alloc(2*1024*1024+1)),/size/);
});

test('worker updates, suppresses unchanged images and clears a removed managed avatar',async()=>{
  const store=new BridgeStore(':memory:');
  const calls=[];
  let picture=await sample();
  store.upsertContact('491701234567','Person');store.bindGroup('491701234567',17);
  const worker=new AvatarSync({store,whatsapp:{status:'connected',getProfilePicture:async()=>picture},simplex:{ws:{readyState:1},updateGroupImage:async(id,image)=>calls.push({id,image})},logger});
  try {
    await worker.tick(); assert.equal(calls.length,1);
    assert.equal(store.listAvatarsDue(Date.now(),worker.intervalMs).length,0);
    let state=store.getAvatarState('491701234567');store.setAvatarState('491701234567',17,state.hash,0);
    await worker.tick(); assert.equal(calls.length,1);
    picture=null;store.setAvatarState('491701234567',17,state.hash,0);
    await worker.tick();assert.deepEqual(calls[1],{id:17,image:null});
  } finally {await worker.stop();store.close();}
});

test('transient failures retain the image and defer retry; repaired groups receive the image again',async()=>{
  const store=new BridgeStore(':memory:');const jid='120363123456789@g.us';
  store.upsertContact(jid,'Group');store.bindGroup(jid,17);
  const pic=await sample();const {hash}=await encodeAvatar(pic);store.setAvatarState(jid,17,hash,0);
  let fail=true;const calls=[];
  const worker=new AvatarSync({store,whatsapp:{status:'connected',getProfilePicture:async()=>{if(fail)throw new Error('timeout');return pic;}},simplex:{ws:{readyState:1},updateGroupImage:async(id,image)=>calls.push({id,image})},logger});
  try {
    await worker.tick();assert.equal(calls.length,0);assert.equal(store.getAvatarState(jid).hash,hash);
    assert.equal(store.listAvatarsDue(Date.now(),worker.intervalMs).length,0);
    fail=false;store.setAvatarState(jid,17,hash,0);store.bindGroup(jid,18);
    await worker.tick();assert.equal(calls.length,1);assert.equal(calls[0].id,18);
  } finally {await worker.stop();store.close();}
});

test('concurrent image and name updates preserve the rest of the SimpleX group profile',async()=>{
  const c=new SimplexClient({url:'unused',logger});
  let profile={displayName:'Before',fullName:'Before',description:'Keep this',groupPreferences:{files:{enable:'on'}}};
  c.listGroups=async()=>[{groupId:17,groupProfile:{...profile}}];
  c.sendCommand=async cmd=>{profile=JSON.parse(cmd.slice(cmd.indexOf('{')));return {type:'groupUpdated'};};
  await Promise.all([c.updateGroupImage(17,'data:image/jpg;base64,abc'),c.updateGroupName(17,'After')]);
  assert.equal(profile.displayName,'After');assert.equal(profile.image,'data:image/jpg;base64,abc');
  assert.equal(profile.description,'Keep this');assert.deepEqual(profile.groupPreferences,{files:{enable:'on'}});
});

test('profile picture privacy errors mean unavailable; transient errors do not erase avatars',async()=>{
  const c=new WhatsAppWebClient({});c.status='connected';
  c.socket={profilePictureUrl:async()=>{throw {output:{statusCode:403}};}};
  assert.equal(await c.getProfilePicture('491701234567'),null);
  c.socket.profilePictureUrl=async()=>{throw {output:{statusCode:500}};};
  await assert.rejects(c.getProfilePicture('491701234567'));
  c.socket.profilePictureUrl=async()=> 'http://localhost/private';
  await assert.rejects(c.getProfilePicture('491701234567'),/host/);
});
