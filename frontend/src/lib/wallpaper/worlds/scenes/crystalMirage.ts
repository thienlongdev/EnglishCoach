import * as THREE from 'three';
import type { WorldFactory } from '../types';
import { darkEase } from '../gl';
import { NOISE_3D, disposeScene, makeRenderer, mergeSimple, pointerOnPlane, rand } from './three-kit';

/**
 * Crystal Mirage. Faceted crystals in real 3D float over a pearl floor that mirrors them. Their material is a dedicated
 * shader: it refracts a procedural studio three times (once per colour channel, so edges split into rainbows), adds
 * thin-film iridescence and a fresnel rim. Each crystal is on a spring that tilts it toward the pointer, so highlights
 * really travel over the facets. Pearl and lavender by day, deep amethyst by night.
 */

const CRYSTAL_VS = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal2;
varying float vDepth;
void main() {
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal2 = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vec4 mv = viewMatrix * world;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const CRYSTAL_FS = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal2;
varying float vDepth;
uniform float uDark;
uniform float uTime;
uniform float uMirror;
uniform vec3 uCam;
vec3 studio(vec3 d) {
  float h = d.y * 0.5 + 0.5;
  vec3 night = mix(vec3(0.03, 0.02, 0.1), vec3(0.34, 0.24, 0.72), smoothstep(0.0, 1.0, h));
  vec3 day = mix(vec3(0.30, 0.26, 0.66), vec3(0.86, 0.78, 1.0), smoothstep(0.0, 1.0, h));
  vec3 c = mix(day, night, uDark);
  // long softboxes: this is what makes facets flash as they turn
  float a = atan(d.z, d.x);
  c += vec3(1.0, 0.98, 0.96) * smoothstep(0.26, 0.04, abs(sin(a * 1.5 + 0.6))) * smoothstep(0.1, 0.8, d.y) * mix(1.5, 2.3, uDark);
  c += vec3(0.5, 0.86, 1.0) * smoothstep(0.1, 0.0, abs(d.y - 0.24 + sin(a * 2.0) * 0.1)) * 0.8;
  c += vec3(1.0, 0.52, 0.84) * smoothstep(0.08, 0.0, abs(d.y + 0.22 + cos(a * 3.0) * 0.1)) * 0.6;
  return c;
}
vec3 film(float cosT) {
  // thin-film interference: colour depends on the angle
  vec3 phase = vec3(0.0, 0.33, 0.67) + 2.1 * cosT;
  return 0.5 + 0.5 * cos(6.28318 * phase);
}
void main() {
  vec3 n = normalize(vNormal2);
  vec3 v = normalize(uCam - vWorld);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 3.2);
  vec3 reflected = studio(reflect(-v, n));
  // dispersion: each channel bends by its own amount
  vec3 refr;
  refr.r = studio(refract(-v, n, 1.0 / 1.42)).r;
  refr.g = studio(refract(-v, n, 1.0 / 1.47)).g;
  refr.b = studio(refract(-v, n, 1.0 / 1.53)).b;
  // inner facets: a second bounce reads as glass thickness
  vec3 n2 = normalize(n + vec3(sin(vWorld.y * 3.1), cos(vWorld.x * 2.7), sin(vWorld.z * 3.9)) * 0.42);
  refr = mix(refr, studio(refract(-v, n2, 1.0 / 1.6)), 0.16);
  vec3 tint = mix(vec3(0.82, 0.8, 1.02), vec3(0.78, 0.66, 1.05), uDark);
  vec3 col = refr * tint;
  col = mix(col, reflected, clamp(fres * 1.6 + 0.04, 0.0, 1.0));
  col += film(ndv) * pow(1.0 - ndv, 1.6) * mix(0.3, 0.5, uDark);
  float fade = smoothstep(62.0, 22.0, vDepth);
  vec3 air = mix(vec3(0.86, 0.80, 0.94), vec3(0.06, 0.04, 0.16), uDark);
  col = mix(air, col, 0.45 + 0.55 * fade);
  // the mirror below the floor fades out with depth
  if (uMirror > 0.5) {
    float below = clamp(-vWorld.y / 7.0, 0.0, 1.0);
    col = mix(col, air, 0.54 + below * 0.44);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const FLOOR_VS = /* glsl */ `
varying vec3 vWorld;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const FLOOR_FS = /* glsl */ `
varying vec3 vWorld;
uniform float uDark;
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uMouse;
uniform float uStrength;
${NOISE_3D}
void main() {
  // The mirror image is drawn before this plane; the plane adds only a veil, caustics and a horizon.
  vec3 d = vWorld - uCam;
  float dist = length(d);
  vec2 p = vWorld.xz * 0.34;
  float w1 = n3(vec3(p * 1.6, uTime * 0.11));
  float w2 = n3(vec3(p * 3.4 + w1 * 2.0, -uTime * 0.09));
  float caustic = pow(1.0 - abs(w1 - w2) * 2.0, 8.0);
  vec3 tint = mix(vec3(0.95, 0.86, 0.95), vec3(0.09, 0.06, 0.22), uDark);
  vec3 lightCol = mix(vec3(0.74, 0.5, 0.92), vec3(0.52, 0.38, 1.0), uDark);
  vec3 prism = 0.5 + 0.5 * cos(6.28 * (vec3(0.0, 0.33, 0.67) + vWorld.x * 0.08 + w1));
  vec3 col = tint + (lightCol * 0.55 + prism * 0.35) * caustic * smoothstep(34.0, 8.0, dist) * mix(0.2, 0.36, uDark);
  float near = exp(-dot(vWorld.xz - uMouse.xz, vWorld.xz - uMouse.xz) * 0.08) * uStrength;
  col += lightCol * near * mix(0.04, 0.16, uDark);
  float alpha = mix(0.56, 0.62, uDark);
  float horizon = smoothstep(16.0, 46.0, dist);
  vec3 air = mix(vec3(0.97, 0.84, 0.90), vec3(0.06, 0.04, 0.16), uDark);
  col = mix(col, air, horizon);
  // the floor dissolves into the sky instead of meeting it at a line
  gl_FragColor = vec4(col, alpha * (1.0 - horizon));
  #include <colorspace_fragment>
}`;

const SKY_VS = /* glsl */ `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FS = /* glsl */ `
varying vec3 vDir;
uniform float uDark;
uniform float uTime;
${NOISE_3D}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y * 0.5 + 0.5;
  vec3 day = mix(vec3(0.97, 0.84, 0.90), vec3(0.62, 0.64, 0.96), smoothstep(0.42, 1.0, h));
  vec3 night = mix(vec3(0.06, 0.04, 0.16), vec3(0.015, 0.01, 0.06), smoothstep(0.42, 1.0, h));
  vec3 col = mix(day, night, uDark);
  // a great soft light behind the crystals
  float halo = exp(-length(vec2(d.x * 1.1 - 0.16, (d.y - 0.1) * 1.7)) * 2.6);
  col += mix(vec3(0.16, 0.12, 0.16), vec3(0.2, 0.1, 0.42), uDark) * halo;
  float soft = 0.5 + 0.5 * sin(d.x * 3.1 + uTime * 0.02) * sin(d.y * 4.3 - uTime * 0.016);
  col += mix(vec3(0.07, 0.03, 0.04), vec3(0.09, 0.03, 0.2), uDark) * soft;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

/** A natural-looking crystal: an elongated hexagonal prism with a faceted tip, slightly irregular. */
function makeCrystal(radius: number, height: number, sides: number, tilt: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const positions: number[] = [];
  const ring = (y: number, scale: number, skew: number) => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + 0.2;
      const r = radius * scale * (0.82 + ((i * 7) % 5) * 0.06);
      out.push(new THREE.Vector3(Math.cos(a) * r + skew, y, Math.sin(a) * r));
    }
    return out;
  };
  const bottom = ring(-height * 0.34, 0.86, 0);
  const shoulder = ring(height * 0.26, 1, tilt * 0.3);
  const tip = new THREE.Vector3(tilt, height * 0.56, 0);
  const foot = new THREE.Vector3(-tilt * 0.3, -height * 0.56, 0);
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    tri(bottom[i], shoulder[j], bottom[j]);
    tri(bottom[i], shoulder[i], shoulder[j]);
    tri(shoulder[i], tip, shoulder[j]);
    tri(bottom[j], foot, bottom[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  parts.push(g);
  return mergeSimple(parts);
}

interface Crystal { pos: THREE.Vector3; base: THREE.Euler; size: number; tiltX: number; tiltZ: number; vx: number; vz: number; phase: number; spin: number; geometry: number }

const factory: WorldFactory = (env) => {
  const renderer = makeRenderer(env);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, env.width / env.height, 0.1, 200);
  camera.position.set(0, 5.5, 26);

  const shared = {
    uDark: { value: env.params.dark ? 1 : 0 },
    uTime: { value: 0 },
    uCam: { value: camera.position },
    uMouse: { value: new THREE.Vector3() },
    uStrength: { value: 0 },
  };

  const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 24, 16), new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: shared, side: THREE.BackSide, depthWrite: false, toneMapped: false }));
  scene.add(sky);

  const shapes = [makeCrystal(1, 5.6, 6, 0.28), makeCrystal(1, 4, 5, -0.2), makeCrystal(1, 6.4, 7, 0.16)];
  const materials = (mirror: number) =>
    new THREE.ShaderMaterial({ vertexShader: CRYSTAL_VS, fragmentShader: CRYSTAL_FS, uniforms: { ...shared, uMirror: { value: mirror } }, side: mirror ? THREE.BackSide : THREE.FrontSide });

  // Hero crystals to the right and left; the middle of the screen stays open for the lessons.
  const spots: [number, number, number, number][] = [
    [9.5, 3.4, 0, 1.55], [13.6, 2.4, -3.6, 1.05], [6.2, 2.2, -4.4, 0.72], [11, 6.2, -5, 0.56],
    [-11.4, 3.2, -1, 1.28], [-15, 2.2, -5, 0.86], [-8, 5.4, -6, 0.5], [-18.5, 4.8, -9, 0.74],
    [17, 5, -9, 0.82], [3, 4.2, -11, 0.46], [-3.6, 2, -12, 0.4], [21, 2.6, -15, 0.9], [-23, 3, -15, 0.9],
  ];
  const extra = env.tier === 'high' ? 34 : env.tier === 'balanced' ? 20 : 8;
  for (let i = 0; i < extra; i++) {
    const side = i % 2 ? -1 : 1;
    spots.push([side * rand(5, 26), rand(1.4, 9), rand(-18, -2), rand(0.1, 0.28)]);
  }
  const crystals: Crystal[] = spots.map(([x, y, z, s], i) => ({
    pos: new THREE.Vector3(x, y, z),
    base: new THREE.Euler(rand(-0.3, 0.3), rand(0, 6.28), rand(-0.3, 0.3)),
    size: s,
    tiltX: 0,
    tiltZ: 0,
    vx: 0,
    vz: 0,
    phase: rand(0, 6.28),
    spin: rand(0.02, 0.09) * (i % 2 ? 1 : -1),
    geometry: i % shapes.length,
  }));

  const meshes: { mesh: THREE.InstancedMesh; mirror: THREE.InstancedMesh; list: Crystal[] }[] = shapes.map((geometry, g) => {
    const list = crystals.filter((c) => c.geometry === g);
    const mesh = new THREE.InstancedMesh(geometry, materials(0), list.length);
    const mirror = new THREE.InstancedMesh(geometry, materials(1), list.length);
    mesh.frustumCulled = false;
    mirror.frustumCulled = false;
    mirror.renderOrder = -2;
    scene.add(mirror);
    scene.add(mesh);
    return { mesh, mirror, list };
  });

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.ShaderMaterial({ vertexShader: FLOOR_VS, fragmentShader: FLOOR_FS, uniforms: shared, transparent: true, depthWrite: false, toneMapped: false }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.renderOrder = -1;
  scene.add(floor);

  // Small bubbles of light rising through the air.
  const bubbleCount = env.tier === 'low' ? 60 : 180;
  const bubblePos = new Float32Array(bubbleCount * 3);
  for (let i = 0; i < bubbleCount; i++) bubblePos.set([rand(-30, 30), rand(0, 16), rand(-20, 12)], i * 3);
  const bubbleGeo = new THREE.BufferGeometry();
  bubbleGeo.setAttribute('position', new THREE.BufferAttribute(bubblePos, 3));
  const bubbleMat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uPixel: { value: env.pixelRatio } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime; uniform float uPixel; varying float vA;
      void main() {
        vec3 p = position;
        float k = fract(position.x * 12.9 + position.z * 4.1);
        p.y = mod(p.y + uTime * (0.1 + k * 0.2), 16.0);
        p.x += sin(uTime * 0.3 + k * 30.0) * 0.5;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (2.0 + k * 7.0) * uPixel * 16.0 / -mv.z;
        vA = 0.1 + k * 0.45;
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; uniform float uDark;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.28, d) * smoothstep(0.1, 0.42, d) + smoothstep(0.2, 0.0, length(gl_PointCoord - vec2(0.36, 0.64))) * 0.8;
        vec3 c = mix(vec3(0.76, 0.72, 1.0), vec3(0.78, 0.7, 1.0), uDark);
        gl_FragColor = vec4(c * a * vA * mix(0.8, 1.2, uDark), 1.0);
      }`,
  });
  const bubbles = new THREE.Points(bubbleGeo, bubbleMat);
  bubbles.frustumCulled = false;
  scene.add(bubbles);

  const dummy = new THREE.Object3D();
  const mirrorDummy = new THREE.Object3D();
  const mouse = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  let dark = shared.uDark.value;

  return {
    frame(t, dt) {
      dark = darkEase(dark, env.params.dark, dt);
      shared.uDark.value = dark;
      shared.uTime.value = t;
      const p = env.pointer;
      shared.uStrength.value = p.strength;
      const cx = (p.su - 0.5) * 3.4 * p.strength + Math.sin(t * 0.05) * 1.2;
      const cy = 5.5 + (p.sv - 0.5) * 1.5 * p.strength;
      camera.position.x += (cx - camera.position.x) * Math.min(1, dt * 1.5);
      camera.position.y += (cy - camera.position.y) * Math.min(1, dt * 1.5);
      camera.lookAt(0, 3.2, -4);
      camera.updateMatrixWorld();
      pointerOnPlane(env, camera, 0, mouse);
      shared.uMouse.value.copy(mouse);
      for (const { mesh, mirror, list } of meshes) {
        list.forEach((c, i) => {
          // A spring: the crystal leans toward the pointer and settles when it leaves.
          const dx = mouse.x - c.pos.x;
          const dy = mouse.y - c.pos.y;
          const d = Math.hypot(dx, dy) + 1;
          const reach = Math.exp(-d * 0.1) * p.strength * (1 + p.energy * 1.4);
          const wantX = (dy / d) * reach * 0.8;
          const wantZ = (-dx / d) * reach * 0.8;
          c.vx += ((wantX - c.tiltX) * 22 - c.vx * 3.8) * dt;
          c.vz += ((wantZ - c.tiltZ) * 22 - c.vz * 3.8) * dt;
          c.tiltX += c.vx * dt;
          c.tiltZ += c.vz * dt;
          const bob = Math.sin(t * 0.42 + c.phase) * 0.26;
          dummy.position.copy(c.pos);
          dummy.position.y += bob + 0.7;
          dummy.rotation.copy(c.base);
          dummy.rotateY(t * c.spin);
          dummy.scale.setScalar(c.size);
          dummy.updateMatrix();
          axis.set(c.tiltX, 0, c.tiltZ);
          const amount = axis.length();
          if (amount > 1e-4) {
            quat.setFromAxisAngle(axis.normalize(), amount);
            dummy.quaternion.premultiply(quat);
            dummy.updateMatrix();
          }
          mesh.setMatrixAt(i, dummy.matrix);
          mirrorDummy.position.set(dummy.position.x, -dummy.position.y, dummy.position.z);
          mirrorDummy.quaternion.copy(dummy.quaternion);
          mirrorDummy.scale.set(c.size, -c.size, c.size);
          mirrorDummy.updateMatrix();
          mirror.setMatrixAt(i, mirrorDummy.matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        mirror.instanceMatrix.needsUpdate = true;
      }
      (bubbleMat.uniforms.uPixel as { value: number }).value = env.pixelRatio;
      renderer.render(scene, camera);
    },
    resize() {
      renderer.setSize(env.width, env.height, false);
      camera.aspect = env.width / env.height;
      camera.fov = camera.aspect < 1 ? 58 : 36;
      camera.updateProjectionMatrix();
    },
    dispose() {
      disposeScene(scene);
      renderer.dispose();
    },
    pixels: 0.85,
  };
};

export default factory;
