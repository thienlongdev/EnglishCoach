import * as THREE from 'three';

/**
 * Life in Echo's ocean besides Echo: a distant school of small fish that scatters when the whale swims close and
 * regroups, and a few luminous jellyfish drifting at the edges of the page with depth parallax.
 *
 * Everything is placed in SCREEN space (CSS px + an apparent size) and converted to the 3D water by the engine's
 * `toWorld`, exactly like Echo, so the life stays at the page edges on every screen. Fins, tails and bells move on
 * the GPU; the CPU only steers ~60 fish and 5 jellyfish per frame.
 */
export type ToWorld = (x: number, y: number, sizePx: number, out: THREE.Vector3) => THREE.Vector3;

export interface SeaLifeFrame {
  dt: number;
  time: number;
  vw: number;
  vh: number;
  scrollY: number;
  /** Echo on screen (CSS px) and its apparent length; size 0 = absent. */
  whaleX: number;
  whaleY: number;
  whaleSize: number;
  still: boolean;
}

export interface SeaLife {
  group: THREE.Group;
  update(frame: SeaLifeFrame): void;
  dispose(): void;
}

// ── Fish ──
const FISH_VERTEX = /* glsl */ `
  attribute float aPhase;
  uniform float uTime;
  varying float vShade;
  void main() {
    vec3 p = position;
    // Tail and rear body swing; the head stays steady.
    float rear = clamp(-p.z * 2.0, 0.0, 1.0);
    p.x += sin(uTime * 11.0 + aPhase * 6.2831) * 0.22 * rear * rear;
    vShade = clamp(p.y * 3.0 + 0.5, 0.0, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
  }
`;
const FISH_FRAGMENT = /* glsl */ `
  varying float vShade;
  uniform float uOpacity;
  void main() {
    // Dark silhouettes against the bright water, with a faint lit back.
    vec3 belly = vec3(0.02, 0.08, 0.2);
    vec3 back = vec3(0.1, 0.3, 0.55);
    gl_FragColor = vec4(mix(belly, back, vShade), 0.85 * uOpacity);
  }
`;

function fishGeometry() {
  // A slim fish, head along +Z, length 1: body diamond + forked tail, flat (seen mostly side-on at a distance).
  const v = [
    // body (upper / lower halves)
    0, 0, 0.5, 0, 0.16, 0.05, 0, 0, -0.32,
    0, 0, 0.5, 0, 0, -0.32, 0, -0.12, 0.05,
    // tail
    0, 0, -0.28, 0, 0.17, -0.52, 0, 0.02, -0.4,
    0, 0, -0.28, 0, -0.02, -0.4, 0, -0.15, -0.5,
  ];
  // Give the flat fish a little thickness so it never vanishes edge-on.
  const thick: number[] = [];
  for (let i = 0; i < v.length; i += 9) {
    const tri = v.slice(i, i + 9);
    thick.push(...tri);
    const rotated = tri.slice();
    for (let k = 0; k < 9; k += 3) {
      rotated[k] = tri[k + 1] * 0.6;
      rotated[k + 1] = tri[k + 1] * 0.6;
    }
    thick.push(...rotated);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(thick, 3));
  return geometry;
}

// ── Jellyfish ──
const BELL_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;
  varying float vRim;
  varying float vHeight;
  void main() {
    vec3 p = position;
    float pulse = sin(uTime * 1.7 + uPhase);
    float lower = 1.0 - clamp(p.y / 0.5, 0.0, 1.0);
    p.xz *= 1.0 + pulse * 0.13 * lower;
    p.y *= 1.0 - pulse * 0.08;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vRim = 1.0 - abs(dot(n, normalize(-mv.xyz)));
    vHeight = p.y;
    gl_Position = projectionMatrix * mv;
  }
`;
const BELL_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vRim;
  varying float vHeight;
  void main() {
    float rim = pow(vRim, 1.6);
    // Translucent bell: a bright rim, a faint inner veil, a soft cap glow.
    float inner = 0.08 + 0.2 * smoothstep(0.1, 0.5, vHeight);
    vec3 c = uColor * (inner + rim * 1.15);
    gl_FragColor = vec4(c * uOpacity * 0.75, 0.0);
  }
`;
const TENTACLE_VERTEX = /* glsl */ `
  attribute float aAlong;
  attribute float aStrand;
  uniform float uTime;
  uniform float uPhase;
  varying float vAlong;
  void main() {
    float a = aStrand * 2.399 + uPhase;
    float r = 0.16 + 0.12 * fract(aStrand * 0.37);
    float len = 0.9 + 0.7 * fract(aStrand * 0.61);
    float sway = sin(uTime * 1.3 - aAlong * 5.0 + uPhase + aStrand) * 0.16 * aAlong;
    vec3 p = vec3(cos(a) * r * (1.0 - aAlong * 0.4) + sway, -aAlong * len, sin(a) * r * (1.0 - aAlong * 0.4) + sway * 0.5);
    vAlong = aAlong;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const TENTACLE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlong;
  void main() {
    gl_FragColor = vec4(uColor * (1.0 - vAlong) * 0.55 * uOpacity, 0.0);
  }
`;

interface Jelly {
  root: THREE.Group;
  bellUniforms: { uTime: { value: number }; uPhase: { value: number }; uColor: { value: THREE.Color }; uOpacity: { value: number } };
  tentacleUniforms: { uTime: { value: number }; uPhase: { value: number }; uColor: { value: THREE.Color }; uOpacity: { value: number } };
  /** Horizontal position as a fraction of the viewport width. */
  nx: number;
  /** Vertical position in DOCUMENT px as a multiple of the viewport height. */
  docY: number;
  /** Apparent bell width in px at 1440 px viewport. */
  size: number;
  parallax: number;
  phase: number;
}

// Placement: framing the hero's sides and drifting down the page edges; colours from the brand cyan / violet / pink.
const JELLIES: Array<{ nx: number; docY: number; size: number; parallax: number; color: number }> = [
  { nx: 0.065, docY: 0.3, size: 58, parallax: 0.32, color: 0x7fe3ff },
  { nx: 0.135, docY: 0.62, size: 36, parallax: 0.22, color: 0xb59cff },
  { nx: 0.04, docY: 0.86, size: 26, parallax: 0.16, color: 0xff9fd6 },
  { nx: 0.93, docY: 1.55, size: 38, parallax: 0.28, color: 0x8fd8ff },
  { nx: 0.05, docY: 2.6, size: 34, parallax: 0.25, color: 0xc4a8ff },
  { nx: 0.95, docY: 3.4, size: 28, parallax: 0.2, color: 0x7fe3ff },
];

export function createSeaLife(toWorld: ToWorld, coarse: boolean): SeaLife {
  const group = new THREE.Group();
  group.name = 'SeaLife';

  // ── School of fish ──
  const fishCount = coarse ? 26 : 58;
  const fishUniforms = { uTime: { value: 0 }, uOpacity: { value: 1 } };
  const fishMaterial = new THREE.ShaderMaterial({
    vertexShader: FISH_VERTEX,
    fragmentShader: FISH_FRAGMENT,
    uniforms: fishUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const fishGeo = fishGeometry();
  const phases = new Float32Array(fishCount);
  for (let i = 0; i < fishCount; i++) phases[i] = Math.random();
  fishGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  const fish = new THREE.InstancedMesh(fishGeo, fishMaterial, fishCount);
  fish.frustumCulled = false;
  fish.renderOrder = -2;
  group.add(fish);

  // Each fish keeps a slot in the school's formation and its own lag and scare state (screen space).
  const slots = Array.from({ length: fishCount }, () => ({
    ox: (Math.random() - 0.5) * 2,
    oy: (Math.random() - 0.5) * 1.1,
    od: Math.random() * 2 - 1,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    sx: 0,
    sy: 0,
    hx: 1,
    hy: 0,
    hz: 0,
    size: 0.8 + Math.random() * 0.45,
    seeded: false,
  }));
  const dummy = new THREE.Object3D();
  const fishPos = new THREE.Vector3();
  const fishAhead = new THREE.Vector3();

  // ── Jellyfish ──
  const bellGeo = new THREE.SphereGeometry(0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const strands = 7;
  const segments = 14;
  const tentaclePositions = new Float32Array(strands * segments * 2 * 3);
  const along = new Float32Array(strands * segments * 2);
  const strand = new Float32Array(strands * segments * 2);
  let k = 0;
  for (let s = 0; s < strands; s++) {
    for (let g = 0; g < segments; g++) {
      for (const a of [g / segments, (g + 1) / segments]) {
        along[k] = a;
        strand[k] = s;
        k++;
      }
    }
  }
  const tentacleGeo = new THREE.BufferGeometry();
  tentacleGeo.setAttribute('position', new THREE.BufferAttribute(tentaclePositions, 3));
  tentacleGeo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  tentacleGeo.setAttribute('aStrand', new THREE.BufferAttribute(strand, 1));
  // Pure light: add colour, keep the canvas alpha, so the glow composites additively over the CSS water.
  const additive = {
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  } as const;
  const jellies: Jelly[] = (coarse ? JELLIES.filter((_, i) => i % 2 === 0) : JELLIES).map((spec, i) => {
    const color = new THREE.Color(spec.color);
    const bellUniforms = { uTime: { value: 0 }, uPhase: { value: i * 1.9 }, uColor: { value: color }, uOpacity: { value: 1 } };
    const tentacleUniforms = { uTime: { value: 0 }, uPhase: { value: i * 1.9 }, uColor: { value: color }, uOpacity: { value: 1 } };
    const bell = new THREE.Mesh(
      bellGeo,
      new THREE.ShaderMaterial({ vertexShader: BELL_VERTEX, fragmentShader: BELL_FRAGMENT, uniforms: bellUniforms, ...additive, side: THREE.DoubleSide })
    );
    const tentacles = new THREE.LineSegments(
      tentacleGeo,
      new THREE.ShaderMaterial({ vertexShader: TENTACLE_VERTEX, fragmentShader: TENTACLE_FRAGMENT, uniforms: tentacleUniforms, ...additive })
    );
    bell.frustumCulled = false;
    tentacles.frustumCulled = false;
    const root = new THREE.Group();
    root.add(bell, tentacles);
    root.renderOrder = -3;
    group.add(root);
    return { root, bellUniforms, tentacleUniforms, nx: spec.nx, docY: spec.docY, size: spec.size, parallax: spec.parallax, phase: i * 1.9 };
  });
  const jellyPos = new THREE.Vector3();

  let schoolFade = 0;

  return {
    group,
    update(f) {
      const scale = Math.min(1.25, Math.max(0.6, f.vw / 1440));

      // School centre: a slow loop in the upper right of the first screen (like a far shoal in the light),
      // drifting up with a gentle parallax as the visitor descends.
      const t = f.still ? 3 : f.time;
      const cx = f.vw * (0.85 + 0.06 * Math.sin(t * 0.07));
      const cy = f.vh * (0.36 + 0.07 * Math.sin(t * 0.11 + 1)) - f.scrollY * 0.3;
      const spreadX = Math.min(200, f.vw * 0.13) * scale;
      const spreadY = spreadX * 0.45;
      const fishPx = 22 * scale;
      const schoolVisible = cy > -spreadY * 2 && cy < f.vh + spreadY * 2;
      schoolFade += ((schoolVisible ? 1 : 0) - schoolFade) * Math.min(1, f.dt * 2);
      fish.visible = schoolFade > 0.01;
      fishUniforms.uOpacity.value = schoolFade;
      fishUniforms.uTime.value = f.still ? 0 : f.time;

      if (fish.visible) {
        const fear = Math.max(120, f.whaleSize * 0.85);
        for (let i = 0; i < fishCount; i++) {
          const s = slots[i];
          // Formation slot sways around the centre; the whole school swims along its loop.
          const tx = cx + (s.ox * spreadX) * (1 + 0.15 * Math.sin(t * 0.5 + i)) + Math.sin(t * 0.9 + i * 0.7) * 6;
          const ty = cy + s.oy * spreadY + Math.cos(t * 0.8 + i * 1.3) * 5;
          if (!s.seeded || f.still) {
            s.x = tx;
            s.y = ty;
            s.seeded = true;
          }
          // Scatter from Echo, then drift back into formation.
          if (f.whaleSize > 0 && !f.still) {
            const dx = s.x - f.whaleX;
            const dy = s.y - f.whaleY;
            const d2 = dx * dx + dy * dy;
            if (d2 < fear * fear) {
              const d = Math.sqrt(d2) + 1;
              const push = (1 - d / fear) * 1600;
              s.sx += (dx / d) * push * f.dt;
              s.sy += (dy / d) * push * f.dt;
            }
          }
          s.sx *= Math.exp(-f.dt * 1.2);
          s.sy *= Math.exp(-f.dt * 1.2);
          const ax = (tx + s.sx - s.x) * 3.2 - s.vx * 2.4;
          const ay = (ty + s.sy - s.y) * 3.2 - s.vy * 2.4;
          s.vx += ax * f.dt;
          s.vy += ay * f.dt;
          const px = s.x;
          const py = s.y;
          s.x += s.vx * f.dt;
          s.y += s.vy * f.dt;

          const size = fishPx * s.size;
          // One unit of fish = `size` px: smaller fish sit deeper in the water.
          toWorld(s.x, s.y, size, fishPos);
          // Heading: the swim direction on screen, with the school's general drift as a floor.
          const mvx = s.x - px + Math.cos(t * 0.07) * 0.6 * f.dt * f.vw * 0.01;
          const mvy = s.y - py;
          const len = Math.hypot(mvx, mvy);
          if (len > 1e-3) {
            s.hx += (mvx / len - s.hx) * Math.min(1, f.dt * 5);
            s.hy += (mvy / len - s.hy) * Math.min(1, f.dt * 5);
          }
          s.hz = 0.35 * Math.sin(t * 0.07 + s.od);
          toWorld(s.x + s.hx * 20, s.y + s.hy * 20, size, fishAhead);
          fishAhead.z += s.hz;
          dummy.position.copy(fishPos);
          dummy.lookAt(fishAhead);
          dummy.updateMatrix();
          fish.setMatrixAt(i, dummy.matrix);
        }
        fish.instanceMatrix.needsUpdate = true;
      }

      // Jellyfish drift up the page slower than the content (they are far away) and bob with each pulse.
      for (const j of jellies) {
        const sizePx = j.size * scale * (f.vw < 640 ? 0.8 : 1);
        const x = j.nx * f.vw;
        const pulseBob = f.still ? 0 : Math.sin(f.time * 1.7 + j.phase - 0.9) * 4;
        const y = j.docY * f.vh - f.scrollY * j.parallax + Math.sin(f.time * 0.12 + j.phase) * 18 - pulseBob;
        const visible = y > -sizePx * 4 && y < f.vh + sizePx * 2;
        j.root.visible = visible;
        if (!visible) continue;
        toWorld(x, y, sizePx, jellyPos);
        j.root.position.copy(jellyPos);
        j.root.rotation.z = Math.sin(f.time * 0.3 + j.phase) * 0.12;
        j.root.rotation.x = 0.35;
        const time = f.still ? 0 : f.time;
        j.bellUniforms.uTime.value = time;
        j.tentacleUniforms.uTime.value = time;
      }
    },
    dispose() {
      fishGeo.dispose();
      fishMaterial.dispose();
      bellGeo.dispose();
      tentacleGeo.dispose();
      for (const j of jellies) {
        j.root.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.material) (mesh.material as THREE.Material).dispose();
        });
      }
    },
  };
}
