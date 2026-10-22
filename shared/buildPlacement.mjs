export function normalizeBuildYaw(yaw) {
  return Math.atan2(Math.sin(yaw), Math.cos(yaw));
}

/** Shared conservative solid envelopes for preview, Solo and server validation. */
export function buildBounds(piece, transform) {
  const side = Math.abs(Math.sin(transform.yaw)) > 0.7;
  const rampAngle = Math.atan2(2.8, 3.6);
  const rampHalfLength = 1.8 + 0.125 * Math.sin(rampAngle);
  let halfX, halfZ, height;
  switch (piece) {
    case 'wall':
      halfX = side ? 0.175 : 1.8;
      halfZ = side ? 1.8 : 0.175;
      height = 3.2;
      break;
    case 'floor':
      halfX = halfZ = 1.84;
      height = 0.29;
      break;
    case 'ramp':
      halfX = side ? rampHalfLength : 1.6;
      halfZ = side ? 1.6 : rampHalfLength;
      height = 2.8 + 0.125 * Math.cos(rampAngle);
      break;
    default: // roof; callers validate the piece enum before using this helper
      halfX = halfZ = 2.6 / Math.sqrt(2);
      height = 1.93;
  }
  return {
    minX: transform.x - halfX, maxX: transform.x + halfX,
    minZ: transform.z - halfZ, maxZ: transform.z + halfZ,
    minY: transform.y + (piece === 'floor' ? 0.01 : 0),
    maxY: transform.y + height,
  };
}

export function overlapsBuildGeometry(piece, transform, boxes, cylinders) {
  const build = buildBounds(piece, transform);
  const epsilon = 0.04;
  // Existing half-metre snapping may sink a supported base by up to 0.25m.
  // This tolerance applies only to the bottom face, not side/ceiling overlap.
  const baseTolerance = 0.26;
  for (const box of boxes) {
    if (build.minX < box.maxX - epsilon && build.maxX > box.minX + epsilon &&
        build.minY < box.maxY - baseTolerance && build.maxY > box.minY + epsilon &&
        build.minZ < box.maxZ - epsilon && build.maxZ > box.minZ + epsilon) return true;
  }
  for (const cylinder of cylinders) {
    const x = Math.max(build.minX, Math.min(cylinder.x, build.maxX));
    const z = Math.max(build.minZ, Math.min(cylinder.z, build.maxZ));
    if (build.minY < cylinder.maxY - baseTolerance && build.maxY > cylinder.minY + epsilon &&
        Math.hypot(cylinder.x - x, cylinder.z - z) < cylinder.radius - epsilon) return true;
  }
  return false;
}
