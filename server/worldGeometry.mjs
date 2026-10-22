import { overlapsBuildGeometry, normalizeBuildYaw } from '../shared/buildPlacement.mjs';
import geometry from './worldCollisionManifest.json' with { type:'json' };
// Immutable generated collision data; no Three.js scene or render assets on server.
export const worldProps = new Map(geometry.props.map(p => [p.id,p]));
const AXES = [['x','minX','maxX'],['y','minY','maxY'],['z','minZ','maxZ']];
export function segmentBox(a,b,box) {
  let lo=0, hi=1;
  for (const [axis,minKey,maxKey] of AXES) {
    const d=b[axis]-a[axis];
    if (Math.abs(d)<1e-9) {
      if (a[axis]<box[minKey] || a[axis]>box[maxKey]) return false;
    } else {
      let t1=(box[minKey]-a[axis])/d, t2=(box[maxKey]-a[axis])/d;
      if (t1>t2) { const swap=t1;t1=t2;t2=swap; }
      lo=Math.max(lo,t1); hi=Math.min(hi,t2);
      if (lo>hi) return false;
    }
  }
  return hi>0.001 && lo<0.999;
}
function segmentCylinder(a,b,c) {
  const dx=b.x-a.x,dz=b.z-a.z,dy=b.y-a.y,ox=a.x-c.x,oz=a.z-c.z;
  let lo=0,hi=1;
  if (Math.abs(dy)<1e-9) { if (a.y<c.minY || a.y>c.maxY) return false; }
  else { let t1=(c.minY-a.y)/dy,t2=(c.maxY-a.y)/dy; if(t1>t2)[t1,t2]=[t2,t1];lo=Math.max(lo,t1);hi=Math.min(hi,t2); }
  const aa=dx*dx+dz*dz,bb=2*(ox*dx+oz*dz),cc=ox*ox+oz*oz-c.radius*c.radius;
  if(aa<1e-9) { if(cc>0)return false; }
  else { const disc=bb*bb-4*aa*cc;if(disc<0)return false; const root=Math.sqrt(disc);lo=Math.max(lo,(-bb-root)/(2*aa));hi=Math.min(hi,(-bb+root)/(2*aa)); }
  return lo<=hi && hi>0.001 && lo<0.999;
}
export function buildTransform(b) {
  b = {...b, yaw: normalizeBuildYaw(b.yaw)};
  const x=Math.round((b.x-Math.sin(b.yaw)*3.5)/2)*2;
  const z=Math.round((b.z-Math.cos(b.yaw)*3.5)/2)*2;
  if (Math.hypot(x,z)>236) return null;
  const ground=geometry.ground[((z+236)/2)*237+(x+236)/2];
  const y=Math.max(ground,Math.round(b.y*2)/2);
  return {x,y,z,yaw:Math.round(b.yaw/(Math.PI/2))*(Math.PI/2),cell:`${b.pieceType}_${x}_${y}_${z}`};
}
function segmentBuild(a,b,build) {
  const t=buildTransform(build); if(!t)return false;
  const c=Math.cos(t.yaw),s=Math.sin(t.yaw);
  const local=p=>({x:c*(p.x-t.x)-s*(p.z-t.z), y:p.y-t.y, z:s*(p.x-t.x)+c*(p.z-t.z)});
  let start=local(a),end=local(b);
  if(build.pieceType==='wall') return segmentBox(start,end,{minX:-1.8,maxX:1.8,minY:0,maxY:3.2,minZ:-.175,maxZ:.175});
  if(build.pieceType==='floor') return segmentBox(start,end,{minX:-1.84,maxX:1.84,minY:.01,maxY:.29,minZ:-1.84,maxZ:1.84});
  if(build.pieceType==='ramp') {
    const angle=Math.atan2(2.8,3.6),co=Math.cos(angle),si=Math.sin(angle);
    const unrotate=p=>({x:p.x,y:co*(p.y-1.4)+si*p.z,z:-si*(p.y-1.4)+co*p.z});
    return segmentBox(unrotate(start),unrotate(end),{minX:-1.6,maxX:1.6,minY:-.125,maxY:.125,minZ:-Math.hypot(3.6,2.8)/2,maxZ:Math.hypot(3.6,2.8)/2});
  }
  // Four triangular sides of the existing 4-sided roof cone (no opaque AABB
  // under its sloped surface). Test intersection against each roof plane.
  const radius=2.6/Math.sqrt(2), slope=1.9/radius;
  for(const [axis,other] of [['x','z'],['z','x']]) for(const sign of [-1,1]) {
    const da=start.y+slope*sign*start[axis]-1.9;
    const db=end.y+slope*sign*end[axis]-1.9;
    if(Math.abs(da-db)<1e-9)continue;
    const f=da/(da-db);if(f<=.001||f>=.999)continue;
    const u=start[axis]+(end[axis]-start[axis])*f,v=start[other]+(end[other]-start[other])*f;
    if(sign*u>=0 && sign*u<=radius && Math.abs(v)<=sign*u)return true;
  }
  return false;
}
function terrainBand(p) {
  if (Math.abs(p.x)>236 || Math.abs(p.z)>236) return {min:-.85,max:-.85};
  const gx=Math.min(235,Math.floor((p.x+236)/2)), gz=Math.min(235,Math.floor((p.z+236)/2));
  const i=gz*237+gx, g=geometry.ground;
  return {min:Math.max(-.85,Math.min(g[i],g[i+1],g[i+237],g[i+238])-.5),
    max:Math.max(-.85,Math.max(g[i],g[i+1],g[i+237],g[i+238])+.5)};
}
export function isPlayerPositionClear(room,p) {
  if(!p || ![p.x,p.y,p.z].every(Number.isFinite))return false;
  if(p.y < terrainBand(p).min) return false;
  const r=.28,bottom=p.y+.08,top=p.y+1.65;
  for(const box of geometry.boxes) {
    if(box.destructibleId && room.destroyedProps?.has(box.destructibleId))continue;
    if(top>box.minY && bottom<box.maxY && p.x+r>box.minX && p.x-r<box.maxX && p.z+r>box.minZ && p.z-r<box.maxZ)return false;
  }
  for(const cylinder of geometry.cylinders) {
    if(cylinder.destructibleId && room.destroyedProps?.has(cylinder.destructibleId))continue;
    if(top>cylinder.minY && bottom<cylinder.maxY && Math.hypot(p.x-cylinder.x,p.z-cylinder.z)<r+cylinder.radius)return false;
  }
  return true;
}
export function safeSpawnPosition(room,p) {
  p={...p,y:Math.max(p.y,terrainBand(p).max)};
  if(isPlayerPositionClear(room,p))return p;
  for(let rise=.25;rise<=6;rise+=.25) {
    const candidate={...p,y:p.y+rise};if(isPlayerPositionClear(room,candidate))return candidate;
  }
  for(let radius=1;radius<=12;radius++) for(let i=0;i<8;i++) {
    const candidate={x:p.x+Math.cos(i*Math.PI/4)*radius,y:p.y,z:p.z+Math.sin(i*Math.PI/4)*radius};
    if(isPlayerPositionClear(room,candidate))return candidate;
  }
  return {x:0,y:80,z:0}; // clear sky above the tower; normal glider/landing handles descent
}
export function hasLineOfSight(room,a,b,ignoreId) {
  const exists = c => (!ignoreId || c.destructibleId !== ignoreId) && !(c.destructibleId && room.destroyedProps?.has(c.destructibleId));
  for(const box of geometry.boxes) if(exists(box) && segmentBox(a,b,box)) return false;
  for(const c of geometry.cylinders) if(exists(c) && segmentCylinder(a,b,c)) return false;
  for(const build of room.buildables?.values() || []) {
    if(build.buildId!==ignoreId && segmentBuild(a,b,build))return false;
  }
  return true;
}
export function canReachLoot(room,player,item) {
  return hasLineOfSight(room,{...player.position,y:player.position.y+1.2},
    {...item.position,y:item.position.y+.35});
}

export function isBuildPlacementClear(room, build) {
  const t=buildTransform(build);
  if(!t)return false;
  return !overlapsBuildGeometry(build.pieceType,t,geometry.boxes.filter(b=>!room.destroyedProps?.has(b.destructibleId)),geometry.cylinders.filter(c=>!room.destroyedProps?.has(c.destructibleId)));
}
