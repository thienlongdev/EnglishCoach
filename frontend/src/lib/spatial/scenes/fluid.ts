import { FULLSCREEN_VS, floatTarget, freeTarget, makeProgram, makeSwap, makeTarget, type Program, type Swap, type Target } from '@/lib/wallpaper/worlds/gl';
import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial } from './kit';

/**
 * B03 Fluid Distortion and G02 Liquid Trail: one small GPU fluid solver (semi-Lagrangian advection, Jacobi pressure). The DOM cards are
 * obstacles: velocity dies inside them, so the flow goes around the real interface. `image` integrates a displacement map that bends a
 * marble painting and relaxes back; `ink` carries dye the pointer pours in and which fades.
 */
const HEAD = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;`;
const ADVECT = `${HEAD} uniform sampler2D uVel, uSrc; uniform vec2 uTexel; uniform float uDt, uKeep;
void main(){ vec2 c = vUv - uDt * texture(uVel, vUv).xy * uTexel; o = texture(uSrc, c) * uKeep; }`;
const SPLAT = `${HEAD} uniform sampler2D uSrc; uniform vec2 uAt; uniform vec3 uVal; uniform float uR, uAspect;
void main(){ vec2 d = vUv - uAt; d.x *= uAspect; o = texture(uSrc, vUv) + vec4(uVal, 0.0) * exp(-dot(d,d) / uR); }`;
const DIVERGE = `${HEAD} uniform sampler2D uVel; uniform vec2 uTexel;
void main(){ float l=texture(uVel,vUv-vec2(uTexel.x,0.)).x, r=texture(uVel,vUv+vec2(uTexel.x,0.)).x, b=texture(uVel,vUv-vec2(0.,uTexel.y)).y, t=texture(uVel,vUv+vec2(0.,uTexel.y)).y; o=vec4(0.5*(r-l+t-b),0.,0.,1.); }`;
const PRESSURE = `${HEAD} uniform sampler2D uP, uDiv; uniform vec2 uTexel;
void main(){ float l=texture(uP,vUv-vec2(uTexel.x,0.)).x, r=texture(uP,vUv+vec2(uTexel.x,0.)).x, b=texture(uP,vUv-vec2(0.,uTexel.y)).x, t=texture(uP,vUv+vec2(0.,uTexel.y)).x; o=vec4((l+r+b+t-texture(uDiv,vUv).x)*0.25,0.,0.,1.); }`;
const SUBTRACT = `${HEAD} uniform sampler2D uP, uVel, uField; uniform vec2 uTexel;
void main(){ float l=texture(uP,vUv-vec2(uTexel.x,0.)).x, r=texture(uP,vUv+vec2(uTexel.x,0.)).x, b=texture(uP,vUv-vec2(0.,uTexel.y)).x, t=texture(uP,vUv+vec2(0.,uTexel.y)).x;
 vec2 v = texture(uVel,vUv).xy - 0.5*vec2(r-l,t-b); float wall = smoothstep(0.7,0.98,texture(uField,vUv).r); o = vec4(v*(1.0-wall),0.,1.); }`;
const ACCUMULATE = `${HEAD} uniform sampler2D uDisp, uVel; uniform float uDt;
void main(){ vec2 d = texture(uDisp, vUv).xy * 0.986 + texture(uVel, vUv).xy * uDt; o = vec4(d, 0., 1.); }`;

const SHOW = /* glsl */ `${SPATIAL_FS_HEAD}
uniform sampler2D uDye;
uniform float uInk;
vec3 marble(vec2 p) {
  float a = uCss.x / uCss.y;
  vec2 q = vec2(p.x * a, p.y) * 1.3;
  float w = fbm3(q + fbm3(q * 1.7 + uTime * 0.012) * 1.6);
  float veins = sin((w + q.x * 0.35) * 16.0);
  vec3 col = mix(uC0, uC1, smoothstep(0.2, 0.75, w));
  col = mix(col, uC2, smoothstep(0.55, 0.98, veins) * 0.62);
  col = mix(col, uC3, smoothstep(0.93, 1.0, veins) * 0.7);
  return col;
}
void main() {
  vec4 d = texture(uDye, vUv);
  if (uInk > 0.5) {
    float a = uCss.x / uCss.y;
    vec3 ground = mix(uC0, uC1, smoothstep(-0.3, 1.4, vUv.y) * 0.55);
    float grain = fbm2(vec2(vUv.x * a, vUv.y) * 90.0) * 0.012;
    vec3 ink = clamp(d.rgb, 0.0, 1.0);
    float amount = clamp(max(ink.r, max(ink.g, ink.b)) * 1.5, 0.0, 1.0);
    vec3 pigment = mix(uC2, uC3, clamp(ink.g * 2.2, 0.0, 1.0));
    vec3 col = mix(ground, pigment, smoothstep(0.02, 0.8, amount));
    col += pigment * smoothstep(0.55, 1.0, amount) * 0.35 * uDark;
    fragColor = vec4(col + grain, 1.0);
    return;
  }
  vec2 off = d.xy * 0.0034;
  vec3 col = vec3(marble(vUv - off * 0.94).r, marble(vUv - off).g, marble(vUv - off * 1.06).b);
  float speed = length(d.xy) * 0.0024;
  col += uC3 * smoothstep(0.1, 1.2, speed) * 0.26;
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, opts, palette) => {
  const gl = env.gl;
  const format = floatTarget(gl);
  if (!format) throw new Error('float');
  const ink = opts.mode === 'ink';
  const simW = env.tier === 'low' ? 64 : env.tier === 'balanced' ? 96 : 128;
  const simH = Math.max(2, Math.round((simW * env.cssHeight) / Math.max(1, env.cssWidth)));
  const dyeW = ink ? (env.tier === 'low' ? 256 : 512) : simW * 2;
  const dyeH = Math.max(2, Math.round((dyeW * env.cssHeight) / Math.max(1, env.cssWidth)));
  const vel: Swap = makeSwap(gl, simW, simH, format);
  const dye: Swap = makeSwap(gl, dyeW, dyeH, format);
  const pressure: Swap = makeSwap(gl, simW, simH, format);
  const divergence: Target = makeTarget(gl, simW, simH, format);
  const advect = makeProgram(gl, FULLSCREEN_VS, ADVECT);
  const splat = makeProgram(gl, FULLSCREEN_VS, SPLAT);
  const diverge = makeProgram(gl, FULLSCREEN_VS, DIVERGE);
  const press = makeProgram(gl, FULLSCREEN_VS, PRESSURE);
  const subtract = makeProgram(gl, FULLSCREEN_VS, SUBTRACT);
  const accumulate = makeProgram(gl, FULLSCREEN_VS, ACCUMULATE);
  const vao = gl.createVertexArray();
  const aspect = env.cssWidth / Math.max(1, env.cssHeight);
  let lastU = -1;
  let lastV = -1;
  let autoPhase = Math.random() * 10;
  const tex = (unit: number, t: WebGLTexture, p: Program, name: string) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(p.u(name), unit);
  };
  const into = (t: Target) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const addSplat = (s: Swap, u: number, v: number, val: [number, number, number], r: number) => {
    gl.useProgram(splat.prog);
    tex(0, s.read.tex, splat, 'uSrc');
    gl.uniform2f(splat.u('uAt'), u, v);
    gl.uniform3f(splat.u('uVal'), val[0], val[1], val[2]);
    gl.uniform1f(splat.u('uR'), r);
    gl.uniform1f(splat.u('uAspect'), aspect);
    into(s.write);
    s.swap();
  };

  const step = (t: number, dt: number, field: WebGLTexture) => {
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    const p = env.pointer;
    const sdt = Math.min(dt, 1 / 30);
    autoPhase += sdt * 0.25;
    // Gentle autonomous stirring, so the flow lives while nobody touches it.
    const au = 0.5 + 0.42 * Math.sin(autoPhase * 1.3);
    const av = 0.5 + 0.38 * Math.sin(autoPhase * 0.9 + 1.7);
    addSplat(vel, au, av, [Math.cos(autoPhase * 2.1) * 90, Math.sin(autoPhase * 1.7) * 90, 0], 0.012);
    if (ink) {
      addSplat(dye, au, av, [0.07, 0.02 + 0.03 * Math.sin(t * 0.3), 0], 0.004);
      addSplat(vel, 1 - av, 1 - au, [Math.sin(autoPhase * 1.1) * 110, Math.cos(autoPhase * 2.3) * 110, 0], 0.012);
      addSplat(dye, 1 - av, 1 - au, [0.05, 0.1, 0], 0.003);
    }
    if (lastU >= 0 && p.strength > 0.001) {
      const dx = (p.u - lastU) * simW;
      const dy = (p.v - lastV) * simH;
      const moved = Math.hypot(dx, dy);
      if (moved > 0.01) {
        const force = 60 * p.strength;
        addSplat(vel, p.u, p.v, [dx * force, dy * force, 0], 0.0022);
        if (ink) addSplat(dye, p.u, p.v, [Math.min(0.7, moved * 0.09), Math.sin(t * 0.7) * 0.2 + 0.2, 0], 0.0016);
      }
    }
    lastU = p.u;
    lastV = p.v;
    for (const pulse of p.drainPulses()) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        addSplat(vel, pulse.u + Math.cos(a) * 0.012, pulse.v + Math.sin(a) * 0.02, [Math.cos(a) * 900, Math.sin(a) * 900, 0], 0.0012);
      }
    }
    gl.useProgram(diverge.prog);
    tex(0, vel.read.tex, diverge, 'uVel');
    gl.uniform2f(diverge.u('uTexel'), 1 / simW, 1 / simH);
    into(divergence);
    gl.useProgram(press.prog);
    gl.uniform2f(press.u('uTexel'), 1 / simW, 1 / simH);
    tex(1, divergence.tex, press, 'uDiv');
    const iterations = env.tier === 'low' ? 8 : 14;
    for (let i = 0; i < iterations; i++) {
      tex(0, pressure.read.tex, press, 'uP');
      into(pressure.write);
      pressure.swap();
    }
    gl.useProgram(subtract.prog);
    gl.uniform2f(subtract.u('uTexel'), 1 / simW, 1 / simH);
    tex(0, pressure.read.tex, subtract, 'uP');
    tex(1, vel.read.tex, subtract, 'uVel');
    tex(2, field, subtract, 'uField');
    into(vel.write);
    vel.swap();
    gl.useProgram(advect.prog);
    gl.uniform2f(advect.u('uTexel'), 1 / simW, 1 / simH);
    gl.uniform1f(advect.u('uDt'), sdt);
    tex(0, vel.read.tex, advect, 'uVel');
    tex(1, vel.read.tex, advect, 'uSrc');
    gl.uniform1f(advect.u('uKeep'), 0.992);
    into(vel.write);
    vel.swap();
    tex(0, vel.read.tex, advect, 'uVel');
    tex(1, dye.read.tex, advect, 'uSrc');
    gl.uniform1f(advect.u('uKeep'), ink ? 0.996 : 1);
    into(dye.write);
    dye.swap();
    if (!ink) {
      // The displacement is the velocity remembered, relaxing back: the painting always returns to itself.
      gl.useProgram(accumulate.prog);
      tex(0, dye.read.tex, accumulate, 'uDisp');
      tex(1, vel.read.tex, accumulate, 'uVel');
      gl.uniform1f(accumulate.u('uDt'), sdt * 1.4);
      into(dye.write);
      dye.swap();
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, env.width, env.height);
  };

  const instance = fragmentSpatial(env, bridge, palette, SHOW, {
    before(_g, p, t, dt) {
      step(t, dt, instance.field.texture);
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, dye.read.tex);
      gl.uniform1i(p.u('uDye'), 1);
      gl.uniform1f(p.u('uInk'), ink ? 1 : 0);
    },
    dispose() {
      [vel, dye, pressure].forEach((s) => {
        freeTarget(gl, s.read);
        freeTarget(gl, s.write);
      });
      freeTarget(gl, divergence);
      [advect, splat, diverge, press, subtract, accumulate].forEach((x) => gl.deleteProgram(x.prog));
      gl.deleteVertexArray(vao);
    },
    slabs: 0.9,
  });
  instance.warm = (seconds: number) => {
    instance.field.update();
    for (let i = 0; i < Math.min(40, seconds * 6); i++) step(i * 0.1, 1 / 30, instance.field.texture);
  };
  return instance;
};
export default make;
