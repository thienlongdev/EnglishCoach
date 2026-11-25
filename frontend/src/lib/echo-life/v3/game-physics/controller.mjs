import { zones } from '../world-data/world.mjs';
import { getObjectFootprint, orientedBounds } from '../progression/placement.mjs';

export const limit = (v, a, b) => Math.min(b, Math.max(a, v));

export function ground(zone, x, z) {
  // Four 12 cm risers on the approach to the campus lectern; same footprint as the meshes.
  return zone === 'campus' && x >= 2.8 && x <= 5.2 && z >= 1 && z <= 4.4 ? Math.min(4, Math.floor((z - 1) / 0.38) + 1) * 0.12 : 0;
}

export function walkable(zone, x, z, r = 0.29, state = null) {
  const area = zones[zone];
  if (!area || Math.abs(x) > area.size / 2 - r || Math.abs(z) > (area.depth || area.size) / 2 - r) return false;
  if (zone === 'greenway') {
    const dx = x - Math.round(x / 20) * 20;
    const dz = z - Math.round(z / 20) * 20;
    if (Math.abs(dx - 5.9) < 3.3 + r && Math.abs(dz - 5.8) < 2.8 + r && Math.abs(x) > 12) return false;
  }
  const placed = state?.progression?.ownedObjects?.filter(o => !o.location.inStorage && o.location.zoneId === zone) || [];
  const superseded = new Set(placed.map(o => o.interactionState?.lockedCoreProp).filter(Boolean));
  if (area.props.some(p => !superseded.has(p.id) && p.width > 0 && p.depth > 0 && Math.abs(x - p.x) < p.width / 2 + r && Math.abs(z - p.z) < p.depth / 2 + r)) {
    return false;
  }
  for (const o of placed) {
    if (o.category === 'vehicle_rideable') continue;
    const f = getObjectFootprint(o);
    const b = orientedBounds(f.width, f.depth, o.placement.yaw || 0);
    if (Math.abs(x - o.placement.x) < b.halfW + r && Math.abs(z - o.placement.z) < b.halfD + r) return false;
  }
  return true;
}

export function playerAt(zone = 'study', x = 0, z = 0) {
  return {
    zone,
    x,
    y: ground(zone, x, z),
    z,
    yaw: 0,
    vx: 0,
    vz: 0,
    vy: 0,
    grounded: true,
    pose: 'idle',
    riding: false,
    driving: false,
    speed: 0,
  };
}

export function move(p, i, dt, rideSpec = null, state = null, carSpec = null) {
  if (!Number.isFinite(dt) || dt <= 0) return;
  dt = Math.min(dt, 0.05);
  const forward = limit(i.forward || 0, -1, 1);
  const str = limit(i.side || 0, -1, 1);
  const h = (p.riding || p.driving) ? 0 : i.heading || 0;
  const mag = Math.max(1, Math.hypot(forward, str));
  let dx = (str * Math.cos(h) + forward * Math.sin(h)) / mag;
  let dz = (-str * Math.sin(h) + forward * Math.cos(h)) / mag;
  let speed = i.crouch ? 1.15 : i.run ? 4.4 : 2.25;

  if (p.driving) {
    const maxSpd = carSpec?.maxSpeed ?? 14.0;
    const revSpd = carSpec?.reverseSpeed ?? -4.5;
    const accel = carSpec?.acceleration ?? 7.8;
    const brake = carSpec?.braking ?? 18.0;
    const handle = carSpec?.handling ?? 1.8;
    const drag = i.brake ? brake : (forward === 0 ? 3.2 : 0.7);
    p.speed = limit(p.speed + dt * (forward * accel - drag * Math.sign(p.speed)), revSpd, maxSpd);
    if (!forward && Math.abs(p.speed) < 0.16) p.speed = 0;
    // Ackermann-style speed-dependent yaw steering (cannot spin in place at 0 speed!)
    const steerFactor = limit(p.speed / 3.2, -1, 1);
    p.yaw += str * dt * handle * steerFactor;
    dx = Math.sin(p.yaw);
    dz = Math.cos(p.yaw);
    speed = p.speed;
  } else if (p.riding) {
    const maxSpd = rideSpec?.maxSpeed ?? 7.5;
    const accel = rideSpec?.acceleration ?? 4.0;
    const brake = rideSpec?.braking ?? 12.0;
    const handle = rideSpec?.handling ?? 1.6;
    p.speed = limit(p.speed + dt * (forward * accel - (i.brake ? brake : 0.9) * Math.sign(p.speed)), -2.4, maxSpd);
    if (!forward && Math.abs(p.speed) < 0.12) p.speed = 0;
    p.yaw += str * dt * handle * limit(p.speed / 2, -1, 1);
    dx = Math.sin(p.yaw);
    dz = Math.cos(p.yaw);
    speed = p.speed;
  } else if (dx || dz) {
    const target = Math.atan2(dx, dz);
    const delta = target - p.yaw;
    p.yaw += Math.atan2(Math.sin(delta), Math.cos(delta)) * Math.min(1, dt * 13);
  }

  const k = 1 - Math.exp(-dt * (p.driving ? 10 : 14));
  p.vx += (dx * speed - p.vx) * k;
  p.vz += (dz * speed - p.vz) * k;
  const radius = p.driving ? (carSpec?.collisionRadius ?? 0.90) : p.riding ? 0.44 : 0.29;
  for (const axis of ['x', 'z']) {
    const velocity = axis === 'x' ? 'vx' : 'vz';
    const next = p[axis] + p[velocity] * dt;
    const x = axis === 'x' ? next : p.x;
    const z = axis === 'z' ? next : p.z;
    if (walkable(p.zone, x, z, radius, state) && ground(p.zone, x, z) - p.y <= 0.22) {
      p[axis] = next;
    } else {
      p[velocity] = 0;
      if (p.riding || p.driving) p.speed *= 0.45;
    }
  }
  const floor = ground(p.zone, p.x, p.z);
  if (i.jump && p.grounded && !p.riding && !p.driving) {
    p.vy = 4.5;
    p.grounded = false;
  }
  p.vy -= 12 * dt;
  p.y += p.vy * dt;
  if (p.y <= floor) {
    p.y = floor;
    p.vy = 0;
    p.grounded = true;
  } else {
    p.grounded = false;
  }
  p.pose = p.driving
    ? 'drive'
    : p.riding
      ? 'cycle'
      : !p.grounded
        ? 'jump'
        : i.crouch
          ? 'crouch'
          : Math.hypot(p.vx, p.vz) > 0.16
            ? (i.run ? 'run' : 'walk')
            : 'idle';
}

export function fall(item, dt) {
  if (item.rest) return;
  item.vy -= 9.81 * dt;
  item.y += item.vy * dt;
  const floor = ground(item.zone, item.x, item.z);
  if (item.y <= floor) {
    item.y = floor;
    item.vy *= -0.18;
    if (Math.abs(item.vy) < 0.35) {
      item.vy = 0;
      item.rest = true;
    }
  }
}
