import * as THREE from 'three';
import type { WorldFactory } from '../types';
import { NOISE_3D, disposeScene, makeRenderer, mergeSimple, pointerOnPlane, rand } from './three-kit';

/**
 * Celestial Observatory. A golden armillary sphere in real 3D, ring within ring, each turning at its own rate with
 * engraved ticks; planets on their circles, a glass globe with its own constellations at the heart, and a nebula sky
 * with a deep star field. The pointer shifts the view and wakes the constellations near it: lines appear between real
 * stars of the scene and fade after it leaves. The instrument sits to one side, so the lessons keep the open sky.
 */

const SKY_VS = /* glsl */ `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FS = /* glsl */ `
varying vec3 vDir;
uniform float uTime;
${NOISE_3D}
void main() {
  vec3 d = normalize(vDir);
  vec3 q = d * 2.2;
  float a = fbm3d(q + vec3(0.0, 0.0, uTime * 0.004));
  float b = fbm3d(q * 1.8 + a * 2.2 + 4.0);
  float c = fbm3d(q * 3.4 + b * 1.6);
  vec3 col = vec3(0.006, 0.009, 0.03);
  col += vec3(0.05, 0.08, 0.26) * smoothstep(0.34, 0.72, a);
  col += vec3(0.22, 0.05, 0.26) * smoothstep(0.42, 0.8, b) * smoothstep(0.3, 0.7, a);
  col += vec3(0.42, 0.22, 0.09) * pow(smoothstep(0.5, 0.82, c), 2.0) * smoothstep(0.42, 0.72, b);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const STAR_VS = /* glsl */ `
attribute vec2 aData;
varying vec3 vColor;
varying float vBright;
uniform float uTime;
uniform float uPixel;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.6 + 0.4 * sin(uTime * (0.4 + aData.x * 1.6) + aData.x * 80.0);
  vBright = (0.25 + aData.y * 0.95) * tw;
  gl_PointSize = (1.2 + aData.y * aData.y * 5.0) * uPixel;
  vColor = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.68), step(0.7, aData.x));
}`;
const STAR_FS = /* glsl */ `
varying vec3 vColor;
varying float vBright;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor * a * a * vBright * 2.0, 1.0);
}`;

const GOLD_VS = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const GOLD_FS = /* glsl */ `
varying vec3 vN;
varying vec3 vW;
uniform vec3 uCam;
uniform vec3 uColor;
uniform float uTime;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(uCam - vW);
  vec3 r = reflect(-v, n);
  // A metal shows what surrounds it: a warm lit room above, a deep blue sky below, two long lights.
  float up = r.y * 0.5 + 0.5;
  vec3 env = mix(vec3(0.04, 0.05, 0.14), vec3(1.1, 0.82, 0.48), smoothstep(0.3, 0.92, up));
  env += vec3(1.8, 1.5, 1.05) * smoothstep(0.08, 0.0, abs(r.x - 0.46 + r.y * 0.3));
  env += vec3(0.8, 0.86, 1.3) * smoothstep(0.07, 0.0, abs(r.x + 0.62 - r.y * 0.2)) * 0.7;
  float fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 col = env * mix(uColor, vec3(1.0), fres);
  col += uColor * 0.05;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const GLOBE_VS = /* glsl */ `
varying vec3 vN;
varying vec3 vLocal;
varying vec3 vW;
void main() {
  vLocal = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const GLOBE_FS = /* glsl */ `
varying vec3 vN;
varying vec3 vLocal;
varying vec3 vW;
uniform vec3 uCam;
${NOISE_3D}
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(uCam - vW);
  float f = pow(1.0 - max(dot(n, v), 0.0), 2.4);
  vec3 p = normalize(vLocal);
  // engraved grid and tiny stars on a blue glass globe
  float lat = abs(fract(asin(p.y) * 3.82) - 0.5);
  float lon = abs(fract(atan(p.z, p.x) * 1.91) - 0.5);
  float grid = smoothstep(0.02, 0.0, min(lat, lon));
  vec3 cell = floor(p * 18.0);
  float star = step(0.9, n3hash(cell)) * smoothstep(0.35, 0.05, length(fract(p * 18.0) - 0.5));
  vec3 col = vec3(0.01, 0.05, 0.16) + vec3(0.03, 0.12, 0.36) * (0.4 + 0.6 * max(n.y, 0.0));
  col += vec3(0.82, 0.68, 0.38) * grid * 0.5;
  col += vec3(1.0, 0.94, 0.8) * star;
  col += vec3(0.4, 0.66, 1.0) * f * 1.2;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

function ringWithTicks(radius: number, thickness: number, ticks: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.TorusGeometry(radius, thickness, 12, 160));
  // A second, finer rail beside the main one gives the ring its engraved look.
  const rail = new THREE.TorusGeometry(radius - thickness * 2.3, thickness * 0.34, 8, 160);
  parts.push(rail);
  for (let i = 0; i < ticks; i++) {
    const a = (i / ticks) * Math.PI * 2;
    const major = i % 6 === 0;
    const len = major ? thickness * 3.2 : thickness * 1.7;
    const tick = new THREE.BoxGeometry(len, thickness * 0.4, thickness * 0.5);
    tick.translate(radius - thickness * 1.2 - len * 0.5 + len * 0.5, 0, 0);
    tick.rotateZ(a);
    parts.push(tick);
  }
  return mergeSimple(parts);
}

const factory: WorldFactory = (env) => {
  const renderer = makeRenderer(env);
  renderer.toneMappingExposure = 0.9;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, env.width / env.height, 0.1, 400);
  camera.position.set(0, 0, 34);

  const time = { value: 0 };
  const sky = new THREE.Mesh(new THREE.SphereGeometry(200, 32, 20), new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: { uTime: time }, side: THREE.BackSide, depthWrite: false, toneMapped: false }));
  scene.add(sky);

  // Stars.
  const starCount = env.tier === 'high' ? 7000 : env.tier === 'balanced' ? 4000 : 1800;
  const starPos = new Float32Array(starCount * 3);
  const starData = new Float32Array(starCount * 2);
  const vec = new THREE.Vector3();
  for (let i = 0; i < starCount; i++) {
    vec.randomDirection().multiplyScalar(rand(70, 180));
    starPos.set([vec.x, vec.y, vec.z], i * 3);
    starData[i * 2] = Math.random();
    starData[i * 2 + 1] = Math.pow(Math.random(), 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('aData', new THREE.BufferAttribute(starData, 2));
  const starUniforms = { uTime: time, uPixel: { value: env.pixelRatio } };
  const stars = new THREE.Points(starGeo, new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: starUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  stars.frustumCulled = false;
  scene.add(stars);

  // Constellation stars: a sparse set on a front-facing shell, so lines between them read as a chart in the sky.
  const chartCount = 120;
  const chart: THREE.Vector3[] = [];
  for (let i = 0; i < chartCount; i++) chart.push(new THREE.Vector3(rand(-58, 58), rand(-30, 30), rand(-46, -30)));
  const chartEnergy = new Float32Array(chartCount);
  const chartPoints = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints(chart),
    new THREE.PointsMaterial({ color: 0xfff1cf, size: 0.5, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }),
  );
  scene.add(chartPoints);
  const maxLines = 260;
  const linePos = new Float32Array(maxLines * 6);
  const lineCol = new Float32Array(maxLines * 6);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  lines.frustumCulled = false;
  scene.add(lines);

  // The instrument.
  const camU = { value: camera.position };
  const gold = (color: THREE.ColorRepresentation) => new THREE.ShaderMaterial({ vertexShader: GOLD_VS, fragmentShader: GOLD_FS, uniforms: { uCam: camU, uColor: { value: new THREE.Color(color) }, uTime: time } });
  const brass = gold(0xe2a948);
  const rose = gold(0xd89a64);
  const instrument = new THREE.Group();
  const narrow = () => env.width / env.height < 1;
  const place = () => {
    instrument.position.set(narrow() ? 0 : 11.5, narrow() ? 5 : 0.5, 0);
    instrument.scale.setScalar(narrow() ? 0.7 : 1);
  };
  place();
  scene.add(instrument);

  const ringSet: { mesh: THREE.Mesh; axis: THREE.Vector3; speed: number; holder: THREE.Group }[] = [];
  const addRing = (radius: number, thick: number, ticks: number, tiltX: number, tiltY: number, speed: number, material: THREE.Material, axis: THREE.Vector3) => {
    const holder = new THREE.Group();
    holder.rotation.set(tiltX, tiltY, 0);
    const mesh = new THREE.Mesh(ringWithTicks(radius, thick, ticks), material);
    holder.add(mesh);
    instrument.add(holder);
    ringSet.push({ mesh, axis, speed, holder });
  };
  const Y = new THREE.Vector3(0, 1, 0);
  const X = new THREE.Vector3(1, 0, 0);
  const Z = new THREE.Vector3(0, 0, 1);
  addRing(9.6, 0.16, 120, 0.12, -0.28, 0.024, brass, Y);
  addRing(8.5, 0.12, 72, Math.PI / 2 + 0.2, 0.3, -0.05, rose, Z);
  addRing(7.4, 0.11, 72, 1.0, 0.82, 0.075, brass, Y);
  addRing(6.3, 0.09, 48, -0.7, -0.6, -0.11, rose, X);
  addRing(5.1, 0.08, 48, 0.32, 1.32, 0.16, brass, Y);

  // Meridian stand behind the rings.
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 23, 10), brass);
  pole.rotation.z = 0.32;
  instrument.add(pole);
  const axisCap = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), brass);
  axisCap.position.set(-Math.sin(0.32) * 11.5, Math.cos(0.32) * 11.5, 0);
  instrument.add(axisCap);
  const axisCap2 = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), brass);
  axisCap2.position.set(Math.sin(0.32) * 11.5, -Math.cos(0.32) * 11.5, 0);
  instrument.add(axisCap2);

  const globe = new THREE.Mesh(new THREE.SphereGeometry(2.7, 48, 32), new THREE.ShaderMaterial({ vertexShader: GLOBE_VS, fragmentShader: GLOBE_FS, uniforms: { uCam: camU } }));
  globe.rotation.z = 0.32;
  instrument.add(globe);

  // Planets on the rings.
  const planetColors = [0xf2c27b, 0xe8805c, 0x8fc0ff, 0xd9c2ff];
  const planets = planetColors.map((color, i) => {
    const radius = [5.1, 6.3, 7.4, 8.5][i];
    const holder = new THREE.Group();
    holder.rotation.set(rand(-0.9, 0.9), rand(-0.6, 0.6), 0);
    const planet = new THREE.Mesh(new THREE.SphereGeometry(0.2 + i * 0.05, 18, 14), new THREE.MeshStandardMaterial({ color, roughness: 0.55, emissive: color, emissiveIntensity: 0.32 }));
    planet.position.x = radius;
    holder.add(planet);
    instrument.add(holder);
    return { holder, speed: 0.12 - i * 0.019 };
  });
  const sun = new THREE.PointLight(0xfff0d0, 90, 60, 1.6);
  sun.position.set(0, 2, 6);
  instrument.add(sun);
  scene.add(new THREE.AmbientLight(0x4a5a90, 0.55));

  const mouse = new THREE.Vector3();
  const mouseFar = new THREE.Vector3();
  let comet = -40;
  let cometSeed = 0.3;
  const cometGeo = new THREE.BufferGeometry();
  const cometPos = new Float32Array(24 * 3);
  const cometCol = new Float32Array(24 * 3);
  cometGeo.setAttribute('position', new THREE.BufferAttribute(cometPos, 3));
  cometGeo.setAttribute('color', new THREE.BufferAttribute(cometCol, 3));
  const cometLine = new THREE.Line(cometGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  cometLine.frustumCulled = false;
  scene.add(cometLine);

  return {
    frame(t, dt) {
      time.value = t;
      starUniforms.uPixel.value = env.pixelRatio;
      const p = env.pointer;
      // The view: a slow turn plus a restrained parallax with the pointer.
      const tx = (p.su - 0.5) * 5.2 * p.strength + Math.sin(t * 0.03) * 1.3;
      const ty = (p.sv - 0.5) * 3.2 * p.strength + Math.cos(t * 0.04) * 0.6;
      camera.position.x += (tx - camera.position.x) * Math.min(1, dt * 1.3);
      camera.position.y += (ty - camera.position.y) * Math.min(1, dt * 1.3);
      camera.lookAt(0, 0, -6);
      camera.updateMatrixWorld();
      stars.rotation.y = t * 0.0035;
      for (const ring of ringSet) ring.mesh.rotateOnAxis(ring.axis, dt * ring.speed);
      globe.rotateY(dt * 0.1);
      for (const planet of planets) planet.holder.rotateZ(dt * planet.speed);

      // Rings answer the pointer's proximity with a small extra turn.
      pointerOnPlane(env, camera, 0, mouse);
      const near = Math.exp(-mouse.distanceTo(instrument.position) * 0.12) * p.strength;
      for (const ring of ringSet) ring.mesh.rotateOnAxis(ring.axis, dt * ring.speed * near * 4 * (0.4 + p.energy * 3));

      // Constellations near the pointer.
      pointerOnPlane(env, camera, -38, mouseFar);
      let n = 0;
      for (let i = 0; i < chartCount; i++) {
        const d = Math.hypot(chart[i].x - mouseFar.x, chart[i].y - mouseFar.y);
        const want = p.strength > 0.01 && d < 26 ? (1 - d / 26) * p.strength : 0;
        chartEnergy[i] += (want - chartEnergy[i]) * Math.min(1, dt * (want > chartEnergy[i] ? 3.5 : 0.7));
      }
      for (let i = 0; i < chartCount && n < maxLines; i++) {
        if (chartEnergy[i] < 0.06) continue;
        for (let j = i + 1; j < chartCount && n < maxLines; j++) {
          if (chartEnergy[j] < 0.06) continue;
          const d = chart[i].distanceTo(chart[j]);
          if (d > 11) continue;
          const k = Math.min(chartEnergy[i], chartEnergy[j]) * (1 - d / 11) * 0.8;
          linePos.set([chart[i].x, chart[i].y, chart[i].z, chart[j].x, chart[j].y, chart[j].z], n * 6);
          lineCol.set([k, k * 0.86, k * 0.58, k, k * 0.86, k * 0.58], n * 6);
          n += 1;
        }
      }
      lineGeo.setDrawRange(0, n * 2);
      lineGeo.getAttribute('position').needsUpdate = true;
      lineGeo.getAttribute('color').needsUpdate = true;

      // A comet, now and then.
      comet += dt * 22;
      if (comet > 160) {
        comet = -rand(120, 300);
        cometSeed = Math.random();
      }
      const y0 = 14 + cometSeed * 16;
      for (let i = 0; i < 24; i++) {
        const back = comet - i * 0.9;
        cometPos.set([back - 70, y0 - back * 0.16, -30], i * 3);
        const f = comet > 0 ? 1 - i / 24 : 0;
        cometCol.set([f * f * 0.95, f * f, f * f], i * 3);
      }
      cometGeo.getAttribute('position').needsUpdate = true;
      cometGeo.getAttribute('color').needsUpdate = true;

      renderer.render(scene, camera);
    },
    resize() {
      renderer.setSize(env.width, env.height, false);
      camera.aspect = env.width / env.height;
      camera.fov = camera.aspect < 1 ? 62 : 40;
      camera.updateProjectionMatrix();
      place();
    },
    dispose() {
      disposeScene(scene);
      renderer.dispose();
    },
    pixels: 0.85,
  };
};

export default factory;
