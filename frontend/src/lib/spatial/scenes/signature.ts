import * as THREE from 'three';
import { ECHO_MODEL_URL } from '@/components/landing/ocean/echoAssets';
import { loadWhaleRig, type WhaleRig } from '@/components/landing/ocean/whaleRig';
import type { SpatialSceneFactory } from '../types';
import { NOISE_3, SPATIAL_THREE_U, addSky, rayFrom, raySphere, threeSpatial, withUniforms } from './kit';

/**
 * I08 Echo Immersive Signature. The flagship: the product's real whale, Echo (the same rigged model as the landing page), alive in deep water around the real cards. Three different things answer the learner:
 *  - ECHO is a creature, not a cursor follower. It cruises a slow route. A pointer that stays near and calm makes it curious: it turns, comes to a polite distance and hangs there, then loses interest and
 *    swims on. A fast pointer scares it off. A press on Echo makes it roll with a burst of bubbles; a press near it makes it dart away. A card under the pointer still calls it over.
 *  - The BUBBLES are bodies: they rise, wobble, get pushed aside by the pointer and carried along by its speed, part around Echo, and pop when pressed, with a ring and a small spray.
 *  - The WATER answers: the light shafts lean toward the pointer, a press sends a ring through the surface light, and marine snow swirls in the pointer's wake and in Echo's.
 */
const SKY_FS = /* glsl */ `varying vec2 vUv; ${SPATIAL_THREE_U}
uniform vec3 uRing[3];
${NOISE_3}
void main() {
  vec3 col = mix(uC0, uC1, smoothstep(-0.1, 1.15, vUv.y));
  float a = uCss.x / uCss.y;
  vec2 p = vec2((vUv.x - 0.5) * a, vUv.y);
  vec2 m = vec2((uMouse.x - 0.5) * a, uMouse.y);
  // the sun's shafts lean a little toward the pointer and gather around it
  float angle = atan(p.x - (m.x * 0.16) * uStrength, 1.5 - p.y);
  float rays = n3(vec3(angle * 11.0, uTime * 0.07, 1.0)) * n3(vec3(angle * 27.0, uTime * 0.05, 4.0));
  float near = exp(-dot(p - m, p - m) * 5.0) * uStrength;
  float beam = smoothstep(0.12, 0.46, rays) * smoothstep(-0.1, 1.0, vUv.y);
  col += mix(vec3(0.72, 1.0, 0.96), uC3, 0.5 * uDark) * beam * (mix(0.42, 0.38, uDark) + near * 0.32);
  // the surface far above; a press travels through its light
  vec2 sp = vec2(p.x * 4.0, p.y * 1.5 - uTime * 0.03);
  float ring = 0.0;
  for (int i = 0; i < 3; i++) {
    float age = uRing[i].z;
    if (age <= 0.0) continue;
    vec2 q = p - vec2((uRing[i].x - 0.5) * a, uRing[i].y);
    float d = length(q);
    float x = (d - age * 0.5) / (0.03 + age * 0.05);
    float w = exp(-x * x) * exp(-age * 1.6);
    ring += w;
    sp += normalize(q + 1e-4) * w * 0.5 * cos(x * 3.0);
  }
  float surface = fbm3(vec3(sp, uTime * 0.06));
  col += mix(uC3, vec3(1.0), 0.4) * smoothstep(0.46, 0.72, surface) * smoothstep(0.72, 1.05, vUv.y) * 0.34;
  col += mix(uC3, vec3(1.0), 0.5) * ring * 0.22;
  col += uC2 * near * 0.08;
  gl_FragColor = vec4(col, 1.0);
}`;
const SNOW_VS = /* glsl */ `
attribute float aSeed;
${SPATIAL_THREE_U}
uniform vec3 uPoint;
uniform vec3 uWhale;
uniform vec2 uWake;
uniform float uPx;
varying float vA;
void main() {
  vec3 p = position;
  p.y = mod(p.y - uTime * (0.08 + aSeed * 0.12) + 14.0, 28.0) - 14.0;
  p.x += sin(uTime * 0.2 + aSeed * 40.0) * 0.5;
  vec3 d = p - uPoint;
  float fall = exp(-dot(d.xy, d.xy) * 0.3) * uStrength;
  // pushed away by the pointer, and turned by how fast it moves: a current, not a bubble of nothing
  p.xy += normalize(d.xy + 0.001) * fall * (0.3 + uEnergy * 2.0) * 1.6;
  p.xy += vec2(-d.y, d.x) * fall * uEnergy * 0.9;
  vec3 e = p - uWhale;
  float wake = exp(-dot(e.xy, e.xy) * 0.09);
  p.xy += normalize(e.xy + 0.001) * wake * 1.1 + uWake * wake * 0.5;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (1.6 + aSeed * 5.0) * uPx * (13.0 / -mv.z);
  vA = (0.25 + aSeed * 0.5) * smoothstep(34.0, 12.0, -mv.z);
}`;
const SNOW_FS = /* glsl */ `
${SPATIAL_THREE_U}
varying float vA;
void main() {
  float a = smoothstep(0.5, 0.08, length(gl_PointCoord - 0.5)) * vA;
  gl_FragColor = vec4(mix(uC3, vec3(1.0), 0.5), a);
}`;
const BUBBLE_VS = /* glsl */ `
attribute vec3 iPos; attribute float iR; attribute float iSeed;
${SPATIAL_THREE_U}
varying vec3 vN; varying vec3 vW; varying float vSeed;
void main() {
  // the skin of a bubble is never quite round: a slow wobble in its radius
  float wob = 1.0 + 0.05 * sin(uTime * 2.1 + iSeed * 40.0 + position.y * 3.0);
  vec3 p = position * iR * wob + iPos;
  vN = normal; vW = p; vSeed = iSeed;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const BUBBLE_FS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec3 vN; varying vec3 vW; varying float vSeed;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float f = pow(1.0 - max(dot(n, v), 0.0), 2.4);
  vec3 film = 0.5 + 0.5 * cos(6.283 * (f * 1.8 + vSeed + vec3(0.0, 0.33, 0.67)));
  float spec = pow(max(dot(reflect(normalize(vec3(-0.4, 0.8, 0.5)) * -1.0, n), v), 0.0), 90.0);
  vec3 col = mix(uC3, film, 0.42) * f + vec3(1.0) * spec;
  gl_FragColor = vec4(col, clamp(f * 1.3 + spec, 0.0, 1.0));
}`;
const POP_VS = /* glsl */ `
attribute vec3 iPos; attribute float iAge; attribute float iR;
${SPATIAL_THREE_U}
varying vec2 vP; varying float vAge;
void main() {
  vP = position.xy * 2.0;
  vAge = iAge;
  float s = iR * (1.0 + iAge * 2.6);
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  mv.xy += position.xy * s * 2.0;
  gl_Position = projectionMatrix * mv;
}`;
const POP_FS = /* glsl */ `
${SPATIAL_THREE_U}
varying vec2 vP; varying float vAge;
void main() {
  if (vAge <= 0.0 || vAge >= 1.0) discard;
  float d = length(vP);
  float ring = smoothstep(0.06, 0.0, abs(d - 0.8)) * (1.0 - vAge);
  gl_FragColor = vec4(mix(uC3, vec3(1.0), 0.6), ring * 0.8);
}`;

const make: SpatialSceneFactory = (env, bridge, _o, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      const ringData = new Float32Array(9);
      const sky = addSky(kit, SKY_FS);
      (sky.material as THREE.ShaderMaterial).uniforms = withUniforms(kit, { uRing: { value: Array.from({ length: 3 }, () => new THREE.Vector3()) } });
      const ringUniform = (sky.material as THREE.ShaderMaterial).uniforms.uRing.value as THREE.Vector3[];
      let nextRing = 0;
      const scene = kit.scene;
      // Only Echo's own lit material reads these two; the custom shaders write their colours as they are.
      kit.renderer.outputColorSpace = THREE.SRGBColorSpace;
      kit.renderer.toneMapping = THREE.ACESFilmicToneMapping;

      // Marine snow
      const count = env.tier === 'low' ? 500 : 1400;
      const pos = new Float32Array(count * 3);
      const seed = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        pos.set([(Math.random() - 0.5) * 34, (Math.random() - 0.5) * 28, -Math.random() * 16 + 3], i * 3);
        seed[i] = Math.random();
      }
      const snowGeo = new THREE.BufferGeometry();
      snowGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      snowGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
      const point = new THREE.Vector3();
      const whaleAt = new THREE.Vector3(-9, 3, -3);
      const wake = new THREE.Vector2();
      const snow = new THREE.Points(snowGeo, new THREE.ShaderMaterial({ vertexShader: SNOW_VS, fragmentShader: SNOW_FS, uniforms: withUniforms(kit, { uPoint: { value: point }, uWhale: { value: whaleAt }, uWake: { value: wake }, uPx: { value: env.pixelRatio || 1 } }), transparent: true, depthWrite: false, toneMapped: false }));
      snow.frustumCulled = false;
      scene.add(snow);

      // Bubbles: bodies with a position and a velocity on the CPU, one instanced draw.
      const bubbleCount = env.tier === 'low' ? 34 : env.tier === 'balanced' ? 70 : 110;
      const sprayCount = 28;
      const total = bubbleCount + sprayCount;
      const sphere = new THREE.IcosahedronGeometry(1, env.tier === 'low' ? 2 : 3);
      const bubbles = new THREE.InstancedBufferGeometry();
      bubbles.index = sphere.index;
      bubbles.setAttribute('position', sphere.getAttribute('position'));
      bubbles.setAttribute('normal', sphere.getAttribute('normal'));
      const bPos = new Float32Array(total * 3);
      const bVel = new Float32Array(total * 3);
      const bR = new Float32Array(total);
      const bHome = new Float32Array(total);
      const bSeed = new Float32Array(total);
      const bLife = new Float32Array(total);
      const span = { x: 20, y: 11 };
      const spawn = (i: number, atBottom: boolean) => {
        bPos[i * 3] = (Math.random() - 0.5) * span.x * 2;
        bPos[i * 3 + 1] = atBottom ? -span.y - Math.random() * 3 : (Math.random() - 0.5) * span.y * 2;
        bPos[i * 3 + 2] = -Math.random() * 9 - 0.5;
        bVel[i * 3] = bVel[i * 3 + 1] = bVel[i * 3 + 2] = 0;
        bHome[i] = 0.07 + Math.random() * Math.random() * 0.62;
        bR[i] = bHome[i];
        bSeed[i] = Math.random();
      };
      for (let i = 0; i < bubbleCount; i++) spawn(i, false);
      const iPos = new THREE.InstancedBufferAttribute(bPos, 3).setUsage(THREE.DynamicDrawUsage);
      const iR = new THREE.InstancedBufferAttribute(bR, 1).setUsage(THREE.DynamicDrawUsage);
      bubbles.setAttribute('iPos', iPos);
      bubbles.setAttribute('iR', iR);
      bubbles.setAttribute('iSeed', new THREE.InstancedBufferAttribute(bSeed, 1));
      bubbles.instanceCount = total;
      const bubbleMesh = new THREE.Mesh(bubbles, new THREE.ShaderMaterial({ vertexShader: BUBBLE_VS, fragmentShader: BUBBLE_FS, uniforms: withUniforms(kit), transparent: true, depthWrite: false, toneMapped: false }));
      bubbleMesh.frustumCulled = false;
      scene.add(bubbleMesh);

      // The ring a popped bubble leaves.
      const popCount = 14;
      const popGeo = new THREE.InstancedBufferGeometry();
      const quad = new THREE.PlaneGeometry(1, 1);
      popGeo.index = quad.index;
      popGeo.setAttribute('position', quad.getAttribute('position'));
      const pPos = new Float32Array(popCount * 3);
      const pAge = new Float32Array(popCount).fill(1);
      const pR = new Float32Array(popCount);
      const iPopPos = new THREE.InstancedBufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage);
      const iPopAge = new THREE.InstancedBufferAttribute(pAge, 1).setUsage(THREE.DynamicDrawUsage);
      const iPopR = new THREE.InstancedBufferAttribute(pR, 1).setUsage(THREE.DynamicDrawUsage);
      popGeo.setAttribute('iPos', iPopPos);
      popGeo.setAttribute('iAge', iPopAge);
      popGeo.setAttribute('iR', iPopR);
      popGeo.instanceCount = popCount;
      const popMesh = new THREE.Mesh(popGeo, new THREE.ShaderMaterial({ vertexShader: POP_VS, fragmentShader: POP_FS, uniforms: withUniforms(kit), transparent: true, depthWrite: false, toneMapped: false }));
      popMesh.frustumCulled = false;
      scene.add(popMesh);
      let nextPop = 0;
      let nextSpray = bubbleCount;

      const probe = { pops: 0, pushed: 0, whaleState: 0, whaleDist: 0, whaleRolls: 0, rings: 0, curiosity: 0 };
      bridge.probe = probe;

      const pop = (i: number) => {
        probe.pops += 1;
        pPos.set([bPos[i * 3], bPos[i * 3 + 1], bPos[i * 3 + 2]], nextPop * 3);
        pAge[nextPop] = 0.001;
        pR[nextPop] = bR[i];
        nextPop = (nextPop + 1) % popCount;
        // a small spray of droplets that flies out and is gone
        for (let k = 0; k < 4; k++) {
          const s = nextSpray;
          nextSpray = nextSpray + 1 >= total ? bubbleCount : nextSpray + 1;
          const angle = Math.random() * Math.PI * 2;
          bPos.set([bPos[i * 3], bPos[i * 3 + 1], bPos[i * 3 + 2]], s * 3);
          bVel.set([Math.cos(angle) * (1.4 + Math.random() * 2), Math.sin(angle) * (1.4 + Math.random() * 2) + 0.6, 0], s * 3);
          bR[s] = 0.035 + Math.random() * 0.05;
          bLife[s] = 0.55 + Math.random() * 0.35;
          bSeed[s] = Math.random();
        }
        spawn(i, true);
      };

      // Echo
      scene.add(new THREE.AmbientLight(0xffffff, 1.1));
      const sun = new THREE.DirectionalLight(0xffffff, 2.4);
      sun.position.set(-4, 9, 5);
      scene.add(sun);
      const abort = new AbortController();
      let rig: WhaleRig | null = null;
      const place = whaleAt;
      const velocity = new THREE.Vector3(1, 0, 0);
      const target = new THREE.Vector3();
      const hover = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      const look = new THREE.Matrix4();
      const quat = new THREE.Quaternion();
      const roll = new THREE.Quaternion();
      const forward = new THREE.Vector3(0, 0, 1);
      const zero = new THREE.Vector3(0, 0, 0);
      const dir = new THREE.Vector3();
      const origin = new THREE.Vector3();
      const raydir = new THREE.Vector3();
      const hit = new THREE.Vector3();
      const prevHit = new THREE.Vector3();
      const flee = new THREE.Vector3();
      const heading = new THREE.Vector3(1, 0, 0);
      const toPointer = new THREE.Vector3();
      void loadWhaleRig(ECHO_MODEL_URL, abort.signal)
        .then((loaded) => {
          if (abort.signal.aborted) {
            loaded.dispose();
            return;
          }
          rig = loaded;
          rig.root.scale.setScalar(4.4);
          rig.root.position.copy(place);
          scene.add(rig.root);
        })
        .catch(() => {
          // The water stays without Echo: the model is decoration, never a dependency.
        });
      let surprise = 0;
      let curious = 0;
      let bored = 0;
      let fleeing = 0;
      let rollLeft = 0;
      let bank = 0;
      let lastYaw = 0;
      const planeZ = -2.5;
      const bodyHits = (ox: THREE.Vector3, d: THREE.Vector3) => {
        // Echo's body as three spheres along its heading: good enough to answer "did you touch it".
        for (const k of [-1.7, 0, 1.7]) {
          if (raySphere(ox, d, place.x + heading.x * k, place.y + heading.y * k, place.z + heading.z * k, k === 0 ? 1.7 : 1.25) > 0) return true;
        }
        return false;
      };
      const halfH = () => Math.tan((kit.camera.fov * Math.PI) / 360) * (kit.camera.position.z + 3);
      return {
        update(t, rawDt) {
          const dt = Math.min(rawDt, 1 / 20);
          const p = env.pointer;
          kit.camera.position.x = (p.su - 0.5) * 0.9 * p.strength;
          kit.camera.position.y = (p.sv - 0.5) * 0.5 * p.strength - bridge.scrollProgress * 1.2;
          kit.camera.lookAt(0, -bridge.scrollProgress * 1.2, -3);
          kit.camera.updateMatrixWorld();
          // The pointer in the water, at the depth where things live.
          rayFrom(kit, p.u, p.v, origin, raydir);
          const toPlane = (planeZ - origin.z) / raydir.z;
          prevHit.copy(hit);
          hit.copy(origin).addScaledVector(raydir, toPlane);
          point.copy(hit);
          const speed = dt > 0 ? Math.min(prevHit.distanceTo(hit) / dt, 40) : 0;
          const moveX = dt > 0 ? (hit.x - prevHit.x) / dt : 0;
          const moveY = dt > 0 ? (hit.y - prevHit.y) / dt : 0;
          const reach = p.strength > 0.01;

          // Presses: a bubble under it pops; Echo under it rolls; Echo nearby darts away; always a ring through the water's light.
          for (const pulse of p.drainPulses()) {
            rayFrom(kit, pulse.u, pulse.v, origin, raydir);
            const pt = (planeZ - origin.z) / raydir.z;
            const px = origin.x + raydir.x * pt;
            const py = origin.y + raydir.y * pt;
            ringData.set([pulse.u, pulse.v, 0.001], nextRing * 3);
            nextRing = (nextRing + 1) % 3;
            probe.rings += 1;
            for (let i = 0; i < bubbleCount; i++) {
              const dx = bPos[i * 3] - px;
              const dy = bPos[i * 3 + 1] - py;
              const d = Math.hypot(dx, dy);
              if (d < bR[i] + 0.9) pop(i);
              else if (d < 5) {
                const f = (1 - d / 5) * 7;
                bVel[i * 3] += (dx / d) * f;
                bVel[i * 3 + 1] += (dy / d) * f;
              }
            }
            if (rig && bodyHits(origin, raydir)) {
              rollLeft = Math.PI * 2;
              surprise = 1;
              probe.whaleRolls += 1;
              curious = 0;
              bored = 6;
              // a burst from the blowhole
              for (let k = 0; k < 8; k++) {
                const i = Math.floor(Math.random() * bubbleCount);
                bPos.set([place.x + heading.x * 1.6 + (Math.random() - 0.5), place.y + 0.8, place.z + (Math.random() - 0.5)], i * 3);
                bVel.set([(Math.random() - 0.5) * 3, 2.5 + Math.random() * 3, 0], i * 3);
              }
            } else if (Math.hypot(place.x - px, place.y - py) < 7) {
              fleeing = 1.7;
              surprise = Math.max(surprise, 0.7);
              flee.set(place.x - px, place.y - py, 0).normalize();
              bored = 5;
              curious = 0;
            }
          }
          surprise = Math.max(0, surprise - dt * 0.6);
          fleeing = Math.max(0, fleeing - dt);
          for (let i = 0; i < 3; i++) {
            const age = ringData[i * 3 + 2];
            if (age > 0) ringData[i * 3 + 2] = age > 3.2 ? 0 : age + dt;
            ringUniform[i].set(ringData[i * 3], ringData[i * 3 + 1], ringData[i * 3 + 2]);
          }

          // Bubbles.
          const reachR = 3.4;
          const whaleR = 3.2;
          for (let i = 0; i < total; i++) {
            const spray = i >= bubbleCount;
            if (spray) {
              if (bLife[i] <= 0) {
                bR[i] = 0;
                continue;
              }
              bLife[i] -= dt;
              if (bLife[i] <= 0) bR[i] = 0;
            }
            const x = bPos[i * 3];
            const y = bPos[i * 3 + 1];
            let vx = bVel[i * 3];
            let vy = bVel[i * 3 + 1];
            if (!spray) {
              // buoyancy: small bubbles rise slower; each drifts on its own wobble
              const rise = 0.42 + bHome[i] * 0.9;
              vy += (rise - vy) * Math.min(1, dt * 1.4);
              vx += Math.sin(t * (1.1 + bSeed[i]) + bSeed[i] * 30) * 0.45 * dt;
              if (reach) {
                const dx = x - hit.x;
                const dy = y - hit.y;
                const d = Math.hypot(dx, dy) + 1e-3;
                if (d < reachR + bHome[i]) {
                  const fall = (1 - d / (reachR + bHome[i])) ** 2;
                  const push = (3.4 + speed * 0.5) * fall * p.strength;
                  vx += (dx / d) * push * dt * 10;
                  vy += (dy / d) * push * dt * 10;
                  // what the pointer moves through it carries along
                  vx += moveX * fall * dt * 2.2;
                  vy += moveY * fall * dt * 2.2;
                  probe.pushed += fall > 0.2 ? 1 : 0;
                  // run a fast pointer straight into a bubble and it bursts
                  if (speed > 16 && d < bHome[i] + 0.25) {
                    pop(i);
                    continue;
                  }
                }
              }
              if (rig) {
                const wx = x - place.x;
                const wy = y - place.y;
                const wd = Math.hypot(wx, wy) + 1e-3;
                if (wd < whaleR) {
                  const fall = (1 - wd / whaleR) ** 2;
                  vx += (wx / wd) * fall * 22 * dt + velocity.x * fall * dt * 1.2;
                  vy += (wy / wd) * fall * 22 * dt + velocity.y * fall * dt * 1.2;
                }
              }
              vx *= Math.exp(-dt * 1.3);
              const top = span.y + 3 + kit.camera.position.y;
              if (y > top || Math.abs(x) > span.x + 4) {
                spawn(i, true);
                continue;
              }
            } else {
              vx *= Math.exp(-dt * 3);
              vy = vy * Math.exp(-dt * 3) + dt * 0.6;
            }
            bVel[i * 3] = vx;
            bVel[i * 3 + 1] = vy;
            bPos[i * 3] = x + vx * dt;
            bPos[i * 3 + 1] = y + vy * dt;
          }
          iPos.needsUpdate = true;
          iR.needsUpdate = true;
          for (let i = 0; i < popCount; i++) if (pAge[i] > 0 && pAge[i] < 1) pAge[i] = Math.min(1, pAge[i] + dt * 2.1);
          iPopPos.needsUpdate = true;
          iPopAge.needsUpdate = true;
          iPopR.needsUpdate = true;

          if (!rig) return;
          const h = halfH();
          const w = h * kit.camera.aspect;
          // Cruise: a long lazy loop through the water around the page.
          const a = t * 0.075;
          target.set(Math.sin(a) * w * 0.86, Math.sin(a * 2.0 + 0.8) * h * 0.72 - bridge.scrollProgress * 1.2, -3 + Math.cos(a * 1.3) * 1.5);
          let state = 0;
          toPointer.copy(hit).sub(place);
          const pointerDist = toPointer.length();
          probe.whaleDist = pointerDist;
          // Curiosity needs a pointer that is near and calm, and it runs out: Echo is not a pet on a string.
          bored = Math.max(0, bored - dt);
          const calmNear = reach && pointerDist < 11 && speed < 12;
          if (calmNear && bored <= 0) {
            curious = Math.min(1, curious + dt * 0.55);
            probe.curiosity += dt;
          } else {
            curious = Math.max(0, curious - dt * 0.8);
          }
          if (probe.curiosity > 7) {
            probe.curiosity = 0;
            bored = 9;
          }
          if (curious > 0.25) {
            state = 1;
            hover.copy(hit).addScaledVector(toPointer.normalize(), -5.2);
            hover.z = -3;
            target.lerp(hover, Math.min(1, curious * 1.2));
          } else if (bridge.hoverAmount > 0.25) {
            const hx = (bridge.hoverX / Math.max(1, env.cssWidth) - 0.5) * 2 * w;
            const hy = -(bridge.hoverY / Math.max(1, env.cssHeight) - 0.5) * 2 * h - bridge.scrollProgress * 1.2;
            target.lerp(hover.set(hx + (hx > 0 ? -1 : 1) * w * 0.34, hy + Math.sin(t * 0.7) * 0.4, -2.2), bridge.hoverAmount * 0.8);
          }
          // A fast pointer close by: Echo keeps away from it.
          if (reach && speed > 22 && pointerDist < 6 && fleeing <= 0) {
            fleeing = 0.9;
            flee.copy(place).sub(hit).setZ(0).normalize();
          }
          if (fleeing > 0) {
            state = 2;
            target.copy(place).addScaledVector(flee, 12);
          }
          probe.whaleState = state;
          const desired = dir.copy(target).sub(place);
          const distance = desired.length();
          const cruise = (state === 1 ? Math.min(distance * 0.9, 3) + 0.25 : 1.6 + Math.min(distance * 0.42, 4.2)) + surprise * 3 + (state === 2 ? 6 : 0);
          desired.normalize().multiplyScalar(cruise);
          velocity.lerp(desired, Math.min(1, dt * (state === 2 ? 2.6 : 0.9)));
          place.addScaledVector(velocity, dt);
          rig.root.position.copy(place);
          const swim = velocity.length();
          // Keep turning toward where it looks: when curious, at the pointer rather than along its path.
          if (state === 1 && swim < 1.4) dir.copy(hit).sub(place).normalize();
          else if (swim > 0.02) dir.copy(velocity).normalize();
          heading.lerp(dir, Math.min(1, dt * 1.8)).normalize();
          look.lookAt(heading, zero, up);
          quat.setFromRotationMatrix(look);
          // Bank into a turn; a roll when touched.
          const yaw = Math.atan2(heading.x, heading.z);
          let yawRate = dt > 0 ? (yaw - lastYaw) / dt : 0;
          if (Math.abs(yawRate) > 20) yawRate = 0;
          lastYaw = yaw;
          bank += (Math.max(-0.5, Math.min(0.5, -yawRate * 0.5)) - bank) * Math.min(1, dt * 2.5);
          if (rollLeft > 0) {
            const stepRoll = Math.min(rollLeft, dt * 4.6);
            rollLeft -= stepRoll;
          }
          roll.setFromAxisAngle(forward, bank + rollLeft);
          quat.multiply(roll);
          rig.root.quaternion.slerp(quat, Math.min(1, dt * (rollLeft > 0 ? 9 : 2.2)));
          wake.set(velocity.x, velocity.y);
          rig.setWaterLight(t, 0.7);
          rig.update(dt, swim * 0.28 + (state === 1 ? 0.06 : 0), surprise);
        },
        dispose() {
          abort.abort();
          rig?.dispose();
          rig = null;
          quad.dispose();
          sphere.dispose();
        },
      };
    },
    { fov: 42, z: 14 },
  );
export default make;
