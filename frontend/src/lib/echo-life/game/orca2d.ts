/**
 * Zero-Allocation 2D ORCA-Lite (Optimal Reciprocal Collision Avoidance) & Uniform Spatial Hash.
 *
 * Pure TypeScript, zero DOM/Three/WASM dependencies, zero per-frame heap allocations.
 * Shared across ambient `CrowdSim` (`80-120` pedestrians) and `PeopleSim` (`22` named residents).
 *
 * Coordinate convention (right-handed Y-up, Echo Life XZ ground plane):
 * - `+X` = East, `+Z` = South, heading `yaw = atan2(dx, dz)`, forward = `(sin(yaw), cos(yaw))`.
 * - 2D determinant: `det(a, b) = a.x * b.z - a.z * b.x`.
 * - Half-plane representation `(px, pz, dx, dz)` with unit `(dx, dz)`:
 *   feasible region satisfies `det(d, v - p) >= 0`.
 *   For outward feasible unit normal `(nx, nz)`, setting `(dx, dz) = (nz, -nx)` enforces
 *   `det(d, v - p) = nz*(vz - pz) + nx*(vx - px) = dot(n, v - p) >= 0`.
 */

const EPS = 1e-5;
const TWO_PI = Math.PI * 2;

export function wrapAnglePi(rad: number): number {
  let d = rad % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return d;
}

/**
 * Frame-rate-independent exponential heading damper with hard angular-velocity cap.
 * Prevents instant 1-frame yaw snaps at low tick rates or tight corner turns.
 */
export function turnSmooth(
  from: number,
  to: number,
  dt: number,
  stiffness = 9.0,
  maxOmega = 5.2,
): number {
  if (dt <= 0 || !Number.isFinite(to)) return from;
  const diff = wrapAnglePi(to - from);
  const expStep = diff * (1 - Math.exp(-stiffness * dt));
  const cap = maxOmega * dt;
  const clamped = expStep > cap ? cap : expStep < -cap ? -cap : expStep;
  return wrapAnglePi(from + clamped);
}

/**
 * Zero-allocation 2D open-chaining spatial hash (`1024` buckets, `~2.3 KB` total for 128 agents).
 */
export class SpatialHash2D {
  static readonly BUCKET_COUNT = 1024;
  static readonly BUCKET_MASK = 1023;
  readonly invCellSize: number;
  readonly head: Int16Array;
  readonly next: Int16Array;
  readonly capacity: number;

  constructor(capacity: number, cellSize = 2.5) {
    this.capacity = capacity;
    this.invCellSize = 1 / Math.max(0.25, cellSize);
    this.head = new Int16Array(SpatialHash2D.BUCKET_COUNT);
    this.next = new Int16Array(capacity);
    this.head.fill(-1);
    this.next.fill(-1);
  }

  clear(): void {
    this.head.fill(-1);
  }

  bucketOfCell(cx: number, cz: number): number {
    return (Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663)) & SpatialHash2D.BUCKET_MASK;
  }

  insert(id: number, x: number, z: number): void {
    const cx = Math.floor(x * this.invCellSize);
    const cz = Math.floor(z * this.invCellSize);
    const b = this.bucketOfCell(cx, cz);
    this.next[id] = this.head[b];
    this.head[b] = id;
  }
}

/**
 * Reusable scratch buffers for 2D ORCA-Lite half-plane linear programming (`0` heap allocs/call).
 */
export class OrcaScratch {
  static readonly MAX_LINES = 16;
  readonly px = new Float32Array(OrcaScratch.MAX_LINES);
  readonly pz = new Float32Array(OrcaScratch.MAX_LINES);
  readonly dx = new Float32Array(OrcaScratch.MAX_LINES);
  readonly dz = new Float32Array(OrcaScratch.MAX_LINES);

  readonly projPx = new Float32Array(OrcaScratch.MAX_LINES);
  readonly projPz = new Float32Array(OrcaScratch.MAX_LINES);
  readonly projDx = new Float32Array(OrcaScratch.MAX_LINES);
  readonly projDz = new Float32Array(OrcaScratch.MAX_LINES);

  count = 0;
  outVx = 0;
  outVz = 0;

  reset(): void {
    this.count = 0;
    this.outVx = 0;
    this.outVz = 0;
  }

  pushLine(px: number, pz: number, nx: number, nz: number): boolean {
    if (this.count >= OrcaScratch.MAX_LINES) return false;
    const len = Math.sqrt(nx * nx + nz * nz);
    if (len < EPS) return false;
    const inv = 1 / len;
    const unx = nx * inv;
    const unz = nz * inv;
    const idx = this.count++;
    this.px[idx] = px;
    this.pz[idx] = pz;
    // Feasible half-plane dot(n, v - p) >= 0 <=> det(d, v - p) >= 0 with d = (nz, -nx)
    this.dx[idx] = unz;
    this.dz[idx] = -unx;
    return true;
  }
}

/**
 * Appends one van den Berg ORCA half-plane constraint for agent A avoiding disk B.
 *
 * Includes a gentle right-hand passing symmetry breaker (`detBiased`) when two walking
 * agents approach head-on so opposing sidewalk pedestrians smoothly pass on the right
 * instead of stalling or oscillating.
 */
export function addOrcaDiskConstraint(
  scratch: OrcaScratch,
  ax: number,
  az: number,
  avx: number,
  avz: number,
  bx: number,
  bz: number,
  bvx: number,
  bvz: number,
  combinedRadius: number,
  timeHorizon: number,
  responsibility: number,
  timeStep = 0.25,
): boolean {
  if (scratch.count >= OrcaScratch.MAX_LINES) return false;

  const rx = bx - ax;
  const rz = bz - az;
  const distSq = rx * rx + rz * rz;
  const radSq = combinedRadius * combinedRadius;

  // Quick reject when well outside interaction range for max pedestrian relative speed
  const maxCheck = combinedRadius + 2.6 * timeHorizon;
  if (distSq > maxCheck * maxCheck) return false;

  const rvx = avx - bvx;
  const rvz = avz - bvz;

  let ux = 0;
  let uz = 0;
  let nx = 0;
  let nz = 0;

  if (distSq > radSq) {
    const invTau = 1 / Math.max(0.15, timeHorizon);
    const wx = rvx - invTau * rx;
    const wz = rvz - invTau * rz;
    const wLenSq = wx * wx + wz * wz;
    const dotWR = wx * rx + wz * rz;

    if (dotWR < 0 && dotWR * dotWR > radSq * wLenSq) {
      // Project onto truncated velocity-obstacle cutoff circle
      const wLen = Math.sqrt(wLenSq);
      if (wLen < EPS) {
        const invD = 1 / Math.sqrt(distSq);
        nx = -rx * invD;
        nz = -rz * invD;
      } else {
        nx = wx / wLen;
        nz = wz / wLen;
      }
      const mag = combinedRadius * invTau - wLen;
      ux = mag * nx;
      uz = mag * nz;
    } else {
      // Project onto left or right tangent leg of velocity obstacle cone
      const leg = Math.sqrt(Math.max(0, distSq - radSq));
      const invDistSq = 1 / distSq;
      const dist = Math.sqrt(distSq);
      const rawDet = rx * wz - rz * wx;
      // Right-hand passing bias when approaching head-on (av . bv < -0.15)
      const headOnBias = avx * bvx + avz * bvz < -0.15 ? 0.06 * dist : 0;
      const det = rawDet + headOnBias;

      let legX: number;
      let legZ: number;
      if (det > 0) {
        // Right-hand passing leg in Echo Life XZ plane (outward normal points away from r)
        legX = (leg * rx - combinedRadius * rz) * invDistSq;
        legZ = (combinedRadius * rx + leg * rz) * invDistSq;
        nx = -legZ;
        nz = legX;
      } else {
        // Left-hand passing leg
        legX = (leg * rx + combinedRadius * rz) * invDistSq;
        legZ = (-combinedRadius * rx + leg * rz) * invDistSq;
        nx = legZ;
        nz = -legX;
      }
      const proj = rvx * legX + rvz * legZ;
      ux = proj * legX - rvx;
      uz = proj * legZ - rvz;
    }
  } else {
    // Already overlapping: resolve gently over `timeStep`
    const invStep = 1 / Math.max(0.08, timeStep);
    const wx = rvx - invStep * rx;
    const wz = rvz - invStep * rz;
    const wLen = Math.sqrt(wx * wx + wz * wz);
    if (wLen < EPS) {
      const dist = Math.sqrt(distSq);
      if (dist > EPS) {
        nx = -rx / dist;
        nz = -rz / dist;
      } else {
        nx = 1;
        nz = 0;
      }
    } else {
      nx = wx / wLen;
      nz = wz / wLen;
    }
    const mag = combinedRadius * invStep - wLen;
    ux = mag * nx;
    uz = mag * nz;
  }

  return scratch.pushLine(avx + responsibility * ux, avz + responsibility * uz, nx, nz);
}

/**
 * Appends a smooth static oriented-bounding-box (OBB) constraint (parked cars, kiosks, benches)
 * by projecting the agent onto the closest perimeter point of the OBB and applying a static ORCA disk.
 */
export function addOrcaStaticObbConstraint(
  scratch: OrcaScratch,
  ax: number,
  az: number,
  avx: number,
  avz: number,
  agentRadius: number,
  cx: number,
  cz: number,
  yaw: number,
  halfWidth: number,
  halfLength: number,
  pad = 0.22,
  timeHorizon = 1.35,
): boolean {
  if (scratch.count >= OrcaScratch.MAX_LINES) return false;
  const rx = ax - cx;
  const rz = az - cz;
  const boundR = Math.sqrt(halfWidth * halfWidth + halfLength * halfLength) + agentRadius + pad + 2.8;
  if (Math.abs(rx) > boundR || Math.abs(rz) > boundR) return false;

  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  // Vehicle local +Z forward = (sinY, cosY), local +X left = (cosY, -sinY)
  const localX = rx * cosY - rz * sinY;
  const localZ = rx * sinY + rz * cosY;

  const clampedX = localX < -halfWidth ? -halfWidth : localX > halfWidth ? halfWidth : localX;
  const clampedZ = localZ < -halfLength ? -halfLength : localZ > halfLength ? halfLength : localZ;

  // Closest point on OBB in world space
  const nearX = cx + clampedX * cosY + clampedZ * sinY;
  const nearZ = cz - clampedX * sinY + clampedZ * cosY;

  const dx = ax - nearX;
  const dz = az - nearZ;
  if (dx * dx + dz * dz < 1e-6) {
    // Center is inside OBB: push out toward nearest face cleanly
    const penX = halfWidth - Math.abs(localX);
    const penZ = halfLength - Math.abs(localZ);
    let pushX = 0;
    let pushZ = 0;
    if (penX < penZ) {
      const s = localX >= 0 ? 1 : -1;
      pushX = cosY * s;
      pushZ = -sinY * s;
    } else {
      const s = localZ >= 0 ? 1 : -1;
      pushX = sinY * s;
      pushZ = cosY * s;
    }
    return scratch.pushLine(pushX * 1.15, pushZ * 1.15, pushX, pushZ);
  }

  return addOrcaDiskConstraint(
    scratch,
    ax,
    az,
    avx,
    avz,
    nearX,
    nearZ,
    0,
    0,
    agentRadius + pad,
    timeHorizon,
    1.0,
    0.22,
  );
}

function linearProgram1(
  px: Float32Array,
  pz: Float32Array,
  dx: Float32Array,
  dz: Float32Array,
  lineNo: number,
  maxSpeed: number,
  optVx: number,
  optVz: number,
  directionOpt: boolean,
  scratch: OrcaScratch,
): boolean {
  const lpx = px[lineNo];
  const lpz = pz[lineNo];
  const ldx = dx[lineNo];
  const ldz = dz[lineNo];

  const dotProduct = lpx * ldx + lpz * ldz;
  const discriminant = dotProduct * dotProduct + maxSpeed * maxSpeed - (lpx * lpx + lpz * lpz);
  if (discriminant < 0) return false;

  const sqrtDisc = Math.sqrt(discriminant);
  let tLeft = -dotProduct - sqrtDisc;
  let tRight = -dotProduct + sqrtDisc;

  for (let i = 0; i < lineNo; i++) {
    const idx = dx[i];
    const idz = dz[i];
    const denom = idx * ldz - idz * ldx;
    const diffX = px[i] - lpx;
    const diffZ = pz[i] - lpz;
    const numer = idx * diffZ - idz * diffX;

    if (Math.abs(denom) <= EPS) {
      if (numer > 0) return false;
      continue;
    }

    const t = numer / denom;
    if (denom > 0) {
      if (t > tLeft) tLeft = t;
    } else {
      if (t < tRight) tRight = t;
    }
    if (tLeft > tRight) return false;
  }

  let t: number;
  if (directionOpt) {
    t = optVx * ldx + optVz * ldz > 0 ? tRight : tLeft;
  } else {
    t = ldx * (optVx - lpx) + ldz * (optVz - lpz);
    if (t < tLeft) t = tLeft;
    else if (t > tRight) t = tRight;
  }

  scratch.outVx = lpx + t * ldx;
  scratch.outVz = lpz + t * ldz;
  return true;
}

function linearProgram2(
  px: Float32Array,
  pz: Float32Array,
  dx: Float32Array,
  dz: Float32Array,
  count: number,
  maxSpeed: number,
  optVx: number,
  optVz: number,
  directionOpt: boolean,
  scratch: OrcaScratch,
): number {
  if (directionOpt) {
    scratch.outVx = optVx * maxSpeed;
    scratch.outVz = optVz * maxSpeed;
  } else {
    const optSq = optVx * optVx + optVz * optVz;
    if (optSq > maxSpeed * maxSpeed) {
      const scale = maxSpeed / Math.sqrt(optSq);
      scratch.outVx = optVx * scale;
      scratch.outVz = optVz * scale;
    } else {
      scratch.outVx = optVx;
      scratch.outVz = optVz;
    }
  }

  for (let i = 0; i < count; i++) {
    const det = dx[i] * (scratch.outVz - pz[i]) - dz[i] * (scratch.outVx - px[i]);
    if (det < 0) {
      const prevVx = scratch.outVx;
      const prevVz = scratch.outVz;
      if (!linearProgram1(px, pz, dx, dz, i, maxSpeed, optVx, optVz, directionOpt, scratch)) {
        scratch.outVx = prevVx;
        scratch.outVz = prevVz;
        return i;
      }
    }
  }
  return count;
}

function linearProgram3(
  scratch: OrcaScratch,
  beginLine: number,
  maxSpeed: number,
): void {
  const count = scratch.count;
  const px = scratch.px;
  const pz = scratch.pz;
  const dx = scratch.dx;
  const dz = scratch.dz;
  const ppx = scratch.projPx;
  const ppz = scratch.projPz;
  const pdx = scratch.projDx;
  const pdz = scratch.projDz;

  let distance = 0;

  for (let i = beginLine; i < count; i++) {
    const violation = -(dx[i] * (scratch.outVz - pz[i]) - dz[i] * (scratch.outVx - px[i]));
    if (violation > distance) {
      let projCount = 0;
      for (let j = 0; j < i; j++) {
        const det = dx[i] * dz[j] - dz[i] * dx[j];
        let ptX: number;
        let ptZ: number;
        if (Math.abs(det) <= EPS) {
          if (dx[i] * dx[j] + dz[i] * dz[j] > 0) continue;
          ptX = 0.5 * (px[i] + px[j]);
          ptZ = 0.5 * (pz[i] + pz[j]);
        } else {
          const t = (dx[j] * (pz[i] - pz[j]) - dz[j] * (px[i] - px[j])) / det;
          ptX = px[i] + t * dx[i];
          ptZ = pz[i] + t * dz[i];
        }
        const dirX = dx[j] - dx[i];
        const dirZ = dz[j] - dz[i];
        const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
        if (len < EPS) continue;
        ppx[projCount] = ptX;
        ppz[projCount] = ptZ;
        pdx[projCount] = dirX / len;
        pdz[projCount] = dirZ / len;
        projCount++;
      }

      const prevVx = scratch.outVx;
      const prevVz = scratch.outVz;
      // Optimize along outward normal of line i: n_i = (-dz[i], dx[i])
      if (linearProgram2(ppx, ppz, pdx, pdz, projCount, maxSpeed, -dz[i], dx[i], true, scratch) < projCount) {
        scratch.outVx = prevVx;
        scratch.outVz = prevVz;
      }
      distance = -(dx[i] * (scratch.outVz - pz[i]) - dz[i] * (scratch.outVx - px[i]));
    }
  }
}

/**
 * Solves the 2D ORCA-Lite linear program stored in `scratch` closest to `(prefVx, prefVz)`
 * subject to `||v|| <= maxSpeed`, writing the collision-free velocity to `(scratch.outVx, scratch.outVz)`.
 */
export function solveOrca2D(
  scratch: OrcaScratch,
  prefVx: number,
  prefVz: number,
  maxSpeed: number,
): void {
  const safeMax = Math.max(0, maxSpeed);
  if (safeMax <= EPS) {
    scratch.outVx = 0;
    scratch.outVz = 0;
    return;
  }
  const failLine = linearProgram2(
    scratch.px,
    scratch.pz,
    scratch.dx,
    scratch.dz,
    scratch.count,
    safeMax,
    prefVx,
    prefVz,
    false,
    scratch,
  );
  if (failLine < scratch.count) {
    linearProgram3(scratch, failLine, safeMax);
  }
}
