import type { WorldFactory } from '../types';
import { COMMON_UNIFORMS, FULLSCREEN_VS, NOISE_GLSL, bindTexture, darkEase, floatTarget, freeTarget, makeProgram, makeSwap, setCommon, tierDefines } from '../gl';

/**
 * Ink and Paper. A hanging scroll: fibred paper, mountains washed in layers of ink with wet edges and mist, one faint
 * vermilion sun, a small seal. The ink really behaves: a low-resolution sheet of "wetness" is carried over from frame
 * to frame, where the pointer's stroke is laid down, bleeds outward along the paper's grain and slowly sinks in.
 * In dark appearance the same scroll is silver ink on black paper. Deliberately low in contrast: made for long reading.
 */

const SIM = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInk;
uniform vec2 uTexel;
uniform vec2 uFrom;
uniform vec2 uTo;
uniform float uRadius;
uniform float uAmount;
uniform float uAspect;
uniform float uDt;
${NOISE_GLSL}
float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
void main() {
  vec2 uv = vUv;
  // Ink creeps along the paper's fibres, irregularly: the offset comes from a slow noise.
  vec2 flow = vec2(vnoise(uv * 38.0), vnoise(uv * 38.0 + 17.0)) - 0.5;
  vec2 e = uTexel * (1.3 + vnoise(uv * 90.0) * 1.2);
  vec2 q = uv + flow * uTexel * 1.6;
  float c = texture(uInk, q).r;
  float n = texture(uInk, q + vec2(e.x, 0.0)).r + texture(uInk, q - vec2(e.x, 0.0)).r + texture(uInk, q + vec2(0.0, e.y)).r + texture(uInk, q - vec2(0.0, e.y)).r;
  float wet = c * 0.76 + n * 0.06;
  // absorbed by the paper: fades, faster where it is thin
  wet *= exp(-uDt * (0.3 + 0.26 * (1.0 - smoothstep(0.0, 0.5, wet))));
  // the brush
  vec2 asp = vec2(uAspect, 1.0);
  float d = seg(uv * asp, uFrom * asp, uTo * asp);
  float brush = exp(-d * d / max(uRadius * uRadius, 1e-6));
  wet += (1.0 - wet) * brush * uAmount;
  outColor = vec4(wet, wet, wet, 1.0);
}`;

const DISPLAY = (defines: string) => /* glsl */ `#version 300 es
${defines}
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInk;
${COMMON_UNIFORMS}
${NOISE_GLSL}

float ridgeLine(float x, float seed, float rough) {
  // ridged noise for the sharp shoulders of real mountains, softened with plain noise
  float r = 1.0 - abs(2.0 * fbm3(vec2(x * rough * 0.8 + seed, seed * 0.7)) - 1.0);
  return mix(fbm5(vec2(x * rough + seed, seed * 0.7)), r * r * 0.9, 0.62);
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 uv = vUv;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec2 par = (uMouse - 0.5) * uStrength;

  // ── paper ──
  vec3 paperDay = vec3(0.945, 0.915, 0.84);
  vec3 paperNight = vec3(0.058, 0.062, 0.078);
  vec3 inkDay = vec3(0.13, 0.135, 0.15);
  vec3 inkNight = vec3(0.72, 0.74, 0.78);
  vec3 paper = mix(paperDay, paperNight, uDark);
  vec3 ink = mix(inkDay, inkNight, uDark);
  float grain = fbm3(p * 210.0) - 0.5;
  float cloudy = fbm3(p * 5.0) - 0.5;
  paper *= 1.0 + grain * mix(0.04, 0.09, uDark) + cloudy * 0.05;
  // long fibres in two directions
  vec2 r1 = mat2(0.86, -0.5, 0.5, 0.86) * p;
  vec2 r2 = mat2(0.5, 0.86, -0.86, 0.5) * p;
  float fib = smoothstep(0.76, 0.86, vnoise(r1 * vec2(5.0, 230.0))) + smoothstep(0.78, 0.88, vnoise(r2 * vec2(7.0, 260.0)));
  paper = mix(paper, paper * mix(0.93, 1.3, uDark), fib * 0.13);
  vec3 col = paper;

  // the sun: one faint vermilion wash, soft-edged
  vec2 sun = vec2(aspect * 0.71, 0.74);
  float ds = length((p - sun + par * 0.012));
  float sunEdge = 0.08 + (vnoise(p * 18.0) - 0.5) * 0.004;
  float sunMask = smoothstep(sunEdge + 0.006, sunEdge - 0.006, ds);
  vec3 vermilion = mix(vec3(0.78, 0.28, 0.18), vec3(0.62, 0.22, 0.16), uDark);
  col = mix(col, vermilion, sunMask * mix(0.55, 0.42, uDark) * (0.82 + grain * 0.8));

  // ── mountains: washes from far to near ──
  const int N = 6;
  for (int i = 0; i < N; i++) {
    float f = float(i) / float(N - 1);
    float seed = 3.3 + float(i) * 7.7;
    float amp = 0.15 + f * 0.17;
    float rough = 0.9 + f * 1.3;
    float shift = par.x * (0.008 + f * 0.05) + uTime * 0.0012 * (f + 0.2);
    float x = p.x + shift;
    float base = 0.62 - f * 0.46;
    float top = base + ridgeLine(x, seed, rough) * amp * 1.3 - amp * 0.42;

    float below = top - uv.y;
    // wet edge: the wash sits dark along the ridge and thins toward its foot
    float edgeNoise = (fbm3(vec2(x * 36.0, uv.y * 30.0 + seed)) - 0.5) * 0.012;
    float mask = smoothstep(-0.0018 + edgeNoise, 0.0018 + edgeNoise, below);
    float fall = mix(9.0, 4.2, f);
    float density = exp(-max(below, 0.0) * fall);
    // brush streaks falling down the slopes
    float streak = fbm3(vec2(x * 22.0 + below * 2.0, below * 7.0 + seed));
    density *= 0.62 + streak * 0.66;
    // granulation: pigment settles into the fibres
    float gran = 0.92 + grain * 0.55;
    float strength = mix(0.2, 0.74, f) * mask * density * gran * mix(1.0, 0.82, uDark);

    // mist lies in the valleys and drifts
    float mistN = fbm3(vec2(p.x * 2.2 - uTime * 0.012 * (1.0 + f), uv.y * 10.0 + seed));
    float mist = smoothstep(0.34, 0.72, mistN) * smoothstep(0.17, 0.0, below - 0.05);
    strength *= 1.0 - mist * 0.78;
    col = mix(col, ink, strength);
    col = mix(col, paper, mist * mask * 0.2);
  }

  // pines on the near slope: small dark dabs
  vec2 pg = p * vec2(52.0, 80.0);
  vec2 cell = floor(pg);
  float have = step(0.76, hash21(cell + 4.0));
  float nearTop = 0.62 - 0.46 + ridgeLine(p.x + par.x * 0.058 + uTime * 0.0012 * 1.2, 3.3 + 7.7 * 5.0, 2.2) * 0.32 * 1.3 - 0.32 * 0.42;
  float onSlope = smoothstep(0.02, 0.0, abs(uv.y - nearTop - 0.012));
  vec2 lp = fract(pg) - 0.5;
  float pine = smoothstep(0.34, 0.1, abs(lp.x) + lp.y * 0.5 + 0.16) * step(abs(lp.y), 0.5);
  col = mix(col, ink * 0.92, pine * have * onSlope * 0.66);

  // ── the living ink ──
  float wet = texture(uInk, uv + vec2(grain, cloudy) * 0.0012).r;
  float body = smoothstep(0.02, 0.5, wet);
  // wet edge: pigment gathers at the boundary of a stroke
  float rim = smoothstep(0.03, 0.12, wet) * (1.0 - smoothstep(0.12, 0.34, wet));
  float pigment = body * (0.34 + 0.34 * (grain + 0.5)) + rim * 0.2;
  col = mix(col, ink, clamp(pigment, 0.0, 0.46));

  // a small seal in the corner of the scroll
  vec2 s = p - vec2(aspect * 0.962, 0.085);
  vec2 box = abs(s) - vec2(0.017, 0.024);
  float seal = smoothstep(0.002, -0.002, max(box.x, box.y)) * (0.74 + vnoise(p * 300.0) * 0.4);
  float glyph = smoothstep(0.0028, 0.0012, abs(s.y - 0.012 * sin(s.x * 190.0))) + smoothstep(0.0028, 0.0012, abs(s.y + 0.012 + 0.006 * sin(s.x * 190.0)));
  col = mix(col, vermilion, seal * (1.0 - clamp(glyph, 0.0, 1.0) * 0.9) * mix(0.8, 0.66, uDark));

  // vignette of old paper
  vec2 v = uv - 0.5;
  col *= 1.0 - dot(v, v) * mix(0.14, 0.3, uDark);
  outColor = vec4(col, 1.0);
}`;

const factory: WorldFactory = (env) => {
  const gl = env.gl;
  const format = floatTarget(gl);
  const sim = makeProgram(gl, FULLSCREEN_VS, SIM);
  const display = makeProgram(gl, FULLSCREEN_VS, DISPLAY(tierDefines(env)));
  const vao = gl.createVertexArray();
  const size = () => {
    const h = env.tier === 'high' ? 420 : env.tier === 'balanced' ? 300 : 200;
    return [Math.max(16, Math.round((h * env.cssWidth) / env.cssHeight)), h] as const;
  };
  let [simW, simH] = size();
  let swap = makeSwap(gl, simW, simH, format);
  let dark = env.params.dark ? 1 : 0;
  let lastU = env.pointer.u;
  let lastV = env.pointer.v;

  const stroke = (fromU: number, fromV: number, toU: number, toV: number, radius: number, amount: number, dt: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, swap.write.fbo);
    gl.viewport(0, 0, simW, simH);
    gl.useProgram(sim.prog);
    bindTexture(gl, 0, swap.read.tex, sim.u('uInk'));
    gl.uniform2f(sim.u('uTexel'), 1 / simW, 1 / simH);
    gl.uniform2f(sim.u('uFrom'), fromU, fromV);
    gl.uniform2f(sim.u('uTo'), toU, toV);
    gl.uniform1f(sim.u('uRadius'), radius);
    gl.uniform1f(sim.u('uAmount'), amount);
    gl.uniform1f(sim.u('uAspect'), env.cssWidth / env.cssHeight);
    gl.uniform1f(sim.u('uDt'), dt);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    swap.swap();
  };

  return {
    frame(t, dt) {
      dark = darkEase(dark, env.params.dark, dt);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
      const p = env.pointer;
      const speed = Math.hypot(p.u - lastU, p.v - lastV);
      // The brush is pressed by moving: a resting pointer lays no ink.
      const amount = p.strength > 0.01 && speed > 0.0002 ? Math.min(0.32, speed * 9) * p.strength : 0;
      stroke(lastU, lastV, p.u, p.v, 0.012 + Math.min(0.022, speed * 0.7), amount, dt);
      lastU = p.u;
      lastV = p.v;
      for (const pulse of p.drainPulses()) stroke(pulse.u, pulse.v, pulse.u, pulse.v, 0.04, 0.6, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
      gl.useProgram(display.prog);
      setCommon(gl, display, env, t, dark);
      bindTexture(gl, 0, swap.read.tex, display.u('uInk'));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    resize() {
      const [w, h] = size();
      if (w === simW && h === simH) return;
      simW = w;
      simH = h;
      freeTarget(gl, swap.read);
      freeTarget(gl, swap.write);
      swap = makeSwap(gl, simW, simH, format);
    },
    dispose() {
      freeTarget(gl, swap.read);
      freeTarget(gl, swap.write);
      gl.deleteProgram(sim.prog);
      gl.deleteProgram(display.prog);
      gl.deleteVertexArray(vao);
    },
    pixels: 0.72,
  };
};

export default factory;
