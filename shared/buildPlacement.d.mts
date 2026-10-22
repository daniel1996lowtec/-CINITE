interface Transform {x:number;y:number;z:number;yaw:number}
interface Box {minX:number;maxX:number;minY:number;maxY:number;minZ:number;maxZ:number}
interface Cylinder {x:number;z:number;radius:number;minY:number;maxY:number}
export function buildBounds(piece:string,t:Transform):Box;
export function overlapsBuildGeometry(piece:string,t:Transform,boxes:Iterable<Box>,cylinders:Iterable<Cylinder>):boolean;

export function normalizeBuildYaw(yaw:number):number;
