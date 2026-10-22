import assert from 'node:assert/strict';
import manifest from '../server/worldLootManifest.json' with {type:'json'};
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const layout = await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(
  fs.readFileSync(new URL('../src/world/WorldLayout.ts',import.meta.url),'utf8'))).toString('base64'));
export const LEGENDARY_TOWER_VAULT_LOOT = layout.LEGENDARY_TOWER_VAULT_LOOT.map(i=>({...i,
  position:{x:i.x,y:51.73,z:i.z}}));
export const delay = ms => new Promise(r=>setTimeout(r,ms));
const shotSequences = new WeakMap();
export function resumeShots(ws,seq) { shotSequences.set(ws,seq); }
export const send = (ws,packet) => {
  if(packet.type==='fire_weapon') {
    const seq=packet.shotSeq ?? (shotSequences.get(ws)||0)+1;
    shotSequences.set(ws,Math.max(shotSequences.get(ws)||0,seq));
    packet={...packet,shotSeq:seq};
  }
  ws.send(JSON.stringify(packet));
};
export function receive(ws,predicate,label='gameplay ACK',timeout=6000) {
  return new Promise((resolve,reject)=>{
    const done = () => {clearTimeout(timer);ws.removeEventListener('message',handler);};
    const timer=setTimeout(()=>{done();reject(new Error(`Timed out: ${label}`));},timeout);
    const handler=e=>{const m=JSON.parse(e.data);if(predicate(m)){done();resolve(m);}};
    ws.addEventListener('message',handler);
  });
}
const sequences = new WeakMap();
export function resumeActions(ws,seq) { sequences.set(ws,seq); }
export async function action(ws,action,slot) {
  const seq=(sequences.get(ws)||0)+1;sequences.set(ws,seq);
  const ack=receive(ws,m=>m.type==='inventory_state' && m.lastActionSeq===seq,action);
  send(ws,{type:'inventory_action',action,slot,seq});return ack;
}
export async function claim(ws,item,slot,swappedDrop) {
  send(ws,{type:'player_sync',position:item.position});
  const ack=receive(ws,m=>(m.type==='loot_collected'||m.type==='loot_collect_rejected')&&m.lootId===item.id,`claim ${item.id}`);
  const owner=receive(ws,m=>m.type==='inventory_state' && (!item.weaponCategory || m.inventory.some(s=>s?.category===item.weaponCategory&&s.rarity===item.rarity)),`owner ${item.id}`);
  send(ws,{type:'collect_loot',lootId:item.id,slot,swappedDrop});
  const receipt=await ack;
  assert.equal(receipt.type,'loot_collected',receipt.reason);
  return {receipt,state:await owner};
}
export async function equipRegistered(ws,category,rarity,position={x:0,y:80,z:0}) {
  let item=[...manifest.items,...LEGENDARY_TOWER_VAULT_LOOT].find(i=>i.weaponCategory===category&&i.rarity===rarity);
  if(!item) {
    const entry=Object.entries(manifest.chestDrops).find(([,drops])=>drops.some(i=>i.weaponCategory===category&&i.rarity===rarity));
    assert.ok(entry,`registered ${category}:${rarity}`);
    const chest=manifest.items.find(i=>i.id===entry[0]);
    // Chests do not change inventory, so wait for the public receipt only.
    send(ws,{type:'player_sync',position:chest.position});
    const ack=receive(ws,m=>m.type==='loot_collected'&&m.lootId===chest.id);
    send(ws,{type:'collect_loot',lootId:chest.id});await ack;
    item=entry[1].find(i=>i.weaponCategory===category&&i.rarity===rarity);
  }
  const {state}=await claim(ws,item,4);
  const slot=state.inventory.findIndex(i=>i?.category===category&&i.rarity===rarity);
  assert.ok(slot>=1);
  const switched=await action(ws,'switch',slot);assert.equal(switched.result.accepted,true);
  send(ws,{type:'player_sync',position});
  await delay(1450); // respects even a previous sniper's cooldown, never a test-only bypass
  return switched;
}
