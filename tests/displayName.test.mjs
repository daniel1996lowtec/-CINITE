import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateDisplayName} from '../shared/displayName.mjs';
process.env.ACCOUNT_TOKEN_SECRET ||= 'ui4-test-only-secret-0123456789abcdef';
const {PersistenceManager}=await import('../server/database.mjs');
test('display names: trim, bounded ASCII policy; reject markup, controls, blank and invalid types',()=>{
 for(const value of [null,undefined,{},42,'','  ','ab','a'.repeat(19),'A\nB','<Alice>','A\u202eB','_ab'])assert.equal(validateDisplayName(value),null);
 for(const value of ['Alice','Bob_12','Alice Smith','A-B', 'a'.repeat(18)])assert.equal(validateDisplayName(' '+value+' '),value);
});
test('display names: persistence, duplicate-safe account IDs, invalid rename and token isolation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ui4-names-'));
 const db=new PersistenceManager({databaseUrl:'',sqlitePath:path.join(dir,'names.sqlite')});
 try {
  await db.init();
  const a=await db.createOrVerifyAccount({callsign:'Alice'}), b=await db.createOrVerifyAccount({callsign:'Bob'});
  const creds=a=>({accountId:a.accountId,accountToken:a.accountToken});
  const renamed=await db.verifyAccountCredentials({...creds(a),callsign:'  New_Alice  '});assert.equal(renamed.callsign,'New_Alice');
  assert.equal((await db.verifyAccountCredentials(creds(a))).callsign,'New_Alice');
  const restored=await db.restoreAccountByPasskey(a.passkey);
  assert.equal(restored.profile.callsign,'New_Alice');
  assert.equal(await db.verifyAccountCredentials(creds(a)),null,'recovery rotates the old token');
  a.accountToken=restored.accountToken;
  const duplicate=await db.createOrVerifyAccount({callsign:'New_Alice'});
  assert.notEqual(duplicate.accountId,a.accountId,'same display name never means same identity');
  assert.equal(await db.verifyAccountCredentials({accountId:b.accountId,accountToken:a.accountToken,callsign:'Forged'}),null);
  assert.equal((await db.verifyAccountCredentials(creds(b))).callsign,'Bob');
  for(const callsign of [null,0,{},'','x','<svg>','x'.repeat(19)]){
    await assert.rejects(db.verifyAccountCredentials({...creds(a),callsign}),/Invalid display name/);
    await assert.rejects(db.createOrVerifyAccount({callsign}),/Invalid display name/);
    await assert.rejects(db.updateAccountCosmetics(a.accountId,undefined,callsign),/Invalid display name/);
  }
  assert.equal((await db.verifyAccountCredentials(creds(a))).callsign,'New_Alice');
  db.sqliteDb.prepare('UPDATE player_accounts SET callsign = ? WHERE account_id = ?').run('Al',a.accountId);
  assert.equal((await db.verifyAccountCredentials({...creds(a),callsign:'Al'})).callsign,'Al','legacy two-character names remain valid unchanged');
 }finally{await db.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('display names: actual client cache survives offline reload and blocked storage without crashing',async()=>{
 const ts=(await import('typescript')).default;
 const code=ts.transpileModule(fs.readFileSync(new URL('../src/systems/ProgressionSystem.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const {ProgressionSystem}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
 const previous=globalThis.window,oldFetch=globalThis.fetch;const values=new Map();
 try {
  globalThis.window={localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}};
  const first=new ProgressionSystem();assert.match(first.state.callsign,/^Pilot_/);
  first.saveDisplayNameLocally('Offline_Alice');
  const second=new ProgressionSystem();assert.equal(second.state.callsign,'Offline_Alice');
  let sent;
  globalThis.fetch=async(url,options)=>{sent=JSON.parse(options.body);return {ok:false}};
  assert.equal(await second.initializeServerAccount(),false);assert.equal(sent.callsign,'Offline_Alice');
  // A saved edit must be retried only for the account that owns it.
  second.credentials.accountId='different-account';await second.initializeServerAccount();assert.equal(sent.callsign,undefined);
  Object.defineProperty(globalThis.window,'localStorage',{get(){throw new Error('storage blocked')}});
  const privateMode=new ProgressionSystem();privateMode.saveDisplayNameLocally('Session_Alice');
  assert.equal(privateMode.state.callsign,'Session_Alice');
 }finally{globalThis.window=previous;globalThis.fetch=oldFetch}
});
