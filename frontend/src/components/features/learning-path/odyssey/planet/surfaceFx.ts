/* Echo Living Planet — how the surface answers the learner's pointer: a reticle that lies on the ground under the pointer,
   a ring that opens where they touched, a few birds lifting from a forest, a puff of dust or snow sparkle on a mountain,
   petals over a meadow, chimney smoke over a village, ripples on the sea (materials.ts uRipple) and an eruption of the
   volcano (world.ts). Three draw calls at most, all animated in shaders from one start time: no per-frame CPU work but
   uniforms, nothing drawn when idle, nothing under reduced motion except the still reticle. */
import * as THREE from 'three';
import type { Response } from '@/lib/odyssey/planet/surface';
import { shared } from './materials';

const N = 30;
const MODE: Record<Exclude<Response, 'ripple' | 'erupt' | 'pulse'>, number> = { birds: 0, dust: 1, petals: 2, sparkle: 3, smoke: 4 };
// pale birds (egret-like) read over a dark canopy and over the sky alike
const COLOR: Record<Exclude<Response, 'ripple' | 'erupt' | 'pulse'>, string> = { birds: '#f3f7fb', dust: '#d8c7a6', petals: '#ffb6d2', sparkle: '#e9f6ff', smoke: '#c9ccd2' };
const LIFE: Record<Exclude<Response, 'ripple' | 'erupt' | 'pulse'>, number> = { birds: 3.6, dust: 2.2, petals: 3.2, sparkle: 1.8, smoke: 4.2 };

const RING_VS = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RING_FS = /* glsl */ `precision mediump float; varying vec2 vUv;
  uniform vec3 uColor; uniform float uOpacity; uniform float uTime; uniform float uMotion; uniform float uMode;
  void main(){
    vec2 p = vUv * 2.0 - 1.0; float r = length(p);
    if (r > 1.0) discard;
    float a = 0.0;
    if (uMode < 0.5) {
      // reticle: a soft ring, four short ticks that turn slowly, a faint centre
      float ring = smoothstep(0.07, 0.0, abs(r - 0.74));
      float ang = atan(p.y, p.x) + uTime * 0.5 * uMotion;
      float ticks = smoothstep(0.86, 0.98, abs(cos(ang * 2.0))) * smoothstep(0.12, 0.0, abs(r - 0.9));
      float centre = smoothstep(0.16, 0.0, r) * 0.55;
      a = max(ring * 0.95, max(ticks * 0.85, centre));
    } else {
      // pulse: one bright ring opening outwards (uOpacity carries the fade)
      a = smoothstep(0.1, 0.0, abs(r - 0.92)) + smoothstep(0.55, 1.0, r) * 0.18;
    }
    gl_FragColor = vec4(uColor, a * uOpacity);
  }`;

const BURST_VS = /* glsl */ `attribute vec4 aSeed; uniform float uTime; uniform float uStart; uniform float uLife; uniform float uMode; uniform vec3 uOrigin; uniform vec3 uUp;
  uniform vec3 uEast; uniform vec3 uNorth; uniform float uScale; uniform float uSize; varying float vAlpha; varying float vSeed;
  void main(){
    float age = uTime - uStart - aSeed.w * (uMode < 0.5 ? 0.5 : 0.35);
    float t = clamp(age / uLife, 0.0, 1.0);
    vec3 p = uOrigin;
    float a = aSeed.x * 6.2831853;
    vec2 dir = vec2(cos(a), sin(a));
    if (uMode < 0.5) {            // birds: lift off, wheel away together, wings beating (fragment)
      float rise = 3.4 * (1.0 - pow(1.0 - t, 2.0)) + aSeed.y * 1.2;
      float out_ = 1.2 + t * 7.0 * (0.6 + aSeed.z * 0.6);
      vec2 flock = vec2(cos(a * 0.25 + 1.0), sin(a * 0.25 + 1.0));
      vec2 xy = dir * (0.35 + aSeed.y * 0.9) + flock * out_ * t;
      p += uUp * (0.5 + rise) + uEast * xy.x + uNorth * xy.y;
    } else if (uMode < 1.5) {     // dust: a low cloud rolling outwards
      vec2 xy = dir * (0.3 + t * (1.6 + aSeed.y * 1.4));
      p += uUp * (0.2 + t * 0.9 * aSeed.z) + uEast * xy.x + uNorth * xy.y;
    } else if (uMode < 2.5) {     // petals: drifting up and sideways, swaying
      vec2 xy = dir * (0.4 + t * 2.4 * aSeed.y) + vec2(sin(age * 3.0 + aSeed.z * 6.0), cos(age * 2.4 + aSeed.y * 5.0)) * 0.35;
      p += uUp * (0.3 + t * 2.6 * (0.5 + aSeed.z)) + uEast * xy.x + uNorth * xy.y;
    } else if (uMode < 3.5) {     // sparkle: points glinting in place around the touch
      vec2 xy = dir * (0.4 + aSeed.y * 1.8);
      p += uUp * (0.2 + aSeed.z * 1.2 + t * 0.4) + uEast * xy.x + uNorth * xy.y;
    } else {                      // smoke: rising and widening over the roofs
      vec2 xy = dir * (0.1 + t * 0.9 * aSeed.y) + vec2(t * t * 1.4, 0.0);
      p += uUp * (0.6 + t * 3.8 * (0.7 + aSeed.z * 0.5)) + uEast * xy.x + uNorth * xy.y;
    }
    float fadeIn = smoothstep(0.0, 0.08, t), fadeOut = 1.0 - smoothstep(0.62, 1.0, t);
    vAlpha = (age < 0.0 || age > uLife) ? 0.0 : fadeIn * fadeOut;
    if (uMode > 2.5 && uMode < 3.5) vAlpha *= 0.5 + 0.5 * sin(age * 14.0 + aSeed.x * 30.0);
    vSeed = aSeed.x;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float grow = uMode > 3.5 ? 1.0 + t * 2.2 : uMode > 0.5 && uMode < 1.5 ? 1.0 + t * 1.6 : 1.0;
    // ~10 px for a bird seen from a region's height (≈ 50 units), larger up close, never a giant blot
    gl_PointSize = min(64.0, uSize * grow * uScale * 900.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }`;
const BURST_FS = /* glsl */ `precision highp float; uniform vec3 uColor; uniform float uMode; uniform float uTime; varying float vAlpha; varying float vSeed;
  float seg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
  void main(){
    if (vAlpha <= 0.01) discard;
    vec2 q = gl_PointCoord * 2.0 - 1.0; q.y = -q.y;
    float a;
    if (uMode < 0.5) {            // a bird: two wings that beat
      float beat = sin(uTime * 13.0 + vSeed * 40.0) * 0.45;
      float d = min(seg(q, vec2(0.0, -0.05), vec2(-0.85, 0.25 + beat)), seg(q, vec2(0.0, -0.05), vec2(0.85, 0.25 + beat)));
      a = smoothstep(0.16, 0.05, d);
    } else if (uMode > 1.5 && uMode < 2.5) { // a petal
      float d = length(q * vec2(1.0, 1.7));
      a = smoothstep(0.95, 0.55, d);
    } else {
      float r = length(q);
      a = uMode > 3.5 ? smoothstep(1.0, 0.0, r) * 0.55 : uMode > 2.5 ? smoothstep(1.0, 0.0, r) * (0.7 + 0.3 * smoothstep(0.2, 0.0, abs(q.x) * abs(q.y) * 6.0)) : smoothstep(1.0, 0.1, r) * 0.6;
    }
    gl_FragColor = vec4(uColor, a * vAlpha);
  }`;

export class SurfaceFx {
  readonly root = new THREE.Group();
  private reticle: THREE.Mesh;
  private reticleMat: THREE.ShaderMaterial;
  private pulse: THREE.Mesh;
  private pulseMat: THREE.ShaderMaterial;
  private pulseStart = -1e9; private pulseSize = 2;
  private burst: THREE.Points;
  private burstMat: THREE.ShaderMaterial;
  private burstUntil = -1e9;
  private rippleSlot = 0;
  private hoverTarget = 0;

  constructor() {
    const plane = new THREE.PlaneGeometry(2, 2);
    this.reticleMat = new THREE.ShaderMaterial({ vertexShader: RING_VS, fragmentShader: RING_FS, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color('#ffffff') }, uOpacity: { value: 0 }, uTime: shared.uTime, uMotion: { value: 1 }, uMode: { value: 0 } } });
    this.reticle = new THREE.Mesh(plane, this.reticleMat); this.reticle.renderOrder = 30; this.reticle.visible = false; this.reticle.frustumCulled = false;
    this.pulseMat = new THREE.ShaderMaterial({ vertexShader: RING_VS, fragmentShader: RING_FS, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color('#ffffff') }, uOpacity: { value: 0 }, uTime: shared.uTime, uMotion: { value: 1 }, uMode: { value: 1 } } });
    this.pulse = new THREE.Mesh(plane, this.pulseMat); this.pulse.renderOrder = 31; this.pulse.visible = false; this.pulse.frustumCulled = false;
    const g = new THREE.BufferGeometry(), seeds = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) { const h = (k: number) => { const x = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }; seeds.set([h(1), h(2), h(3), h(4)], i * 4); }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.burstMat = new THREE.ShaderMaterial({ vertexShader: BURST_VS, fragmentShader: BURST_FS, transparent: true, depthWrite: false,
      uniforms: { uTime: shared.uTime, uStart: { value: -1e9 }, uLife: { value: 3 }, uMode: { value: 0 }, uOrigin: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3(0, 1, 0) },
        uEast: { value: new THREE.Vector3(1, 0, 0) }, uNorth: { value: new THREE.Vector3(0, 0, 1) }, uScale: { value: 1 }, uSize: { value: 0.5 }, uColor: { value: new THREE.Color('#ffffff') } } });
    this.burst = new THREE.Points(g, this.burstMat); this.burst.frustumCulled = false; this.burst.renderOrder = 29; this.burst.visible = false;
    this.root.add(this.reticle, this.pulse, this.burst);
  }

  private place(m: THREE.Mesh, point: THREE.Vector3, up: THREE.Vector3, size: number, lift: number) {
    m.position.copy(point).addScaledVector(up, lift);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    m.scale.setScalar(size);
  }

  /** The reticle under the pointer (null hides it). `size` in world units. */
  hover(point: THREE.Vector3 | null, up: THREE.Vector3 | null, color: string, size: number) {
    if (!point || !up) { this.hoverTarget = 0; return; }
    this.place(this.reticle, point, up, size, 0.08);
    this.reticleMat.uniforms.uColor.value.set(color);
    this.reticle.visible = true; this.hoverTarget = 1;
  }

  /** The planet's answer to a touch at this point. Returns true when something will animate (the caller keeps drawing). */
  respond(kind: Response, point: THREE.Vector3, up: THREE.Vector3, color: string, size: number, time: number, reduced: boolean): boolean {
    this.pulseStart = time; this.pulseSize = size * 1.6;
    this.place(this.pulse, point, up, size, 0.1);
    this.pulseMat.uniforms.uColor.value.set(color);
    this.pulse.visible = !reduced;
    if (reduced) return false;
    if (kind === 'ripple') {
      const u = this.rippleSlot === 0 ? shared.uRipple0 : shared.uRipple1;
      this.rippleSlot = 1 - this.rippleSlot;
      u.value.set(up.x, up.y, up.z, time);
    } else if (kind !== 'erupt' && kind !== 'pulse') {
      const e = new THREE.Vector3().crossVectors(Math.abs(up.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), up).normalize(), n = new THREE.Vector3().crossVectors(up, e);
      const u = this.burstMat.uniforms;
      u.uOrigin.value.copy(point); u.uUp.value.copy(up); u.uEast.value.copy(e); u.uNorth.value.copy(n);
      u.uStart.value = time; u.uMode.value = MODE[kind]; u.uLife.value = LIFE[kind]; u.uColor.value.set(COLOR[kind]);
      u.uSize.value = kind === 'birds' ? 0.95 : kind === 'smoke' ? 0.9 : kind === 'dust' ? 0.8 : kind === 'petals' ? 0.38 : 0.34;
      this.burst.visible = true; this.burstUntil = time + LIFE[kind] + 0.6;
    }
    return true;
  }

  /** Per frame (cheap): the reticle fades in and out, the pulse opens, the burst ends. True while anything still moves. */
  update(time: number, dt: number, pixelRatio: number, reduced: boolean): boolean {
    const u = this.reticleMat.uniforms;
    u.uMotion.value = reduced ? 0 : 1;
    const o = u.uOpacity.value as number, target = this.hoverTarget * 0.9;
    u.uOpacity.value = reduced ? target : o + (target - o) * Math.min(1, dt * 12);
    if (u.uOpacity.value < 0.01 && this.hoverTarget === 0) this.reticle.visible = false;
    let moving = Math.abs(target - (u.uOpacity.value as number)) > 0.01 || (this.reticle.visible && !reduced);
    const age = time - this.pulseStart;
    if (this.pulse.visible) {
      const k = Math.min(1, age / 1.1);
      this.pulse.scale.setScalar(this.pulseSize * (0.35 + 0.9 * (1 - Math.pow(1 - k, 3))));
      this.pulseMat.uniforms.uOpacity.value = (1 - k) * 0.9;
      if (k >= 1) this.pulse.visible = false; else moving = true;
    }
    this.burstMat.uniforms.uScale.value = pixelRatio;
    if (this.burst.visible) { if (time > this.burstUntil || reduced) this.burst.visible = false; else moving = true; }
    for (const r of [shared.uRipple0, shared.uRipple1]) if (time - r.value.w < 4.6) moving = true;
    return moving;
  }

  dispose() {
    this.reticle.geometry.dispose(); this.reticleMat.dispose(); this.pulseMat.dispose();
    this.burst.geometry.dispose(); this.burstMat.dispose();
    this.root.clear();
  }
}
