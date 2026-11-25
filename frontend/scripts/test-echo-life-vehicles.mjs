// Echo Life Vehicles 2.0 — Pure-TS Vehicle Dynamics, 4-Corner Suspension,
// Ackermann Steering, Handbrake Drift, Two-Wheeler Lean/Cadence, and Lighting/Horn tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const babel = require('next/dist/compiled/babel/bundle.js');
const src = fileURLToPath(new URL('../src/', import.meta.url));
const cache = new Map();

function resolve(from, target) {
  return target.startsWith('@/')
    ? target.slice(2)
    : path.posix.normalize(path.posix.dirname(from) + '/' + target);
}

function load(rel) {
  if (rel.endsWith('.mjs') || rel.endsWith('.json')) return require(path.join(src, rel));
  if (cache.has(rel)) return cache.get(rel);
  const m = { exports: {} };
  cache.set(rel, m.exports);
  const code = babel.core().transformSync(fs.readFileSync(path.join(src, rel), 'utf8'), {
    filename: rel,
    babelrc: false,
    configFile: false,
    presets: [babel.presetTypescript()],
    plugins: [babel.pluginTransformModulesCommonjs()],
  }).code;
  new Function('module', 'exports', 'require', code)(m, m.exports, (n) => {
    const r = resolve(rel, n);
    return load(/\.(mjs|json)$/.test(r) ? r : r + '.ts');
  });
  return m.exports;
}

const VD = load('lib/echo-life/game/vehicleDynamics.ts');
const twoWheelerModels = load('lib/echo-life/game/two-wheeler-models.json');

let checks = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  checks++;
}

function assertAllFinite(wheels, chassis, label) {
  ok(
    Number.isFinite(chassis.height) &&
      Number.isFinite(chassis.pitch) &&
      Number.isFinite(chassis.roll) &&
      Number.isFinite(chassis.heaveVel) &&
      Number.isFinite(chassis.slipAngle) &&
      Number.isFinite(chassis.driftIntensity),
    `${label}: chassis fields are all finite`,
  );
  ok(
    wheels.every(
      (w) =>
        Number.isFinite(w.ground) &&
        Number.isFinite(w.height) &&
        Number.isFinite(w.velocity) &&
        Number.isFinite(w.travel) &&
        Number.isFinite(w.spin) &&
        Number.isFinite(w.loadFactor),
    ),
    `${label}: all 4 wheel contact states are finite`,
  );
}

// ── 1. Per-class car & two-wheeler profiles ────────────────────────────────────────────────────────────────
{
  const classes = ['micro', 'sedan', 'spider', 'hyper'];
  const models = ['car_mango_micro', 'car_river_sedan', 'car_lotus_spider', 'car_halo_vector'];
  for (let i = 0; i < classes.length; i++) {
    const byClass = VD.getCarHandlingProfile(classes[i]);
    const byModel = VD.getCarHandlingProfile(models[i]);
    ok(byClass === byModel && byClass.carClass === classes[i], `car profile lookup matches for ${classes[i]} / ${models[i]}`);
    ok(byClass.wheelbase > 1.5 && byClass.track > 1.0 && byClass.massKg > 800, `${classes[i]} has realistic geometry & mass`);
  }
  ok(VD.getCarHandlingProfile('unknown_car').carClass === 'micro', 'unknown car model falls back cleanly to micro');
  ok(VD.getCarHandlingProfile(null).carClass === 'micro', 'null car model falls back cleanly to micro');

  const micro = VD.CAR_HANDLING_PROFILES.micro;
  const sedan = VD.CAR_HANDLING_PROFILES.sedan;
  const spider = VD.CAR_HANDLING_PROFILES.spider;
  const hyper = VD.CAR_HANDLING_PROFILES.hyper;
  ok(
    micro.springStiffness < sedan.springStiffness &&
      sedan.springStiffness < spider.springStiffness &&
      spider.springStiffness < hyper.springStiffness,
    'spring stiffness increases from micro -> sedan -> spider -> hyper',
  );
  ok(
    micro.antiRollStiffness < sedan.antiRollStiffness &&
      sedan.antiRollStiffness < spider.antiRollStiffness &&
      spider.antiRollStiffness < hyper.antiRollStiffness,
    'anti-roll stiffness K_arb increases from micro -> sedan -> spider -> hyper',
  );
  ok(
    hyper.cgHeight < spider.cgHeight && spider.cgHeight < sedan.cgHeight && sedan.cgHeight < micro.cgHeight,
    'CG height lowers progressively for sportier classes',
  );
  ok(
    micro.maxSpeed < sedan.maxSpeed && sedan.maxSpeed < spider.maxSpeed && spider.maxSpeed < hyper.maxSpeed,
    'top speeds progress across all 4 car classes',
  );

  for (const bikeClass of ['bicycle', 'scooter', 'vesper', 'cafe_racer']) {
    const bp = VD.getTwoWheelerHandlingProfile(bikeClass);
    ok(bp.bikeClass === bikeClass, `two-wheeler profile exists for ${bikeClass}`);
    ok(
      bikeClass === 'bicycle' ? !bp.powered && bp.hornKind === 'bike' : bp.powered && bp.hornKind === 'motorbike',
      `${bikeClass} has accurate powered flag and hornKind`,
    );
  }
  for (const modelId of Object.keys(twoWheelerModels)) {
    const bp = VD.getTwoWheelerHandlingProfile(modelId);
    ok(Boolean(bp.bikeClass), `all 10 staged two-wheeler GLB models resolve cleanly (${modelId} -> ${bp.bikeClass})`);
  }
}

// ── 2. 4-Corner Suspension: Squat, Nose-Dive, Roll, ARB Differentiation, Bump Heave & Convergence ──────────
{
  const rollByClass = {};
  for (const carClass of ['micro', 'sedan', 'spider', 'hyper']) {
    const profile = VD.getCarHandlingProfile(carClass);
    const wheels = VD.createWheelContacts();
    const chassis = VD.createChassisState();
    const pose = { x: 0, z: 0, yaw: 0 };
    let speed = 0;
    let steer = 0;
    let spin = 0;

    // 2a. Hard acceleration -> squat (negative pitch in 'YXZ' where front +Z rises)
    for (let i = 0; i < 30; i++) {
      const r = VD.stepCarDynamics({
        pose, speed, steer, spin, driving: true, stopping: false, wetRoad: false,
        dt: 1 / 60, throttle: 1, sideInput: 0, brake: false, handbrake: false,
        profile, wheels, chassis, fitsPose: () => true, groundAt: () => 0,
      });
      speed = r.speed; steer = r.steer; spin = r.spin;
    }
    ok(chassis.initialized && chassis.pitch < -0.005, `${carClass}: acceleration produces clear chassis squat (pitch=${chassis.pitch.toFixed(4)})`);
    assertAllFinite(wheels, chassis, `${carClass} accel`);

    // 2b. Hard braking -> nose-dive (positive pitch where front +Z dips)
    let peakDive = -1;
    for (let i = 0; i < 24; i++) {
      const r = VD.stepCarDynamics({
        pose, speed, steer, spin, driving: true, stopping: false, wetRoad: false,
        dt: 1 / 60, throttle: 0, sideInput: 0, brake: true, handbrake: false,
        profile, wheels, chassis, fitsPose: () => true, groundAt: () => 0,
      });
      speed = r.speed; steer = r.steer; spin = r.spin;
      peakDive = Math.max(peakDive, chassis.pitch);
    }
    ok(peakDive > 0.015, `${carClass}: braking produces strong nose-dive (peakDive=${peakDive.toFixed(4)})`);

    // 2c. 180-frame brake rest settlement contract (matches test-echo-life-game.mjs)
    for (let i = 0; i < 180; i++) {
      const r = VD.stepCarDynamics({
        pose, speed, steer, spin, driving: true, stopping: false, wetRoad: false,
        dt: 1 / 60, throttle: 0, sideInput: 0, brake: true, handbrake: false,
        profile, wheels, chassis, fitsPose: () => true, groundAt: () => 0,
      });
      speed = r.speed; steer = r.steer; spin = r.spin;
    }
    ok(
      speed === 0 && wheels.every((w) => Math.abs(w.velocity) < 0.002 && Math.abs(w.travel) < 0.002),
      `${carClass}: 180-frame brake settles cleanly on all 4 contacts`,
    );

    // 2d. Steady cornering lateral G -> outward body roll (right turn: sideInput=+1 -> roll < 0)
    VD.resetSuspension(wheels, chassis);
    pose.x = 0; pose.z = 0; pose.yaw = 0;
    speed = 10; steer = 0; spin = 0;
    let rightTurnRoll = 0;
    for (let i = 0; i < 45; i++) {
      VD.stepCarSuspension({
        wheels, chassis, profile, pose, dt: 1 / 60,
        forwardAccel: 0, lateralAccel: -8.0, groundAt: () => 0,
        distance: 10 / 60, turn: -0.013, driving: true,
      });
      rightTurnRoll = chassis.roll;
    }
    ok(rightTurnRoll < -0.008, `${carClass}: right turn lateral G produces outward body roll (roll=${rightTurnRoll.toFixed(4)})`);
    rollByClass[carClass] = Math.abs(rightTurnRoll);

    // Left turn symmetry -> positive roll
    let leftTurnRoll = 0;
    for (let i = 0; i < 60; i++) {
      VD.stepCarSuspension({
        wheels, chassis, profile, pose, dt: 1 / 60,
        forwardAccel: 0, lateralAccel: +8.0, groundAt: () => 0,
        distance: 10 / 60, turn: +0.013, driving: true,
      });
      leftTurnRoll = chassis.roll;
    }
    ok(leftTurnRoll > 0.008, `${carClass}: left turn lateral G produces symmetric opposite roll (roll=${leftTurnRoll.toFixed(4)})`);
  }

  ok(
    rollByClass.hyper < rollByClass.spider &&
      rollByClass.spider < rollByClass.sedan &&
      rollByClass.hyper < rollByClass.micro,
    `higher K_arb + lower CG keeps hypercar flatter in corners than sedan/micro (${JSON.stringify(
      Object.fromEntries(Object.entries(rollByClass).map(([k, v]) => [k, Number(v.toFixed(4))])),
    )})`,
  );
}

// ── 3. Curb/Bump Heave Impulse, Teleport Guard, and Post-Exit Idle Settling ────────────────────────────────
{
  const profile = VD.getCarHandlingProfile('sedan');
  const wheels = VD.createWheelContacts();
  const chassis = VD.createChassisState();
  const pose = { x: 0, z: 0, yaw: 0 };

  // Initialize on flat road y=0
  VD.stepCarSuspension({
    wheels, chassis, profile, pose, dt: 1 / 60,
    forwardAccel: 0, lateralAccel: 0, groundAt: () => 0,
    distance: 0, turn: 0, driving: true,
  });

  // Drive over a 0.08 m curb (step up in elevation)
  VD.stepCarSuspension({
    wheels, chassis, profile, pose, dt: 1 / 60,
    forwardAccel: 0, lateralAccel: 0, groundAt: () => 0.08,
    distance: 0.12, turn: 0, driving: true,
  });
  ok(chassis.heaveVel > 0.05, `curb elevation step injects damped vertical bump heave (heaveVel=${chassis.heaveVel.toFixed(3)})`);

  for (let i = 0; i < 150; i++) {
    VD.stepCarSuspension({
      wheels, chassis, profile, pose, dt: 1 / 60,
      forwardAccel: 0, lateralAccel: 0, groundAt: () => 0.08,
      distance: 0, turn: 0, driving: true,
    });
  }
  ok(
    Math.abs(chassis.height - 0.08) < 0.001 &&
      Math.abs(chassis.heaveVel) < 0.002 &&
      wheels.every((w) => Math.abs(w.velocity) < 0.002 && Math.abs(w.travel) < 0.002),
    'bump heave oscillation damps smoothly onto the elevated surface',
  );

  // Teleport safety (> 0.45 m snap without launching chassis)
  VD.stepCarSuspension({
    wheels, chassis, profile, pose, dt: 1 / 60,
    forwardAccel: 0, lateralAccel: 0, groundAt: () => 2.5,
    distance: 0, turn: 0, driving: true,
  });
  ok(
    Math.abs(chassis.height - 2.5) < 0.02 && Math.abs(chassis.heaveVel) < 0.05,
    'large elevation teleport snaps cleanly without launching chassis',
  );

  // Post-exit settling (`driving === false`): tilt hard, inject exit rebound, then settle while parked!
  for (let i = 0; i < 30; i++) {
    VD.stepCarSuspension({
      wheels, chassis, profile, pose, dt: 1 / 60,
      forwardAccel: -18, lateralAccel: -9, groundAt: () => 0,
      distance: 0.1, turn: -0.02, driving: true,
    });
  }
  chassis.slipAngle = 0.25;
  const pitchAtExit = chassis.pitch;
  const rollAtExit = chassis.roll;
  ok(Math.abs(pitchAtExit) > 0.02 && Math.abs(rollAtExit) > 0.015, 'car has active tilt right before driver exits');

  // Player exits car -> driver-side weight rebound + parked settling
  VD.injectDriverWeightDip(wheels, false);
  for (let i = 0; i < 150; i++) {
    VD.stepCarDynamics({
      pose, speed: 0, steer: 0.3, spin: 0, driving: false, stopping: false, wetRoad: false,
      dt: 1 / 60, throttle: 0, sideInput: 0, brake: false, handbrake: false,
      profile, wheels, chassis, fitsPose: () => true, groundAt: () => 0,
    });
  }
  ok(
    Math.abs(chassis.pitch) < 0.001 &&
      Math.abs(chassis.roll) < 0.001 &&
      Math.abs(chassis.slipAngle) < 0.001 &&
      wheels.every((w) => Math.abs(w.velocity) < 0.002 && Math.abs(w.travel) < 0.002),
    'suspension settles smoothly to level rest even after player exits (driving === false)',
  );

  // NaN / extreme input resilience
  VD.stepCarSuspension({
    wheels, chassis, profile, pose, dt: Number.NaN,
    forwardAccel: Number.POSITIVE_INFINITY, lateralAccel: Number.NaN,
    groundAt: () => Number.NaN, distance: Number.NaN, turn: Number.NaN, driving: true,
  });
  VD.stepCarSuspension({
    wheels, chassis, profile, pose, dt: 10,
    forwardAccel: 1e6, lateralAccel: -1e6,
    groundAt: () => 0, distance: 100, turn: 10, driving: true,
  });
  assertAllFinite(wheels, chassis, 'extreme/NaN input stress');
}

// ── 4. Ackermann Steering, Torque Curve, Reverse Gear, Hill Grade, Differential Spin ───────────────────────
{
  const profile = VD.getCarHandlingProfile('spider');
  // Ackermann: left turn (steer > 0) -> left/inner wheel (+1) steers sharper than right/outer (-1)
  const leftInner = VD.ackermannWheelSteer(0.35, profile.wheelbase, profile.track, 1);
  const rightOuter = VD.ackermannWheelSteer(0.35, profile.wheelbase, profile.track, -1);
  ok(leftInner > rightOuter && rightOuter > 0, `Ackermann left turn: inner (${leftInner.toFixed(4)}) > outer (${rightOuter.toFixed(4)})`);

  // Right turn (steer < 0) -> right/inner wheel (-1) steers sharper negative than left/outer (+1)
  const rightInner = VD.ackermannWheelSteer(-0.35, profile.wheelbase, profile.track, -1);
  const leftOuter = VD.ackermannWheelSteer(-0.35, profile.wheelbase, profile.track, 1);
  ok(Math.abs(rightInner) > Math.abs(leftOuter) && rightInner < 0 && leftOuter < 0, 'Ackermann right turn symmetry holds');
  ok(VD.ackermannWheelSteer(0, profile.wheelbase, profile.track, 1) === 0, 'zero steer yields exact 0 Ackermann angle');

  // Speed-sensitive & wet grip steering limits
  const s0 = VD.computeSpeedSensitiveSteerLimit(0, profile, false);
  const s10 = VD.computeSpeedSensitiveSteerLimit(10, profile, false);
  const s18 = VD.computeSpeedSensitiveSteerLimit(18, profile, false);
  const s18Wet = VD.computeSpeedSensitiveSteerLimit(18, profile, true);
  ok(s0 > s10 && s10 > s18 && s18Wet < s18, 'steering limit tapers with speed and tightens on wet road');

  // Progressive torque curve: stronger punch at launch than near top speed
  const launch = VD.stepLongitudinalSpeed({
    speed: 0.5, dt: 1 / 60, throttle: 1, sideInput: 0, brake: false, handbrake: false, profile,
  });
  const highEnd = VD.stepLongitudinalSpeed({
    speed: profile.maxSpeed * 0.85, dt: 1 / 60, throttle: 1, sideInput: 0, brake: false, handbrake: false, profile,
  });
  ok(launch.forwardAccel > highEnd.forwardAccel && highEnd.forwardAccel > 0, 'progressive torque delivers punchier launch than high-end pull');

  // Reverse gear
  let revSpeed = 0;
  for (let i = 0; i < 120; i++) {
    const r = VD.stepLongitudinalSpeed({
      speed: revSpeed, dt: 1 / 60, throttle: -1, sideInput: 0, brake: false, handbrake: false, profile,
    });
    revSpeed = r.speed;
  }
  ok(
    revSpeed < -2.5 && revSpeed >= profile.reverseSpeed - 1e-6,
    `reverse gear accelerates smoothly and clamps at reverseSpeed (${revSpeed.toFixed(2)} m/s)`,
  );

  // Hill grade resistance
  const flatStep = VD.stepLongitudinalSpeed({
    speed: 6, dt: 0.1, throttle: 0.5, sideInput: 0, brake: false, handbrake: false, slopeRad: 0, profile,
  });
  const uphillStep = VD.stepLongitudinalSpeed({
    speed: 6, dt: 0.1, throttle: 0.5, sideInput: 0, brake: false, handbrake: false, slopeRad: 0.12, profile,
  });
  ok(uphillStep.speed < flatStep.speed, 'uphill grade slows acceleration compared to flat road');

  // Turning differential wheel spin
  const wheels = VD.createWheelContacts();
  const chassis = VD.createChassisState();
  const pose = { x: 0, z: 0, yaw: 0 };
  let speed = 0; let steer = 0; let spin = 0;
  for (let i = 0; i < 24; i++) {
    const r = VD.stepCarDynamics({
      pose, speed, steer, spin, driving: true, stopping: false, wetRoad: false,
      dt: 1 / 60, throttle: 1, sideInput: 0.6, brake: false, handbrake: false,
      profile, wheels, chassis, fitsPose: () => true, groundAt: () => 0,
    });
    speed = r.speed; steer = r.steer; spin = r.spin;
  }
  const spins = wheels.map((w) => w.spin);
  ok(
    spins.every((s) => s > 0) && Math.max(...spins) - Math.min(...spins) > 0.001,
    'turning produces distinct inside vs outside differential wheel spin',
  );
}

// ── 5. Handbrake Drift Build & Decay + Tangent-Projected Curb Deflection ───────────────────────────────────
{
  const profile = VD.getCarHandlingProfile('spider');
  let slipAngle = 0;
  let driftIntensity = 0;
  let yawMult = 1;

  // Hold Space handbrake while cornering at 11 m/s
  for (let i = 0; i < 30; i++) {
    const res = VD.stepHandbrakeSlip({
      slipAngle, speed: 11, sideInput: 1, handbrake: true, driving: true, wetRoad: false, dt: 1 / 60, profile,
    });
    slipAngle = res.slipAngle;
    driftIntensity = res.driftIntensity;
    yawMult = res.yawRateMultiplier;
  }
  ok(
    Math.abs(slipAngle) > 0.15 && Math.abs(slipAngle) <= profile.maxSlipRad + 1e-6 && driftIntensity > 0.45 && yawMult > 1.15,
    `handbrake turn builds controlled rear drift slip (slip=${slipAngle.toFixed(3)} rad, intensity=${driftIntensity.toFixed(2)})`,
  );

  // Release handbrake -> monotonic smooth decay back to 0 within 1 s
  let prevAbs = Math.abs(slipAngle);
  let monotonic = true;
  for (let i = 0; i < 65; i++) {
    const res = VD.stepHandbrakeSlip({
      slipAngle, speed: 10, sideInput: 0.2, handbrake: false, driving: true, wetRoad: false, dt: 1 / 60, profile,
    });
    if (Math.abs(res.slipAngle) > prevAbs + 1e-9) monotonic = false;
    prevAbs = Math.abs(res.slipAngle);
    slipAngle = res.slipAngle;
    driftIntensity = res.driftIntensity;
  }
  ok(monotonic && Math.abs(slipAngle) < 0.005 && driftIntensity < 0.02, 'releasing handbrake decays drift slip monotonically to zero');

  // Straight-line handbrake acts as strong emergency brake with zero slip
  const straightBrake = VD.stepLongitudinalSpeed({
    speed: 12, dt: 0.1, throttle: 0, sideInput: 0, brake: false, handbrake: true, profile,
  });
  const normalBrake = VD.stepLongitudinalSpeed({
    speed: 12, dt: 0.1, throttle: 0, sideInput: 0, brake: true, handbrake: false, profile,
  });
  ok(straightBrake.speed < normalBrake.speed && straightBrake.brakingActive, 'straight-line handbrake provides strong emergency deceleration');

  // Curb deflection: diagonal impact against road boundary z <= 2.0 deflects smoothly instead of dead-stopping
  const currentPose = { x: 0, z: 1.98, yaw: Math.PI / 4 };
  const nextPose = { x: 0.07, z: 2.05, yaw: Math.PI / 4 };
  const deflected = VD.resolveCurbDeflection(currentPose, nextPose, 0.1, (cand) => cand.z <= 2.0);
  ok(
    deflected.deflected && !deflected.blocked && deflected.movedDistance > 0 && deflected.bumpImpulse > 0,
    'glancing curb contact deflects smoothly along road boundary with subtle bump impulse',
  );

  // Completely blocked footprint stops cleanly with zero displacement
  const blocked = VD.resolveCurbDeflection(currentPose, nextPose, 0.1, () => false);
  ok(
    blocked.blocked && blocked.speedScale === 0 && blocked.pose.x === currentPose.x && blocked.pose.z === currentPose.z,
    'fully blocked footprint stops cleanly without moving pose',
  );
}

// ── 6. Two-Wheeler Dynamics: Corner Lean, Brake Fork-Dive, Dismount Settle & Pedal Cadence vs Coasting ─────
{
  for (const bikeClass of ['bicycle', 'scooter', 'vesper', 'cafe_racer']) {
    const profile = VD.getTwoWheelerHandlingProfile(bikeClass);
    const st = VD.createTwoWheelerState();

    // Right turn (steer < 0) at cruise speed -> positive inward lean (leans right into turn)
    for (let i = 0; i < 45; i++) {
      VD.stepTwoWheelerDynamics({
        state: st, profile, driving: true, speed: profile.maxSpeed * 0.7,
        steer: -0.22, throttle: 1, brake: false, forwardAccel: 2.5, dt: 1 / 60,
      });
    }
    ok(st.lean > 0.08 && st.lean <= profile.maxLeanRad + 0.02, `${bikeClass}: right turn banks inward (lean=${st.lean.toFixed(3)} rad)`);
    ok(st.forkDive < -0.004, `${bikeClass}: powered/pedaled acceleration slightly unloads front fork (forkDive=${st.forkDive.toFixed(4)})`);

    if (!profile.powered) {
      ok(st.pedalCadence > 1.5 && !st.coasting && st.crankAngle > 0, 'bicycle pedals actively when throttle > 0');
      // Coasting at speed with throttle = 0 -> pedal cadence decays to 0!
      const crankBefore = st.crankAngle;
      for (let i = 0; i < 60; i++) {
        VD.stepTwoWheelerDynamics({
          state: st, profile, driving: true, speed: 5.0,
          steer: 0, throttle: 0, brake: false, forwardAccel: -0.3, dt: 1 / 60,
        });
      }
      ok(st.coasting && st.pedalCadence === 0, 'bicycle stops spinning pedals when coasting (throttle=0)');
      // Verify crank stays frozen once coasting has decayed
      const crankSettled = st.crankAngle;
      VD.stepTwoWheelerDynamics({
        state: st, profile, driving: true, speed: 5.0,
        steer: 0, throttle: 0, brake: false, forwardAccel: -0.3, dt: 1 / 60,
      });
      ok(st.crankAngle === crankSettled && crankBefore >= 0, 'coasting bicycle holds cranks level without phantom pedaling');
    } else {
      ok(st.pedalCadence === 0, `${bikeClass}: powered two-wheeler keeps pedalCadence at 0`);
    }

    // Hard braking -> positive fork dive
    for (let i = 0; i < 24; i++) {
      VD.stepTwoWheelerDynamics({
        state: st, profile, driving: true, speed: 5.0,
        steer: 0, throttle: 0, brake: true, forwardAccel: -profile.braking * 0.85, dt: 1 / 60,
      });
    }
    ok(st.forkDive > 0.015, `${bikeClass}: hard braking compresses front fork (forkDive=${st.forkDive.toFixed(4)})`);

    // Left turn -> negative inward lean
    for (let i = 0; i < 50; i++) {
      VD.stepTwoWheelerDynamics({
        state: st, profile, driving: true, speed: profile.maxSpeed * 0.65,
        steer: +0.24, throttle: 0.6, brake: false, forwardAccel: 0, dt: 1 / 60,
      });
    }
    ok(st.lean < -0.08, `${bikeClass}: left turn banks symmetrically inward left (lean=${st.lean.toFixed(3)} rad)`);

    // Dismount -> smoothly returns upright (lean=0, forkDive=0)
    for (let i = 0; i < 100; i++) {
      VD.stepTwoWheelerDynamics({
        state: st, profile, driving: false, speed: 0,
        steer: 0, throttle: 0, brake: false, forwardAccel: 0, dt: 1 / 60,
      });
    }
    ok(
      Math.abs(st.lean) < 0.001 && Math.abs(st.forkDive) < 0.001 && Number.isFinite(st.lean),
      `${bikeClass}: dismounting smoothly settles lean and fork dive to upright rest`,
    );
  }
}

// ── 7. Lighting & Horn State Machine + NPC Glance/Yield Reaction ───────────────────────────────────────────
{
  const lights = VD.createVehicleLightState('car');
  const brightNoon = { dayWeight: 0.95, rainWeight: 0 };
  const sunset = { dayWeight: 0.42, rainWeight: 0 };
  const rainyDay = { dayWeight: 0.88, rainWeight: 0.35 };
  const night = { dayWeight: 0.05, rainWeight: 0 };

  // Auto headlights: OFF at bright noon, ON at sunset, night, and rain
  VD.stepVehicleLights({
    lights, dt: 1 / 60, nowSeconds: 10, driving: true, speed: 8, throttle: 0.5,
    sideInput: 0, steer: 0, brake: false, env: brightNoon,
  });
  ok(!lights.headlightsOn && !lights.taillightsOn, 'auto headlights stay OFF in bright dry daylight');

  VD.stepVehicleLights({
    lights, dt: 1 / 60, nowSeconds: 10.1, driving: true, speed: 8, throttle: 0.5,
    sideInput: 0, steer: 0, brake: false, env: sunset,
  });
  ok(lights.headlightsOn && lights.taillightsOn, 'auto headlights + taillights turn ON at sunset');

  VD.stepVehicleLights({
    lights, dt: 1 / 60, nowSeconds: 10.2, driving: true, speed: 8, throttle: 0.5,
    sideInput: 0, steer: 0, brake: false, env: rainyDay,
  });
  ok(lights.headlightsOn, 'auto headlights turn ON in rain');

  // Manual L toggle: auto -> on -> off -> auto
  ok(VD.toggleHeadlightsMode(lights) === 'on', 'L toggle 1 switches auto -> on');
  VD.stepVehicleLights({
    lights, dt: 1 / 60, nowSeconds: 10.3, driving: true, speed: 8, throttle: 0.5,
    sideInput: 0, steer: 0, brake: false, env: brightNoon,
  });
  ok(lights.headlightsOn, 'manual ON forces headlights ON during bright noon');

  ok(VD.toggleHeadlightsMode(lights) === 'off', 'L toggle 2 switches on -> off');
  VD.stepVehicleLights({
    lights, dt: 1 / 60, nowSeconds: 10.4, driving: true, speed: 8, throttle: 0.5,
    sideInput: 0, steer: 0, brake: false, env: night,
  });
  ok(!lights.headlightsOn && !lights.taillightsOn, 'manual OFF keeps headlights OFF even at night');

  ok(VD.toggleHeadlightsMode(lights) === 'auto', 'L toggle 3 switches off -> auto');
  VD.stepVehicleLights({
    lights, dt: 1 / 60, nowSeconds: 10.5, driving: true, speed: 8, throttle: 0.5,
    sideInput: 0, steer: 0, brake: false, env: night,
  });
  ok(lights.headlightsOn, 'returning to auto immediately turns headlights ON at night');

  // Brake lights & Reverse white lights
  VD.stepVehicleLights({
    lights, dt: 1 / 60, nowSeconds: 11, driving: true, speed: 6, throttle: 0,
    sideInput: 0, steer: 0, brake: true, env: brightNoon,
  });
  ok(lights.braking && !lights.reversing, 'service brake illuminates red brake lights');

  VD.stepVehicleLights({
    lights, dt: 1 / 60, nowSeconds: 11.1, driving: true, speed: 6, throttle: -0.8,
    sideInput: 0, steer: 0, brake: false, env: brightNoon,
  });
  ok(lights.braking && !lights.reversing, 'opposing throttle while moving forward lights brake lamps');

  VD.stepVehicleLights({
    lights, dt: 1 / 60, nowSeconds: 11.2, driving: true, speed: -2.0, throttle: -0.6,
    sideInput: 0, steer: 0, brake: false, env: brightNoon,
  });
  ok(lights.reversing && !lights.braking, 'reversing illuminates white reverse lamps');

  // Auto blinkers & oscillation phase
  VD.stepVehicleLights({
    lights, dt: 0.05, nowSeconds: 12, driving: true, speed: 6, throttle: 0.4,
    sideInput: 0.8, steer: -0.25, brake: false, env: brightNoon,
  });
  ok(lights.blinker === 1 && lights.blinkerLit, 'sharp right turn auto-activates right blinker');
  VD.stepVehicleLights({
    lights, dt: 0.3, nowSeconds: 12.3, driving: true, speed: 6, throttle: 0.4,
    sideInput: 0.8, steer: -0.25, brake: false, env: brightNoon,
  });
  ok(lights.blinker === 1 && !lights.blinkerLit, 'blinker alternates off during second half of 1.8 Hz cycle');
  VD.stepVehicleLights({
    lights, dt: 0.05, nowSeconds: 12.35, driving: true, speed: 6, throttle: 0.4,
    sideInput: 0, steer: 0, brake: false, env: brightNoon,
  });
  ok(lights.blinker === 0 && !lights.blinkerLit, 'blinker auto-cancels when steering straightens');

  // Manual blinker toggle
  ok(VD.setManualBlinker(lights, -1) === -1 && lights.blinkerManual, 'manual left blinker engages');
  ok(VD.setManualBlinker(lights, -1) === 0 && !lights.blinkerManual, 'repeating manual blinker toggles it off');

  // Horn pulse, hold, timestamp & NPC glance/yield query
  const prevPulse = lights.hornPulseId;
  VD.stepVehicleLights({
    lights, dt: 1 / 60, nowSeconds: 20.0, driving: true, speed: 5, throttle: 0.3,
    sideInput: 0, steer: 0, brake: false, hornHeld: true, env: brightNoon,
  });
  ok(
    lights.hornActive && lights.hornPulseId === prevPulse + 1 && lights.lastHornAt === 20.0,
    'pressing H triggers horn pulse with fresh hornPulseId and timestamp',
  );
  // Holding H keeps horn active without spamming duplicate pulses
  VD.stepVehicleLights({
    lights, dt: 0.1, nowSeconds: 20.1, driving: true, speed: 5, throttle: 0.3,
    sideInput: 0, steer: 0, brake: false, hornHeld: true, env: brightNoon,
  });
  ok(lights.hornActive && lights.hornPulseId === prevPulse + 1, 'holding H sustains horn without duplicating pulse ID');
  // Release H -> decays cleanly after min duration
  for (let i = 0; i < 30; i++) {
    VD.stepVehicleLights({
      lights, dt: 1 / 60, nowSeconds: 20.2 + i / 60, driving: true, speed: 5, throttle: 0.3,
      sideInput: 0, steer: 0, brake: false, hornHeld: false, env: brightNoon,
    });
  }
  ok(!lights.hornActive && lights.hornTimer === 0, 'releasing H decays hornTimer cleanly to 0');

  // NPC reaction query: ahead/beside within 10 m and 2.2 s reacts and yields away from centerline
  const carPose = { x: 0, z: 0, yaw: 0 }; // facing +Z, left is +X
  const nearLeftNpc = VD.queryHornNpcReaction(carPose, { x: 2.0, z: 5.0 }, 20.8, lights.lastHornAt);
  ok(
    nearLeftNpc.alert && nearLeftNpc.lateralSide === 1 && nearLeftNpc.yieldOffset.x > 0.4,
    'nearby left-side NPC reacts to horn and steps outward (+X) from centerline',
  );
  const nearRightNpc = VD.queryHornNpcReaction(carPose, { x: -1.8, z: 4.5 }, 20.8, lights.lastHornAt);
  ok(
    nearRightNpc.alert && nearRightNpc.lateralSide === -1 && nearRightNpc.yieldOffset.x < -0.4,
    'nearby right-side NPC reacts to horn and steps outward (-X) from centerline',
  );
  const farNpc = VD.queryHornNpcReaction(carPose, { x: 0, z: 14.0 }, 20.8, lights.lastHornAt);
  ok(!farNpc.alert, 'NPC beyond 10 m horn range ignores horn');
  const behindNpc = VD.queryHornNpcReaction(carPose, { x: 0, z: -5.0 }, 20.8, lights.lastHornAt);
  ok(!behindNpc.alert, 'NPC far behind vehicle ignores horn');
  const expiredNpc = VD.queryHornNpcReaction(carPose, { x: 2.0, z: 5.0 }, 23.0, lights.lastHornAt);
  ok(!expiredNpc.alert, 'NPC reaction expires cleanly after 2.2 s window');
}

console.log(`echo-life vehicles 2.0: ${checks} checks passed`);
