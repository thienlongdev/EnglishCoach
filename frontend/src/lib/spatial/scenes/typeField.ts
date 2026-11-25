import * as THREE from 'three';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_THREE_U, addSky, threeSpatial, withUniforms } from './kit';

/**
 * Category F, behind the content: letters in space, taken from the real headings of the current page. The heading effect itself is in engine/typography.ts; this is where the
 * same idea continues past the column. Six behaviours of one instanced glyph field:
 *  0 big letters turning with the pointer · 1 an ordered wall of letters that dents under the pointer · 2 a cloud that gathers into words · 3 lines of type on three planes that slide against each other and
 *  part around the pointer · 4 streams of letters flowing like a current that the pointer deflects · 5 falling columns whose letters change, faster and brighter near the pointer.
 *  A press blows the letters away from it in a travelling ring.
 */
const COLS = 12;
const ROWS = 6;
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZĂÂĐÊÔƠƯabdegkmnoqrstuvwxy0123456789&?!'.replace('&', '');

const VS = /* glsl */ `
attribute vec3 iPos; attribute float iGlyph; attribute float iSeed; attribute float iScale; attribute vec3 iHome;
${SPATIAL_THREE_U}
uniform float uKind;
uniform vec3 uPoint;
uniform float uGather;
uniform vec3 uPress;
varying vec2 vU; varying float vSeed; varying float vDepth; varying float vFade;
void main() {
  float k = uKind;
  vec3 c = iPos;
  float g = iGlyph;
  float s = iScale;
  vec3 local = position * s;
  float angle = 0.0;
  float fade = 1.0;
  if (k < 0.5) {
    // big letters that turn to the pointer
    angle = (uPoint.x - c.x) * 0.06 + sin(uTime * 0.2 + iSeed * 9.0) * 0.3;
    float ca = cos(angle), sa = sin(angle);
    local = vec3(ca * local.x + sa * local.z, local.y, -sa * local.x + ca * local.z);
  } else if (k < 1.5) {
    // an ordered wall: the dent shows only because everything else stands in line
    vec2 d = c.xy - uPoint.xy;
    float f = exp(-dot(d, d) * 0.1) * uStrength;
    c.xy += normalize(d + 1e-3) * f * (2.2 + uEnergy * 2.2);
    c.z -= f * 3.2;
    c.y += sin(uTime * 0.5 + c.x * 0.6) * 0.06;
    local.xy *= 1.0 + f * 0.4;
  } else if (k < 2.5) {
    // a cloud gathering into the page's words
    float e = smoothstep(0.0, 1.0, clamp(uGather * 1.6 - iSeed * 0.6, 0.0, 1.0));
    vec3 cloud = c + vec3(sin(uTime * 0.2 + iSeed * 30.0), cos(uTime * 0.17 + iSeed * 40.0), sin(uTime * 0.13 + iSeed * 50.0)) * 1.2;
    c = mix(cloud, iHome, e);
  } else if (k < 3.5) {
    // lines of type on three planes, sliding against each other; the pointer pulls the planes apart in depth
    float layer = mod(floor(iHome.y), 3.0);
    float dir = mod(floor(iHome.y), 2.0) < 0.5 ? 1.0 : -1.0;
    c.x = mod(c.x + dir * (uTime * (0.25 + layer * 0.1) + uScroll * 8.0) + 22.0, 44.0) - 22.0;
    vec2 d = c.xy - uPoint.xy;
    float f = exp(-dot(d, d) * 0.07) * uStrength;
    c.z = -2.0 - layer * (3.6 + f * 3.0);
    c.y += sign(d.y + 0.001) * f * 1.1;
  } else if (k < 4.5) {
    // streams along slow waves; a current that goes around the pointer
    float band = iHome.y;
    c.x = mod(c.x + uTime * (0.8 + mod(band, 3.0) * 0.25) + 22.0, 44.0) - 22.0;
    c.y = band + sin(c.x * 0.32 + uTime * 0.3 + band) * 1.1;
    vec2 d = c.xy - uPoint.xy;
    float f = exp(-dot(d, d) * 0.16) * uStrength;
    c.y += sign(d.y + 0.001) * f * (1.8 + uEnergy * 2.6);
    local.xy *= 0.8 + 0.25 * sin(c.x * 0.7 + band);
  } else {
    // falling columns; near the pointer the letters change faster and light up
    c.y = mod(c.y - uTime * (0.5 + iHome.y * 0.5) + 11.0, 22.0) - 11.0;
    vec2 d = c.xy - uPoint.xy;
    float f = exp(-dot(d, d) * 0.12) * uStrength;
    g = floor(mod(iGlyph + floor(uTime * (0.6 + iSeed + f * 12.0) + iSeed * 40.0), 60.0));
    fade = 1.0 + f * 1.8;
  }
  // a press blows everything outward in a ring
  if (uPress.z > 0.0) {
    vec2 d = c.xy - uPress.xy;
    float dist = length(d);
    float x = (dist - uPress.z * 13.0) / 1.8;
    c.xy += d / max(dist, 0.01) * exp(-x * x) * exp(-uPress.z * 1.4) * 2.4;
  }
  vec4 mv = viewMatrix * vec4(c + local, 1.0);
  float col = mod(g, ${COLS}.0);
  float row = floor(g / ${COLS}.0);
  vU = (vec2(col, row) + vec2(uv.x, 1.0 - uv.y)) / vec2(${COLS}.0, ${ROWS}.0);
  vU.y = 1.0 - vU.y;
  vSeed = iSeed;
  vDepth = clamp((-mv.z - 8.0) / 22.0, 0.0, 1.0);
  vFade = fade;
  gl_Position = projectionMatrix * mv;
}`;
const FS = /* glsl */ `
${SPATIAL_THREE_U}
uniform sampler2D uAtlas;
varying vec2 vU; varying float vSeed; varying float vDepth; varying float vFade;
void main() {
  float ink = texture2D(uAtlas, vU).a;
  if (ink < 0.06) discard;
  vec3 col = mix(uC2, uC3, vSeed);
  col = mix(col, uC1, vDepth * 0.72);
  col *= max(1.0, vFade * 0.8);
  gl_FragColor = vec4(col, min(1.0, ink * mix(0.82, 0.3, vDepth) * vFade));
}`;

function makeAtlas(): THREE.CanvasTexture {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = COLS * size;
  canvas.height = ROWS * size;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  ctx.font = `700 ${size * 0.72}px ${family}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  const chars = Array.from(GLYPHS);
  for (let i = 0; i < COLS * ROWS; i++) {
    const ch = chars[i % chars.length];
    ctx.fillText(ch, (i % COLS) * size + size / 2, Math.floor(i / COLS) * size + size / 2 + 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** Points of the current page's words laid out on a plane, for the gathering cloud. */
function wordHomes(words: string[], count: number): { pos: Float32Array; glyph: Float32Array } {
  const pos = new Float32Array(count * 3);
  const glyph = new Float32Array(count);
  const chars = Array.from(GLYPHS);
  const text = (words.length ? words : ['Echo', 'English', 'Coach']).join(' ');
  let x = -8;
  let y = 3.4;
  const letters = Array.from(text);
  for (let i = 0; i < count; i++) {
    const ch = letters[i % letters.length];
    if (ch === ' ' || x > 8) {
      x = -8;
      y -= 1.5;
      if (y < -4.5) y = 3.4;
      if (ch === ' ') continue;
    }
    pos.set([x, y, -2], i * 3);
    const at = chars.indexOf(ch);
    glyph[i] = at >= 0 ? at : chars.indexOf(ch.toUpperCase()) >= 0 ? chars.indexOf(ch.toUpperCase()) : i % chars.length;
    x += 0.88;
  }
  return { pos, glyph };
}

const make: SpatialSceneFactory = (env, bridge, opts, palette) =>
  threeSpatial(
    env,
    bridge,
    palette,
    (kit) => {
      addSky(kit);
      const kind = Number(opts.kind ?? 0);
      const atlas = makeAtlas();
      const count = kind === 0 ? 34 : kind === 2 ? 90 : env.tier === 'low' ? 110 : kind === 1 ? 300 : 240;
      const plane = new THREE.PlaneGeometry(1, 1);
      const g = new THREE.InstancedBufferGeometry();
      g.index = plane.index;
      g.setAttribute('position', plane.getAttribute('position'));
      g.setAttribute('uv', plane.getAttribute('uv'));
      const iPos = new Float32Array(count * 3);
      const iGlyph = new Float32Array(count);
      const iSeed = new Float32Array(count);
      const iScale = new Float32Array(count);
      const homes = wordHomes(bridge.words, count);
      for (let i = 0; i < count; i++) {
        iPos.set([(Math.random() - 0.5) * 30, (Math.random() - 0.5) * 18, -Math.random() * 14 - 1], i * 3);
        iGlyph[i] = homes.glyph[i] || Math.floor(Math.random() * 60);
        iSeed[i] = Math.random();
        iScale[i] = kind === 0 ? 2.2 + Math.random() * 3.2 : kind === 2 ? 1.5 : kind === 1 ? 0.95 : kind === 3 ? 1.5 : kind === 5 ? 0.85 : 0.7 + Math.random() * 1.4;
        // Each behaviour has its own composition, in `iPos`, and a per-letter number in `iHome.y` where it needs one.
        if (kind === 1) {
          const rows = Math.ceil(count / 25);
          iPos.set([((i % 25) - 12) * 1.25, (Math.floor(i / 25) - rows / 2) * 1.25, -3], i * 3);
        } else if (kind === 3) {
          const line = i % 11;
          iPos.set([(i * 2.7) % 44 - 22, (line - 5) * 1.75, -4], i * 3);
          homes.pos[i * 3 + 1] = line;
        } else if (kind === 4) {
          const band = (i % 7) * 2.6 - 7.8;
          iPos.set([(i * 3.1) % 44 - 22, band, -3 - (i % 3)], i * 3);
          homes.pos[i * 3 + 1] = band;
        } else if (kind === 5) {
          const column = i % 24;
          iPos.set([(column - 12) * 1.15, (Math.random() - 0.5) * 22, -3 - (column % 3) * 1.5], i * 3);
          homes.pos[i * 3 + 1] = Math.random();
        }
      }
      g.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
      g.setAttribute('iGlyph', new THREE.InstancedBufferAttribute(iGlyph, 1));
      g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(iSeed, 1));
      g.setAttribute('iScale', new THREE.InstancedBufferAttribute(iScale, 1));
      const homeAttr = new THREE.InstancedBufferAttribute(homes.pos, 3);
      g.setAttribute('iHome', homeAttr);
      g.instanceCount = count;
      const point = new THREE.Vector3();
      const press = new THREE.Vector3();
      const own = { uKind: { value: kind }, uPoint: { value: point }, uGather: { value: 0 }, uPress: { value: press }, uAtlas: { value: atlas } };
      const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: withUniforms(kit, own), transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      kit.scene.add(mesh);
      let seq = -1;
      let gather = 0;
      let wordsAt = '';
      return {
        update(_t, dt) {
          const p = env.pointer;
          point.set((p.su - 0.5) * 22, (p.sv - 0.5) * 13, 0);
          for (const pulse of p.drainPulses()) press.set((pulse.u - 0.5) * 22, (pulse.v - 0.5) * 13, 0.001);
          if (press.z > 0) press.z = press.z > 3 ? 0 : press.z + dt;
          if (kind === 2) {
            const key = bridge.words.join(' ');
            if (bridge.routeSeq !== seq || key !== wordsAt) {
              seq = bridge.routeSeq;
              wordsAt = key;
              gather = 0;
              const next = wordHomes(bridge.words, count);
              homeAttr.array.set(next.pos);
              homeAttr.needsUpdate = true;
              (g.getAttribute('iGlyph') as THREE.InstancedBufferAttribute).array.set(next.glyph);
              (g.getAttribute('iGlyph') as THREE.InstancedBufferAttribute).needsUpdate = true;
            }
            gather = Math.min(1, gather + dt * 0.45);
            own.uGather.value = gather;
          }
          kit.camera.position.y = -bridge.scrollProgress * 1.2;
          kit.camera.position.x = (p.su - 0.5) * 0.8 * p.strength;
          kit.camera.lookAt(0, -bridge.scrollProgress * 1.2, -4);
        },
        dispose: () => atlas.dispose(),
      };
    },
    { fov: 42, z: 15 },
  );
export default make;
