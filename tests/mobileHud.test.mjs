import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {pathToFileURL} from 'node:url';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mobile-hud-'));
let module;
try {
  const file=path.join(tmp,'MobileHud.mjs');
  fs.writeFileSync(file,stripTypeScriptTypes(fs.readFileSync(new URL('../src/ui/MobileHud.ts',import.meta.url),'utf8')));
  module=await import(pathToFileURL(file).href);
} finally {fs.rmSync(tmp,{recursive:true,force:true})}
const {MobileHud,normalizeMobileHud,DEFAULT_MOBILE_HUD,MOBILE_HUD_KEY}=module;
class Element extends EventTarget {
  hidden=false; value='';checked=false;textContent='';attributes=new Map();classes=new Set();
  classList={toggle:(key,on)=>on?this.classes.add(key):this.classes.delete(key)};
  setAttribute(key,value){this.attributes.set(key,value)}
}
function documentFixture(raw='{}',blocked=false) {
  const elements=new Map();const stored=new Map([[MOBILE_HUD_KEY,raw]]);const properties=new Map();
  const storage={getItem:key=>stored.get(key),setItem:(key,value)=>{if(blocked)throw Error('quota');stored.set(key,value)}};
  const view={PointerEvent:Event};Object.defineProperty(view,'localStorage',{get:()=>{if(blocked)throw Error('denied');return storage}});
  const doc={getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)},defaultView:view,
    documentElement:{style:{setProperty:(key,value)=>properties.set(key,value)}}};
  return {doc,e:id=>doc.getElementById(id),stored,properties};
}
function emit(element,type,extra={}){const event=new Event(type,{cancelable:true});Object.assign(event,extra);element.dispatchEvent(event);return event}

test('mobile HUD preferences: malformed, nonfinite, out-of-range and foreign values are safely normalized',()=>{
  for(const input of [null,undefined,[],{},'bad',{buttonSize:NaN,hudScale:Infinity,sensitivity:'2',advancedBuild:'true'}])assert.deepEqual(normalizeMobileHud(input),DEFAULT_MOBILE_HUD);
  assert.deepEqual(normalizeMobileHud({buttonSize:99,hudScale:-1,sensitivity:99,advancedBuild:true,token:'not retained'}),{buttonSize:1.15,hudScale:.9,sensitivity:2.5,advancedBuild:true});
});
test('mobile HUD: pointer expansion, compatibility-click deduplication, keyboard, reset and listener cleanup',()=>{
  const {doc,e}=documentFixture();const hud=new MobileHud(doc,()=>{});
  assert.equal(e('touch-build-panel').hidden,true);
  assert.equal(emit(e('touch-build-toggle-btn'),'pointerdown',{pointerType:'touch'}).defaultPrevented,true);
  assert.equal(e('touch-build-panel').hidden,false);assert.equal(e('touch-secondary-actions').hidden,true);
  emit(e('touch-build-toggle-btn'),'click',{detail:1});assert.equal(e('touch-build-panel').hidden,false);
  emit(e('touch-build-close-btn'),'click',{detail:0});assert.equal(e('touch-build-panel').hidden,true);
  emit(e('touch-build-toggle-btn'),'click',{detail:0});assert.equal(e('touch-build-panel').hidden,false);
  hud.resetPanel();assert.equal(e('touch-build-panel').hidden,true);
  assert.equal(e('touch-build-toggle-btn').attributes.get('aria-expanded'),'false');
  hud.destroy();hud.destroy();emit(e('touch-build-toggle-btn'),'click',{detail:0});assert.equal(e('touch-build-panel').hidden,true);
});
test('mobile HUD: persistence, precise sensitivity restoration, clamping and reset without backend changes',()=>{
  const fixture=documentFixture();const {doc,e,stored,properties}=fixture;const sensitivities=[];
  let hud=new MobileHud(doc,v=>sensitivities.push(v));
  e('setting-mobile-button-size').value='1.1';emit(e('setting-mobile-button-size'),'input');
  e('setting-mobile-hud-scale').value='.9';emit(e('setting-mobile-hud-scale'),'input');
  assert.deepEqual(sensitivities,[1],'HUD-only changes should not reapply graphics settings');
  e('setting-touch-sensitivity').value='1.7';emit(e('setting-touch-sensitivity'),'input');
  e('setting-mobile-advanced-build').checked=true;emit(e('setting-mobile-advanced-build'),'change');
  assert.equal(e('touch-build-panel').hidden,false);assert.equal(properties.get('--mobile-button-scale'),'1.1');
  assert.equal(JSON.parse(stored.get(MOBILE_HUD_KEY)).sensitivity,1.7);
  hud.destroy();hud=new MobileHud(doc,v=>sensitivities.push(v));assert.equal(e('setting-touch-sensitivity').value,'1.7');assert.equal(e('touch-build-panel').hidden,false);
  emit(e('btn-reset-mobile-hud'),'click');assert.deepEqual(JSON.parse(stored.get(MOBILE_HUD_KEY)),DEFAULT_MOBILE_HUD);assert.equal(e('touch-build-panel').hidden,true);assert.equal(sensitivities.at(-1),1);
  hud.destroy();
});
test('mobile HUD: storage denial, corrupt JSON, legacy touch fallback and remounts remain usable',()=>{
  for(const [raw,blocked] of [['{broken',false],['{}',true]]) {
    const {doc,e}=documentFixture(raw,blocked);delete doc.defaultView.PointerEvent;
    for(let i=0;i<5;i++){
      const hud=new MobileHud(doc,()=>{});emit(e('touch-build-toggle-btn'),'touchstart');assert.equal(e('touch-build-panel').hidden,false);
      e('setting-mobile-button-size').value='1.15';assert.doesNotThrow(()=>emit(e('setting-mobile-button-size'),'input'));
      hud.destroy();
    }
  }
});
