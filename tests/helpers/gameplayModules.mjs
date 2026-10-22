import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const root=path.resolve(import.meta.dirname,'../..');
export async function loadGameplayModules() {
 const tmp=fs.mkdtempSync(path.join(root,'.gameplay41-')),done=new Map();
 const emit=source=>{
  if(done.has(source))return done.get(source);
  const out=path.join(tmp,path.relative(root,source).replace(/\.ts$/,'.mjs'));done.set(source,out);
  let code=ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  code=code.replace(/from ['"](\.[^'"]+)['"]/g,(_,specifier)=>{
   const target=path.resolve(path.dirname(source),specifier);
   return `from '${pathToFileURL(fs.existsSync(target)?target:emit(target+'.ts')).href}'`;
  });
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,code);return out;
 };
 try {
  const result={};
  for(const file of ['entities/PlayerController','entities/CharacterMesh','network/NetworkManager','world/IslandWorld'])Object.assign(result,await import(pathToFileURL(emit(path.join(root,'src',file+'.ts'))).href));
  return result;
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
}
export async function loadRig(CharacterMesh) {
 const bytes=fs.readFileSync(path.join(root,'public/models/soldier.glb')),length=bytes.readUInt32LE(12);
 const json=JSON.parse(bytes.subarray(20,20+length));
 json.materials=json.materials.map(()=>({pbrMetallicRoughness:{}}));delete json.images;delete json.textures;
 const text=Buffer.from(JSON.stringify(json)),padded=Buffer.alloc(Math.ceil(text.length/4)*4,32);text.copy(padded);
 const binary=bytes.subarray(20+length),glb=Buffer.alloc(20+padded.length+binary.length);
 bytes.copy(glb,0,0,12);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(padded.length,12);glb.writeUInt32LE(0x4e4f534a,16);
 padded.copy(glb,20);binary.copy(glb,20+padded.length);
 return CharacterMesh.preloadFromArrayBuffer(glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength));
}

export function makePlayerState(overrides = {}) {
  return {
    id: 'preview_test',
    name: 'Preview_Test',
    isBot: false,
    outfitId: 'vanguard_blue',
    skinColor: 0x0284c7,
    accentColor: 0x38bdf8,
    backAccessory: 'jump_pack',
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    facingYaw: 0,
    pitch: 0,
    health: 100,
    maxHealth: 100,
    shield: 50,
    maxShield: 100,
    alive: true,
    isGliding: false,
    isGrounded: true,
    isSprinting: false,
    isAiming: false,
    isReloading: false,
    reloadTimer: 0,
    reloadDuration: 0,
    isHealing: false,
    landingImpactTimer: 0,
    activeSlot: 0,
    selectedMaterial: 'wood',
    inventory: [
      {
        weaponId: 'assault_rifle_rare',
        name: 'Rare Pulse Rifle',
        category: 'assault_rifle',
        rarity: 'rare',
        clipAmmo: 30,
        maxClipAmmo: 30,
        ammoType: 'medium',
        isConsumable: false,
        count: 1,
      },
      null,
      null,
      null,
      null,
    ],
    ammo: { none: 0, light: 60, medium: 90, shells: 24, heavy: 15 },
    materials: { wood: 100, stone: 50, metal: 25 },
    eliminations: 0,
    damageDealt: 0,
    shotsFired: 0,
    shotsHit: 0,
    structuresBuilt: 0,
    ...overrides,
  };
}
