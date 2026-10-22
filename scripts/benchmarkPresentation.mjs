/** Synthetic CPU reference, NOT GPU/frame rate/device profiling.
 * Same seeded four-shot/frame workload, 1000 warmup + 2000 measured updates.
 * Compare committed 3.4 and working implementation without changing branches.
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {execFileSync} from 'node:child_process';
import * as THREE from 'three';
import {loadWorldModules} from './headlessWorld.mjs';
const sourcePath='src/systems/ParticleSystem.ts';
const sources=[['3.4',execFileSync('git',['show',`e7dfd92:${sourcePath}`],{encoding:'utf8'})],['working',fs.readFileSync(sourcePath,'utf8')]];
const originalRandom=Math.random;
try {
  for(const [version,source] of sources){
    let seed=35;Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
    const code=stripTypeScriptTypes(source)
      .replace(/import[^;]*from ['"]\.\.\/audio\/SoundManager['"];?/,'')
      .replace("from 'three'",`from '${pathToFileURL(path.resolve('node_modules/three/build/three.module.js'))}'`);
    const {ParticleSystem}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
    const scene=new THREE.Scene(),fx=new ParticleSystem(scene),start=new THREE.Vector3(),end=new THREE.Vector3(0,2,-20),times=[];
    for(let frame=0;frame<3000;frame++){
      const begin=performance.now();
      for(let i=0;i<4;i++){fx.spawnImpactBurst(end,0xffffff,5);fx.spawnBulletTracer(start,end,0xffffff)}
      fx.update(1/60);
      if(frame>=1000)times.push(performance.now()-begin);
    }
    const sorted=[...times].sort((a,b)=>a-b);
    console.log(JSON.stringify({version,frames:times.length,meanMs:times.reduce((a,b)=>a+b)/times.length,
      p95Ms:sorted[Math.floor(sorted.length*.95)],p99Ms:sorted[Math.floor(sorted.length*.99)],
      activeParticles:fx.particles.length,activeTracers:fx.tracers.length,sceneObjects:scene.children.length}));
    if(fx.dispose)fx.dispose();else fx.clear();
  }
}finally{Math.random=originalRandom}
const {IslandWorld}=await loadWorldModules();const scene=new THREE.Scene(),world=new IslandWorld(scene);world.generate();
let meshes=0,triangles=0,paint=0;
scene.traverse(o=>{if(o.isMesh){meshes++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);if(o.name.includes('_decal_'))paint+=o.count}});
console.log(JSON.stringify({meshes,triangles,colliders:world.boxColliders.length+world.cylinderColliders.length,paintInstances:paint}));
