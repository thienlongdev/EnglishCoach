import * as THREE from 'three';

/**
 * Knowledge forms: the light in the water gathers into a shape wherever the page teaches something.
 *
 * A form is any element carrying `data-ocean-form`. Its box is where the shape appears; the attribute says which one:
 *
 *   data-ocean-form="ring"      a slow halo of pearls (a word becoming a memory)
 *   data-ocean-form="wave"      a travelling sound wave
 *   data-ocean-form="lines"     rows of light, like lines of text
 *   data-ocean-form="route"     a winding path with a pulse travelling along it
 *   data-ocean-form="cluster"   six small orbiting groups (worlds)
 *   data-ocean-tint="aqua|violet|pearl|coral"   optional colour
 *
 * This is the landing ocean's scene adapter for page content: ONE `THREE.Points` (one draw call) added to the ocean
 * engine's own scene, behind Echo. Every mote has a drifting place in the open water and a place in the shape; the
 * shader blends the two by how close the form's element is to the middle of the screen, so the shape assembles while
 * the visitor scrolls toward it and dissolves again when they scroll away, in either direction, with no state to get
 * out of step. Boxes are measured in document coordinates on layout changes (never per frame), like the swim lanes.
 * The layer is decoration only: the meaning stays in the HTML it sits behind.
 */

type FormKind = 'ring' | 'wave' | 'lines' | 'route' | 'cluster';

const FORM_INDEX: Record<FormKind, number> = { ring: 0, wave: 1, lines: 2, route: 3, cluster: 4 };

const TINTS: Record<string, [number, number, number]> = {
  aqua: [0.42, 0.9, 1.0],
  violet: [0.72, 0.64, 1.0],
  pearl: [0.93, 0.95, 1.0],
  coral: [1.0, 0.68, 0.74],
};

interface Form {
  el: HTMLElement;
  kind: number;
  tint: [number, number, number];
  top: number;
  left: number;
  width: number;
  height: number;
}

const VERTEX = /* glsl */ `
  attribute vec4 aSeed;
  uniform float uTime;
  uniform float uScroll;
  uniform float uViewH;
  uniform float uAspect;
  uniform float uPixelRatio;
  uniform vec4 uBox;     // centre (ndc xy), half size (ndc xy)
  uniform float uForm;
  uniform float uMix;
  varying float vAlpha;
  varying float vTint;

  const float TAU = 6.28318;

  vec2 formed(float kind, vec4 s) {
    vec2 h = uBox.zw;
    // A radius that is round on screen, whatever the shape of the box.
    float r = min(h.x * uAspect, h.y);
    if (kind < 0.5) {
      // Halo: two counter-turning bands of pearls.
      float band = step(0.62, s.y);
      float a = s.x * TAU + uTime * mix(0.07, -0.045, band);
      float rad = mix(0.9, 1.1, band) + 0.05 * sin(s.w * 40.0 + uTime * 0.6);
      return vec2(cos(a) * h.x, sin(a) * h.y) * rad;
    }
    if (kind < 1.5) {
      // Sound: a carrier under a slow envelope, travelling left to right.
      float x = s.x * 2.0 - 1.0;
      float env = 0.35 + 0.65 * abs(sin(x * 2.6 - uTime * 0.35));
      float y = sin(x * 11.0 - uTime * 1.5) * env * 0.62 + (s.y - 0.5) * 0.16;
      return vec2(x * h.x, y * h.y);
    }
    if (kind < 2.5) {
      // Text: seven rows, each ending where a line of prose might.
      float row = floor(s.y * 7.0);
      float len = 0.62 + 0.38 * fract(sin(row * 12.9898) * 43758.5453);
      float x = -1.0 + s.x * 2.0 * len;
      float y = 0.86 - row * (1.72 / 6.0);
      return vec2(x * h.x, y * h.y);
    }
    if (kind < 3.5) {
      // Route: a winding line across the box.
      float t = s.x;
      float y = sin(t * TAU * 1.25 + 0.6) * 0.58 + (s.y - 0.5) * 0.07;
      return vec2((t * 2.0 - 1.0) * h.x, y * h.y);
    }
    // Worlds: six groups on a slow wheel, each with its own small orbit.
    float k = floor(s.y * 6.0);
    float ca = k / 6.0 * TAU + uTime * 0.04;
    float la = s.x * TAU + uTime * (0.35 + 0.1 * k);
    vec2 c = vec2(cos(ca) * h.x, sin(ca) * h.y) * 0.92;
    return c + vec2(cos(la) / uAspect, sin(la)) * r * (0.16 + 0.2 * s.w);
  }

  void main() {
    // Open water: a slow drift with a little scroll parallax, wrapped so the field never empties.
    float depth = aSeed.z;
    float ny = aSeed.y * 2.3 - 1.15 + uScroll * mix(0.22, 0.06, depth) * 2.0 / uViewH + uTime * 0.01 * (0.4 + aSeed.w);
    ny = mod(ny + 1.15, 2.3) - 1.15;
    float nx = aSeed.x * 2.3 - 1.15 + sin(uTime * 0.09 + aSeed.w * TAU) * 0.02;
    vec2 adrift = vec2(nx, ny);

    // Each mote leaves and arrives at its own moment, so the shape gathers instead of snapping.
    float m = smoothstep(aSeed.z * 0.55, aSeed.z * 0.55 + 0.45, uMix);
    vec2 shaped = uBox.xy + formed(uForm, aSeed);
    vec2 p = mix(adrift, shaped, m);
    // A small swirl on the way in.
    float way = m * (1.0 - m) * 4.0;
    p += vec2(cos(aSeed.w * TAU + uTime), sin(aSeed.w * TAU + uTime)) * way * 0.03;

    gl_Position = vec4(p, 0.92, 1.0);
    float twinkle = 0.62 + 0.38 * sin(uTime * (0.6 + aSeed.w) + aSeed.w * 37.0);
    float pulse = 1.0;
    if (uForm > 2.5 && uForm < 3.5) {
      // A light travels along the route.
      float d = fract(aSeed.x - uTime * 0.07);
      pulse = 0.55 + 1.3 * smoothstep(0.16, 0.0, min(d, 1.0 - d));
    }
    gl_PointSize = mix(mix(2.6, 1.2, depth), mix(6.5, 3.4, aSeed.w), m) * uPixelRatio;
    vAlpha = mix(mix(0.2, 0.07, depth), 0.95 * pulse, m) * twinkle;
    vTint = fract(aSeed.w * 7.13);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uTint;
  varying float vAlpha;
  varying float vTint;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float a = smoothstep(0.5, 0.0, length(c));
    vec3 pearl = vec3(0.94, 0.97, 1.0);
    gl_FragColor = vec4(mix(uTint, pearl, vTint * 0.55), a * a * vAlpha);
  }
`;

export interface KnowledgeForms {
  points: THREE.Points;
  /** Re-read the form elements (layout changed). */
  read(root: ParentNode): void;
  /** Refresh every form's box. Called on resize / layout change, never per frame. */
  measure(): void;
  resize(vw: number, vh: number, pixelRatio: number): void;
  /** Per frame: pick the form nearest the middle of the screen and blend toward it. Returns the blend (0 = adrift). */
  update(time: number, scrollX: number, scrollY: number, vw: number, vh: number, still: boolean): number;
  dispose(): void;
}

export function createKnowledgeForms(coarse: boolean): KnowledgeForms {
  const count = coarse ? 190 : 420;
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = Math.random();
    seeds[i * 4 + 1] = Math.random();
    seeds[i * 4 + 2] = Math.random();
    seeds[i * 4 + 3] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const uniforms = {
    uTime: { value: 0 },
    uScroll: { value: 0 },
    uViewH: { value: 800 },
    uAspect: { value: 1 },
    uPixelRatio: { value: 1 },
    uBox: { value: new THREE.Vector4(0, 0, 0.3, 0.3) },
    uForm: { value: 0 },
    uMix: { value: 0 },
    uTint: { value: new THREE.Vector3(...TINTS.aqua) },
  };
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  let forms: Form[] = [];
  let mix = 0;
  let current: Form | null = null;

  const measure = () => {
    const sx = window.scrollX;
    const sy = window.scrollY;
    for (const form of forms) {
      const rect = form.el.getBoundingClientRect();
      form.top = rect.top + sy;
      form.left = rect.left + sx;
      form.width = rect.width;
      form.height = rect.height;
    }
  };

  return {
    points,
    read(root) {
      forms = [];
      root.querySelectorAll<HTMLElement>('[data-ocean-form]').forEach((el) => {
        const kind = FORM_INDEX[el.dataset.oceanForm as FormKind];
        if (kind === undefined) return;
        forms.push({ el, kind, tint: TINTS[el.dataset.oceanTint || ''] ?? TINTS.aqua, top: 0, left: 0, width: 0, height: 0 });
      });
      if (current && !forms.includes(current)) current = null;
      measure();
    },
    measure,
    resize(vw, vh, pixelRatio) {
      uniforms.uViewH.value = vh;
      uniforms.uAspect.value = vw / vh;
      uniforms.uPixelRatio.value = pixelRatio;
    },
    update(time, scrollX, scrollY, vw, vh, still) {
      uniforms.uTime.value = still ? 7 : time;
      uniforms.uScroll.value = scrollY;
      // How present each form is: 1 with its centre on the middle of the screen, 0 from 0.62 of a screen away. The
      // blend is the best form's presence minus the runner-up's, so it is exactly 0 at the moment the two swap and
      // the shape never jumps from one form to the next.
      let best: Form | null = null;
      let bestW = 0;
      let secondW = 0;
      const reach = vh * 0.62;
      for (const form of forms) {
        if (form.width < 8 || form.height < 8) continue;
        const cy = form.top - scrollY + form.height / 2;
        const w = 1 - Math.abs(cy - vh * 0.5) / reach;
        if (w <= 0) continue;
        if (w > bestW) {
          secondW = bestW;
          bestW = w;
          best = form;
        } else if (w > secondW) {
          secondW = w;
        }
      }
      // Under reduced motion the motes stay adrift: a shape assembling with the scroll is motion, not information.
      const wanted = still || !best ? 0 : Math.min(1, (bestW - secondW) * 1.9);
      if (best && (mix < 0.02 || best === current)) current = best;
      // The blend follows the scroll directly (reversible, no timeline); a short ease only hides the swap of forms.
      mix = current === best ? wanted : Math.max(0, mix - 0.08);
      uniforms.uMix.value = mix * mix * (3 - 2 * mix);
      if (current) {
        const cx = current.left - scrollX + current.width / 2;
        const cy = current.top - scrollY + current.height / 2;
        uniforms.uBox.value.set((cx / vw) * 2 - 1, 1 - (cy / vh) * 2, current.width / vw, current.height / vh);
        uniforms.uForm.value = current.kind;
        uniforms.uTint.value.set(...current.tint);
      }
      return mix;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
