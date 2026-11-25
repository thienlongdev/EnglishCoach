import { walkable } from '../game-physics/controller.mjs';
import { zones } from '../world-data/world.mjs';
import { getVehicleSpec, getVehicleComponent } from '../progression/catalog.mjs';

export const ROAD_CAPABLE_ZONES = ['yard', 'street', 'greenway'];

export const CAR_PHYSICS_SPECS = {
  car_mango_micro: {
    name: 'Mango Micro City EV',
    model: 'car_mango_micro',
    maxSpeed: 13.5,
    reverseSpeed: -4.2,
    acceleration: 7.4,
    braking: 18.0,
    handling: 1.85,
    maxSteerRad: 0.46,
    wheelRadius: 0.30,
    collisionRadius: 0.88,
  },
  car_river_sedan: {
    name: 'River Contemporary Sedan',
    model: 'car_river_sedan',
    maxSpeed: 15.8,
    reverseSpeed: -4.6,
    acceleration: 8.6,
    braking: 20.0,
    handling: 1.72,
    maxSteerRad: 0.42,
    wheelRadius: 0.33,
    collisionRadius: 0.94,
  },
  car_lotus_spider: {
    name: 'Lotus Spider Roadster',
    model: 'car_lotus_spider',
    maxSpeed: 18.4,
    reverseSpeed: -5.0,
    acceleration: 10.8,
    braking: 22.5,
    handling: 1.98,
    maxSteerRad: 0.44,
    wheelRadius: 0.33,
    collisionRadius: 0.92,
  },
  car_halo_vector: {
    name: 'Halo Vector Hypercar',
    model: 'car_halo_vector',
    maxSpeed: 21.0,
    reverseSpeed: -5.2,
    acceleration: 12.6,
    braking: 24.5,
    handling: 2.05,
    maxSteerRad: 0.40,
    wheelRadius: 0.35,
    collisionRadius: 0.96,
  },
};

export function getOwnedDrivableCars(s) {
  return (s.progression?.ownedObjects || []).filter(
    o => (o.category === 'vehicle_display' || o.category === 'vehicle_automobile') && Object.hasOwn(CAR_PHYSICS_SPECS, o.selectedVariantId)
  );
}

export function getActiveCarSpec(s) {
  const activeId = s.worldV3?.car?.instanceId;
  const owned = getOwnedDrivableCars(s);
  const obj = owned.find(o => o.instanceId === activeId) || owned[0] || null;
  if (!obj) {
    // Players who completed Tuan Kiet's Open-Road Permit arc can also drive the community Mango Micro EV!
    if (s.worldV3?.openRoadPermit) {
      return {
        ...CAR_PHYSICS_SPECS.car_mango_micro,
        instanceId: 'community_mango_ev',
        paintHex: '#1f6f54',
        drivable: true,
      };
    }
    return null;
  }
  const base = CAR_PHYSICS_SPECS[obj.selectedVariantId] || CAR_PHYSICS_SPECS.car_mango_micro;
  const spec = {
    ...base,
    instanceId: obj.instanceId,
    paintHex: obj.customAppearance?.primaryColor || null,
    drivable: true,
  };
  for (const slot of ['wheels', 'exterior', 'interior']) {
    const cid = obj.installedComponents?.[slot];
    if (!cid) continue;
    const comp = getVehicleComponent(cid);
    if (comp?.id === 'vcomp_car_forged_wheels') { spec.handling += 0.14; spec.maxSpeed += 0.9; }
    if (comp?.id === 'vcomp_car_aero_pack') { spec.acceleration += 0.9; spec.maxSpeed += 1.4; }
  }
  return spec;
}

export function summonCarToRoadZone(s, zoneId) {
  const car = s.worldV3?.car;
  if (!car) return { ok: false, msg: 'Car system unavailable.' };
  const spec = getActiveCarSpec(s);
  if (!spec) {
    return { ok: false, msg: 'Own an automobile from Greenway Motors or complete Tuan Kiet’s Open-Road Permit side arc first.' };
  }
  const targetZone = ROAD_CAPABLE_ZONES.includes(zoneId) ? zoneId : 'street';
  const spots = {
    yard: { x: -1.8, z: 3.4, yaw: Math.PI / 2 },
    street: { x: -10.5, z: 0.4, yaw: Math.PI / 2 },
    greenway: { x: -102, z: 0.4, yaw: Math.PI / 2 },
  };
  const spot = spots[targetZone];
  Object.assign(car, {
    active: true,
    instanceId: spec.instanceId,
    model: spec.model,
    zone: targetZone,
    x: spot.x,
    z: spot.z,
    yaw: spot.yaw,
    wheelSpin: 0,
    steerAngle: 0,
    doorOpen: 0,
  });
  return { ok: true, msg: `${spec.name} is parked and ready to drive in ${zones[targetZone].label}!` };
}

export function toggleDriveCar(s) {
  const p = s.player;
  const car = s.worldV3?.car;
  if (!car) return { ok: false, msg: 'No drivable car configured.' };
  const spec = getActiveCarSpec(s);
  if (!spec) {
    return { ok: false, msg: 'Buy a car at Greenway Motors or earn Tuan Kiet’s Open-Road Permit first.' };
  }

  // Exit car safely onto walkable kerbside
  if (p.driving) {
    Object.assign(car, { zone: p.zone, x: p.x, z: p.z, yaw: p.yaw, doorOpen: 1.0 });
    p.driving = false;
    p.riding = false;
    p.speed = 0;
    p.vx = 0;
    p.vz = 0;
    for (const side of [-1, 1]) {
      const ex = p.x + side * 1.45 * Math.cos(p.yaw);
      const ez = p.z - side * 1.45 * Math.sin(p.yaw);
      if (walkable(p.zone, ex, ez, 0.32, s)) {
        p.x = ex;
        p.z = ez;
        break;
      }
    }
    return { ok: true, msg: `Parked ${spec.name}.` };
  }

  // Enter car
  if (s.held || p.riding) return { ok: false, msg: 'Put down what you are carrying or park your bike first.' };
  if (!ROAD_CAPABLE_ZONES.includes(p.zone)) {
    return { ok: false, msg: 'Cars can only be driven on road-capable outdoor areas (Home garden, Riverside Lane, Riverside Greenway).' };
  }
  if (!car.active || car.zone !== p.zone || Math.hypot(p.x - car.x, p.z - car.z) > 3.6) {
    return { ok: false, msg: 'Move closer to your parked car to enter.' };
  }
  p.driving = true;
  p.riding = false;
  p.x = car.x;
  p.z = car.z;
  p.yaw = car.yaw;
  p.speed = 0;
  car.doorOpen = 1.0;
  car.model = spec.model;
  car.instanceId = spec.instanceId;
  return { ok: true, msg: `Driving ${spec.name}! W/S accelerate & reverse, A/D steer, Space brake, X exit.` };
}
