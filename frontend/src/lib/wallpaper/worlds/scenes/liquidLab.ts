import type { WorldFactory } from '../types';
import { musicBands } from '@/lib/vfx/audio';
import { vfxReduced } from '@/lib/vfx/quality';
import { COMMON_UNIFORMS, FULLSCREEN_VS, NOISE_GLSL, bindTexture, darkEase, floatTarget, freeTarget, makeProgram, makeSwap, setCommon, type Program, type Swap, type Target, makeTarget } from '../gl';

/**
 * Liquid Lab. A real incompressible fluid solved on the GPU (advection, vorticity, pressure projection), stirred by slow
 * invisible emitters and by the pointer. Its dye is then shaded as a surface of molten glass: normals from the dye's
 * height, a studio light reflected in it, and colour split as it refracts. A glass lens follows the pointer and bends
 * whatever is below it. All the work happens on the learner's GPU.
 */

const COMMON_SIM = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform vec2 uTexel;
`;

const ADVECT = `${COMMON_SIM}
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform float uDt;
uniform float uDissipation;
uniform vec2 uVelTexel;
void main() {
  vec2 v = texture(uVelocity, vUv).xy;
  vec2 back = vUv - uDt * v * uVelTexel;
  outColor = texture(uSource, back) / (1.0 + uDissipation * uDt);
}`;

const CURL = `${COMMON_SIM}
uniform sampler2D uVelocity;
void main() {
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  outColor = vec4(0.5 * (r - l - t + b), 0.0, 0.0, 1.0);
}`;

const VORTICITY = `${COMMON_SIM}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uStrengthV;
uniform float uDt;
void main() {
  float l = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float c = texture(uCurl, vUv).x;
  vec2 f = 0.5 * vec2(abs(t) - abs(b), abs(r) - abs(l));
  f /= length(f) + 0.0001;
  f *= uStrengthV * c;
  f.y *= -1.0;
  vec2 v = texture(uVelocity, vUv).xy + f * uDt;
  outColor = vec4(clamp(v, -1000.0, 1000.0), 0.0, 1.0);
}`;

const DIVERGENCE = `${COMMON_SIM}
uniform sampler2D uVelocity;
void main() {
  float l = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  float b = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  outColor = vec4(0.5 * (r - l + t - b), 0.0, 0.0, 1.0);
}`;

const PRESSURE = `${COMMON_SIM}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float d = texture(uDivergence, vUv).x;
  outColor = vec4((l + r + b + t - d) * 0.25, 0.0, 0.0, 1.0);
}`;

const GRADIENT = `${COMMON_SIM}
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
  float l = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float r = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float t = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float b = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  vec2 v = texture(uVelocity, vUv).xy - vec2(r - l, t - b);
  outColor = vec4(v, 0.0, 1.0);
}`;

const SPLAT = `${COMMON_SIM}
uniform sampler2D uTarget;
uniform vec3 uColor;
uniform vec2 uPoint;
uniform float uRadius;
uniform float uAspect;
void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  vec3 s = exp(-dot(p, p) / uRadius) * uColor;
  outColor = vec4(texture(uTarget, vUv).xyz + s, 1.0);
}`;

const DISPLAY = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uDye;
uniform vec2 uDyeTexel;
uniform vec2 uLens;
uniform float uLensR;
${COMMON_UNIFORMS}
${NOISE_GLSL}

// The studio: what the liquid reflects and refracts.
vec3 studio(vec2 d) {
  float h = d.y * 0.5 + 0.5;
  vec3 night = mix(vec3(0.03, 0.03, 0.09), vec3(0.14, 0.13, 0.34), smoothstep(0.1, 1.0, h));
  vec3 day = mix(vec3(0.74, 0.76, 0.92), vec3(0.97, 0.97, 1.0), smoothstep(0.1, 1.0, h));
  vec3 c = mix(day, night, uDark);
  // two long softboxes
  c += vec3(1.0, 0.96, 0.92) * smoothstep(0.1, 0.0, abs(d.x + d.y * 0.6 - 0.34)) * smoothstep(-0.1, 0.5, d.y) * 1.1;
  c += vec3(0.76, 0.86, 1.0) * smoothstep(0.08, 0.0, abs(d.x - d.y * 0.4 + 0.6)) * 0.6;
  return c;
}

vec3 palette(vec3 dye) {
  return dye;
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;

  // The lens: bends the liquid below it.
  vec2 lp = (uv - uLens) * vec2(aspect, 1.0);
  float ld = length(lp);
  float inLens = 1.0 - smoothstep(uLensR - 0.003, uLensR + 0.003, ld);
  float lz = sqrt(max(0.0, 1.0 - min(1.0, ld * ld / (uLensR * uLensR + 1e-6))));
  vec2 lensBend = lp / (uLensR + 1e-5) * (1.0 - lz) * uLensR * 1.7;
  vec2 q = uv - lensBend * inLens / vec2(aspect, 1.0) * 1.0;

  // The dye as a height: normals from its luminance.
  vec2 e = uDyeTexel * 1.5;
  #define H(u) dot(texture(uDye, u).rgb, vec3(0.34, 0.33, 0.33))
  float hl = H(q - vec2(e.x, 0.0));
  float hr = H(q + vec2(e.x, 0.0));
  float hb = H(q - vec2(0.0, e.y));
  float ht = H(q + vec2(0.0, e.y));
  vec3 n = normalize(vec3((hl - hr) * 3.2, (hb - ht) * 3.2, 1.0));

  // Colour splits as it refracts through the surface.
  vec2 refr = n.xy * 0.03;
  vec3 dye;
  dye.r = texture(uDye, q + refr * 1.2).r;
  dye.g = texture(uDye, q + refr).g;
  dye.b = texture(uDye, q + refr * 0.8).b;
  dye = clamp(dye, 0.0, 1.8);
  float amount = clamp(dot(dye, vec3(0.5)), 0.0, 1.0);

  // Thin dye is a tint of the same hue, never a muddy dark: the colour keeps its saturation as it thins out.
  vec3 hue = dye / max(max(dye.r, max(dye.g, dye.b)), 0.03);
  vec3 stage = mix(vec3(0.93, 0.93, 0.98), vec3(0.012, 0.012, 0.042), uDark);
  vec3 base = mix(stage, hue * mix(0.88, 0.94, uDark) + mix(0.06, 0.0, uDark), smoothstep(0.05, 0.6, amount));

  // Reflection of the studio; fresnel on the steep parts of the surface.
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 r = reflect(-view, n);
  vec3 refl = studio(r.xy * 1.5);
  float fres = pow(1.0 - max(n.z, 0.0), 2.2);
  vec3 col = mix(base, refl, clamp(fres * 2.4 + 0.015, 0.0, 0.82));
  // a tight highlight
  vec3 L = normalize(vec3(-0.46, 0.66, 0.6));
  float spec = pow(max(dot(n, normalize(L + view)), 0.0), 90.0);
  col += vec3(1.0, 0.98, 0.95) * spec * 1.25 * smoothstep(0.0, 0.2, amount);

  // The lens: a glass bead above the liquid, rim-lit, with a faint rainbow at its edge.
  if (uLensR > 0.0005) {
    float rim = smoothstep(uLensR - 0.03, uLensR - 0.006, ld) * (1.0 - smoothstep(uLensR - 0.004, uLensR, ld));
    vec3 rainbow = 0.5 + 0.5 * cos(6.28 * (atan(lp.y, lp.x) * 0.32 + vec3(0.0, 0.33, 0.67)) + ld * 34.0);
    col = mix(col, col * 1.08 + 0.02, inLens);
    col += rainbow * rim * 0.42;
    float top = smoothstep(uLensR * 0.9, uLensR * 0.2, length(lp - vec2(-0.3, 0.36) * uLensR)) * inLens;
    col += vec3(1.0) * pow(top, 3.2) * 0.26;
    col = mix(col, col * 0.86, smoothstep(uLensR + 0.05, uLensR, ld) * (1.0 - inLens) * 0.55);
  }

  // fine film grain keeps long gradients from banding
  col += (hash21(uv * uRes + uTime) - 0.5) / 110.0;
  outColor = vec4(col, 1.0);
}`;

const NIGHT_INKS: [number, number, number][] = [[0.96, 0.25, 0.52], [0.24, 0.42, 1.0], [0.4, 0.18, 0.98], [0.1, 0.8, 0.9], [0.98, 0.48, 0.18]];
const DAY_INKS: [number, number, number][] = [[0.62, 0.36, 0.98], [0.2, 0.56, 1.0], [0.92, 0.42, 0.78], [0.16, 0.82, 0.86], [0.98, 0.62, 0.44]];

const factory: WorldFactory = (env) => {
  const gl = env.gl;
  const format = floatTarget(gl);
  if (!format) throw new Error('no float targets');

  const vs = FULLSCREEN_VS;
  const advect = makeProgram(gl, vs, ADVECT);
  const curlP = makeProgram(gl, vs, CURL);
  const vort = makeProgram(gl, vs, VORTICITY);
  const divP = makeProgram(gl, vs, DIVERGENCE);
  const pres = makeProgram(gl, vs, PRESSURE);
  const grad = makeProgram(gl, vs, GRADIENT);
  const splat = makeProgram(gl, vs, SPLAT);
  const display = makeProgram(gl, vs, DISPLAY);
  const vao = gl.createVertexArray();

  const dims = () => {
    const simH = env.tier === 'high' ? 160 : env.tier === 'balanced' ? 112 : 72;
    const dyeH = env.tier === 'high' ? 720 : env.tier === 'balanced' ? 480 : 300;
    const aspect = env.cssWidth / env.cssHeight;
    return { simW: Math.round(simH * aspect), simH, dyeW: Math.round(dyeH * aspect), dyeH };
  };
  let d = dims();
  let velocity: Swap = makeSwap(gl, d.simW, d.simH, format);
  let pressure: Swap = makeSwap(gl, d.simW, d.simH, format);
  let dye: Swap = makeSwap(gl, d.dyeW, d.dyeH, format);
  let divergence: Target = makeTarget(gl, d.simW, d.simH, format, gl.NEAREST);
  let curl: Target = makeTarget(gl, d.simW, d.simH, format, gl.NEAREST);

  const draw = (target: Target | null) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null);
    gl.viewport(0, 0, target?.w ?? env.width, target?.h ?? env.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const texel = (p: Program, t: Target) => gl.uniform2f(p.u('uTexel'), 1 / t.w, 1 / t.h);

  const addSplat = (u: number, v: number, fx: number, fy: number, color: [number, number, number], radius: number) => {
    const aspect = env.cssWidth / env.cssHeight;
    gl.useProgram(splat.prog);
    gl.uniform2f(splat.u('uPoint'), u, v);
    gl.uniform1f(splat.u('uAspect'), aspect);
    gl.uniform1f(splat.u('uRadius'), radius);
    texel(splat, velocity.read);
    gl.uniform3f(splat.u('uColor'), fx, fy, 0);
    bindTexture(gl, 0, velocity.read.tex, splat.u('uTarget'));
    draw(velocity.write);
    velocity.swap();
    gl.uniform3f(splat.u('uColor'), color[0], color[1], color[2]);
    gl.uniform1f(splat.u('uRadius'), radius * 1.4);
    bindTexture(gl, 0, dye.read.tex, splat.u('uTarget'));
    draw(dye.write);
    dye.swap();
  };

  const step = (dt: number) => {
    gl.disable(gl.BLEND);
    // Vorticity keeps the small swirls alive.
    gl.useProgram(curlP.prog);
    texel(curlP, velocity.read);
    bindTexture(gl, 0, velocity.read.tex, curlP.u('uVelocity'));
    draw(curl);
    gl.useProgram(vort.prog);
    texel(vort, velocity.read);
    bindTexture(gl, 0, velocity.read.tex, vort.u('uVelocity'));
    bindTexture(gl, 1, curl.tex, vort.u('uCurl'));
    gl.uniform1f(vort.u('uStrengthV'), 12);
    gl.uniform1f(vort.u('uDt'), dt);
    draw(velocity.write);
    velocity.swap();
    // Divergence.
    gl.useProgram(divP.prog);
    texel(divP, velocity.read);
    bindTexture(gl, 0, velocity.read.tex, divP.u('uVelocity'));
    draw(divergence);
    // Pressure.
    gl.useProgram(pres.prog);
    texel(pres, pressure.read);
    bindTexture(gl, 1, divergence.tex, pres.u('uDivergence'));
    const iterations = env.tier === 'low' ? 10 : 18;
    for (let i = 0; i < iterations; i++) {
      bindTexture(gl, 0, pressure.read.tex, pres.u('uPressure'));
      draw(pressure.write);
      pressure.swap();
    }
    // Projection: the flow becomes divergence-free, which is what makes it look like a liquid.
    gl.useProgram(grad.prog);
    texel(grad, velocity.read);
    bindTexture(gl, 0, pressure.read.tex, grad.u('uPressure'));
    bindTexture(gl, 1, velocity.read.tex, grad.u('uVelocity'));
    draw(velocity.write);
    velocity.swap();
    // Advection.
    gl.useProgram(advect.prog);
    gl.uniform1f(advect.u('uDt'), dt);
    gl.uniform2f(advect.u('uVelTexel'), 1 / velocity.read.w, 1 / velocity.read.h);
    texel(advect, velocity.read);
    bindTexture(gl, 0, velocity.read.tex, advect.u('uVelocity'));
    bindTexture(gl, 1, velocity.read.tex, advect.u('uSource'));
    gl.uniform1f(advect.u('uDissipation'), 0.24);
    draw(velocity.write);
    velocity.swap();
    bindTexture(gl, 0, velocity.read.tex, advect.u('uVelocity'));
    bindTexture(gl, 1, dye.read.tex, advect.u('uSource'));
    gl.uniform1f(advect.u('uDissipation'), 0.2);
    draw(dye.write);
    dye.swap();
  };

  let dark = env.params.dark ? 1 : 0;
  let lastU = env.pointer.u;
  let lastV = env.pointer.v;
  let clock = 0;
  let nextEmit = 0;
  let inkIndex = 0;
  let lensR = 0;

  const emit = (t: number) => {
    const audio = musicBands();
    const response = vfxReduced() ? 0 : env.params.motion * (1 - env.params.calm * .85);
    const force = 170 * (1 + audio.bass * response * .12);
    // Three invisible stirrers wander over the surface, so the liquid keeps flowing on its own.
    const inks = env.params.dark ? NIGHT_INKS : DAY_INKS;
    for (let i = 0; i < 3; i++) {
      const ang = t * (0.13 + i * 0.041) + i * 2.1 + audio.mid * response * .035;
      const u = 0.5 + 0.42 * Math.cos(ang * 1.3 + i);
      const v = 0.5 + 0.4 * Math.sin(ang * 0.9 + i * 1.7);
      const dirx = -Math.sin(ang * 1.3 + i) * 1.3;
      const diry = Math.cos(ang * 0.9 + i * 1.7) * 0.9;
      const c = inks[(inkIndex + i) % inks.length];
      addSplat(u, v, dirx * force, diry * force, [c[0] * (.42 + audio.treble * response * .035), c[1] * .42, c[2] * .42], 0.0034);
    }
    inkIndex += 1;
  };

  return {
    warm(seconds) {
      // Open with a surface that already flows: a few seconds of stirring, run fast.
      const steps = Math.min(36, Math.round(seconds * 12));
      gl.bindVertexArray(vao);
      for (let i = 0; i < steps; i++) {
        clock += 0.09;
        if (i % 2 === 0) emit(clock);
        step(0.03);
      }
    },
    frame(t, dt) {
      dark = darkEase(dark, env.params.dark, dt);
      gl.bindVertexArray(vao);
      const safe = Math.min(dt, 1 / 40);
      if (dt > 0) {
        clock += dt;
        if (clock > nextEmit) {
          emit(clock);
          nextEmit = clock + 0.28;
        }
        const p = env.pointer;
        const du = p.u - lastU;
        const dv = p.v - lastV;
        if (p.strength > 0.01 && (Math.abs(du) > 0.0002 || Math.abs(dv) > 0.0002)) {
          const inks = env.params.dark ? NIGHT_INKS : DAY_INKS;
          const c = inks[(Math.floor(clock * 0.5)) % inks.length];
          const force = 5200 * p.strength;
          addSplat(p.u, p.v, du * force, dv * force, [c[0] * 0.5 * p.strength, c[1] * 0.5 * p.strength, c[2] * 0.5 * p.strength], 0.0024);
        }
        lastU = p.u;
        lastV = p.v;
        for (const pulse of p.drainPulses()) {
          // A touch: a ring of outward pushes, the ripple settles by itself.
          for (let k = 0; k < 6; k++) {
            const ang = (k / 6) * Math.PI * 2;
            addSplat(pulse.u + Math.cos(ang) * 0.02, pulse.v + Math.sin(ang) * 0.03, Math.cos(ang) * 360, Math.sin(ang) * 360, [0.05, 0.05, 0.08], 0.0014);
          }
        }
        step(safe);
      }
      const wantR = env.pointer.fine && env.pointer.strength > 0.02 ? 0.082 * Math.min(1, env.pointer.strength * 1.5) : 0;
      lensR += (wantR - lensR) * Math.min(1, dt * 3 + 0.02);
      gl.useProgram(display.prog);
      setCommon(gl, display, env, t, dark);
      bindTexture(gl, 0, dye.read.tex, display.u('uDye'));
      gl.uniform2f(display.u('uDyeTexel'), 1 / dye.read.w, 1 / dye.read.h);
      gl.uniform2f(display.u('uLens'), env.pointer.su, env.pointer.sv);
      gl.uniform1f(display.u('uLensR'), lensR);
      draw(null);
    },
    resize() {
      const next = dims();
      if (next.simW === d.simW && next.dyeW === d.dyeW) return;
      d = next;
      for (const swap of [velocity, pressure, dye]) {
        freeTarget(gl, swap.read);
        freeTarget(gl, swap.write);
      }
      freeTarget(gl, divergence);
      freeTarget(gl, curl);
      velocity = makeSwap(gl, d.simW, d.simH, format);
      pressure = makeSwap(gl, d.simW, d.simH, format);
      dye = makeSwap(gl, d.dyeW, d.dyeH, format);
      divergence = makeTarget(gl, d.simW, d.simH, format, gl.NEAREST);
      curl = makeTarget(gl, d.simW, d.simH, format, gl.NEAREST);
    },
    dispose() {
      for (const swap of [velocity, pressure, dye]) {
        freeTarget(gl, swap.read);
        freeTarget(gl, swap.write);
      }
      freeTarget(gl, divergence);
      freeTarget(gl, curl);
      for (const p of [advect, curlP, vort, divP, pres, grad, splat, display]) gl.deleteProgram(p.prog);
      gl.deleteVertexArray(vao);
    },
    pixels: 0.85,
  };
};

export default factory;
