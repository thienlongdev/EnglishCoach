import type { WorldEnv, WorldFactory } from '../types';
import { COMMON_UNIFORMS, FULLSCREEN_VS, NOISE_GLSL, bindTexture, darkEase, makeProgram, setCommon } from '../gl';

/**
 * Sakura Breeze. The landscape is painted once, in code, on the learner's device: mountains in atmospheric layers, a
 * temple, a lake and cherry trees of thousands of blossom strokes. Those paintings then live on the GPU: the lake shimmers
 * and reflects, the trees sway, far layers shift less than near ones. Petals are instanced quads with real wind:
 * every pointer movement is a gust that turns them. Dawn in light appearance, lantern-lit dusk in dark.
 */

type Layers = { back: HTMLCanvasElement; front: HTMLCanvasElement };

let seedValue = 7;
const rnd = () => {
  seedValue = (seedValue * 16807) % 2147483647;
  return (seedValue - 1) / 2147483646;
};

function mountain(ctx: CanvasRenderingContext2D, w: number, base: number, height: number, rough: number, colorTop: string, colorBottom: string, phase: number) {
  const grad = ctx.createLinearGradient(0, base - height, 0, base + 40);
  grad.addColorStop(0, colorTop);
  grad.addColorStop(1, colorBottom);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, base + 60);
  for (let x = 0; x <= w; x += 4) {
    const u = x / w;
    const y =
      base -
      height *
        (0.5 + 0.3 * Math.sin(u * 7.1 * rough + phase) + 0.14 * Math.sin(u * 17.3 * rough + phase * 2.1) + 0.06 * Math.sin(u * 43 * rough + phase * 3.7));
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, base + 60);
  ctx.closePath();
  ctx.fill();
}

function paintBack(w: number, h: number, night: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const horizon = h * 0.68;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  if (night) {
    sky.addColorStop(0, '#0e1236');
    sky.addColorStop(0.5, '#3a2a5f');
    sky.addColorStop(0.82, '#8d4a78');
    sky.addColorStop(1, '#e08a7a');
  } else {
    sky.addColorStop(0, '#9fc3ea');
    sky.addColorStop(0.44, '#e7cfe0');
    sky.addColorStop(0.8, '#fbd9c4');
    sky.addColorStop(1, '#ffe7c7');
  }
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // The sun low over the far range, with its bloom.
  const sx = w * 0.62;
  const sy = h * 0.42;
  const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, h * 0.55);
  glow.addColorStop(0, night ? 'rgba(255,190,170,0.55)' : 'rgba(255,240,205,0.85)');
  glow.addColorStop(0.2, night ? 'rgba(255,150,160,0.2)' : 'rgba(255,226,190,0.42)');
  glow.addColorStop(1, 'rgba(255,220,190,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = night ? '#ffd9c8' : '#fff4dc';
  ctx.beginPath();
  ctx.arc(sx, sy, h * 0.05, 0, Math.PI * 2);
  ctx.fill();

  // Long thin clouds.
  for (let i = 0; i < 26; i++) {
    const y = h * (0.06 + rnd() * 0.5);
    const x = rnd() * w;
    const len = w * (0.08 + rnd() * 0.24);
    const cloud = ctx.createLinearGradient(x - len, 0, x + len, 0);
    const tone = night ? '255,170,190' : '255,250,245';
    cloud.addColorStop(0, `rgba(${tone},0)`);
    cloud.addColorStop(0.5, `rgba(${tone},${0.05 + rnd() * 0.1})`);
    cloud.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = cloud;
    ctx.fillRect(x - len, y, len * 2, 1 + rnd() * 3);
  }

  // The great mountain, snow on its shoulders, far and pale.
  const mx = w * 0.72;
  const mTop = h * 0.2;
  const mBase = horizon + 6;
  const peak = ctx.createLinearGradient(0, mTop, 0, mBase);
  if (night) {
    peak.addColorStop(0, '#6d5a93');
    peak.addColorStop(1, '#a86a8c');
  } else {
    peak.addColorStop(0, '#a7b3d4');
    peak.addColorStop(1, '#ecc9d4');
  }
  ctx.fillStyle = peak;
  ctx.beginPath();
  ctx.moveTo(mx - w * 0.3, mBase);
  ctx.quadraticCurveTo(mx - w * 0.1, mTop + (mBase - mTop) * 0.34, mx - w * 0.018, mTop + 6);
  ctx.quadraticCurveTo(mx, mTop - 3, mx + w * 0.02, mTop + 7);
  ctx.quadraticCurveTo(mx + w * 0.1, mTop + (mBase - mTop) * 0.36, mx + w * 0.3, mBase);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = night ? 'rgba(236,222,250,0.82)' : 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.moveTo(mx - w * 0.052, mTop + (mBase - mTop) * 0.21);
  ctx.quadraticCurveTo(mx - w * 0.02, mTop + 2, mx, mTop);
  ctx.quadraticCurveTo(mx + w * 0.02, mTop + 2, mx + w * 0.055, mTop + (mBase - mTop) * 0.22);
  for (let i = 0; i <= 12; i++) {
    const u = 1 - i / 12;
    const x = mx - w * 0.052 + u * (w * 0.107);
    const y = mTop + (mBase - mTop) * (0.2 + (i % 2 === 0 ? 0.06 : 0) + rnd() * 0.04);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  // Ranges, with mist between them.
  const haze = (y: number, alpha: number) => {
    const g = ctx.createLinearGradient(0, y - h * 0.08, 0, y + h * 0.04);
    const tone = night ? '180,110,150' : '255,236,226';
    g.addColorStop(0, `rgba(${tone},0)`);
    g.addColorStop(1, `rgba(${tone},${alpha})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, y - h * 0.08, w, h * 0.12);
  };
  mountain(ctx, w, horizon + 2, h * 0.14, 0.9, night ? '#5c4a80' : '#b8c0d6', night ? '#7b527f' : '#e3cdd6', 1.2);
  haze(horizon, 0.55);
  mountain(ctx, w, horizon + 4, h * 0.07, 1.6, night ? '#3b305f' : '#8d9db0', night ? '#54406d' : '#c4c5c3', 4.4);
  haze(horizon + 4, 0.34);

  // The temple on the far shore, its lights on at dusk.
  drawTemple(ctx, w * 0.84, horizon + 2, h * 0.17, night);

  // The water: the painted sky, mirrored (the shader shakes it). Then the near shore.
  ctx.save();
  ctx.translate(0, horizon * 2);
  ctx.scale(1, -1);
  ctx.globalAlpha = 0.62;
  ctx.drawImage(canvas, 0, 0, w, horizon, 0, 0, w, horizon);
  ctx.restore();
  const water = ctx.createLinearGradient(0, horizon, 0, h);
  water.addColorStop(0, night ? 'rgba(40,24,70,0.12)' : 'rgba(255,240,235,0.08)');
  water.addColorStop(1, night ? 'rgba(10,10,40,0.82)' : 'rgba(136,160,190,0.5)');
  ctx.fillStyle = water;
  ctx.fillRect(0, horizon, w, h - horizon);
  // scattered blossoms on the water
  for (let i = 0; i < 300; i++) {
    const y = horizon + Math.pow(rnd(), 0.6) * (h - horizon);
    const x = rnd() * w;
    const s = 0.6 + ((y - horizon) / (h - horizon)) * 3;
    ctx.fillStyle = night ? `rgba(240,170,200,${0.3 + rnd() * 0.3})` : `rgba(250,180,200,${0.4 + rnd() * 0.3})`;
    ctx.beginPath();
    ctx.ellipse(x, y, s * 1.5, s * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

function drawTemple(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, night: boolean) {
  const body = night ? '#20163c' : '#6a5a6a';
  const roof = night ? '#150f2a' : '#4c4258';
  const tiers = 4;
  let w = size * 0.24;
  let top = y - size * 0.02;
  ctx.fillStyle = body;
  ctx.fillRect(x - w * 0.62, y - size * 0.05, w * 1.24, size * 0.05);
  for (let i = 0; i < tiers; i++) {
    const h = size * (0.13 - i * 0.012);
    ctx.fillStyle = body;
    ctx.fillRect(x - w * 0.42, top - h, w * 0.84, h);
    if (night) {
      ctx.fillStyle = 'rgba(255,190,120,0.9)';
      for (let k = -1; k <= 1; k++) ctx.fillRect(x + k * w * 0.24 - 1.5, top - h * 0.7, 3, h * 0.42);
    }
    top -= h;
    ctx.fillStyle = roof;
    ctx.beginPath();
    ctx.moveTo(x - w * 0.86, top + size * 0.016);
    ctx.quadraticCurveTo(x - w * 0.44, top - size * 0.004, x - w * 0.28, top - size * 0.026);
    ctx.lineTo(x + w * 0.28, top - size * 0.026);
    ctx.quadraticCurveTo(x + w * 0.44, top - size * 0.004, x + w * 0.86, top + size * 0.016);
    ctx.closePath();
    ctx.fill();
    top -= size * 0.022;
    w *= 0.82;
  }
  ctx.fillStyle = roof;
  ctx.fillRect(x - 1.2, top - size * 0.08, 2.4, size * 0.08);
}

function branch(ctx: CanvasRenderingContext2D, tips: [number, number, number][], x: number, y: number, len: number, ang: number, depth: number, width: number, bark: string) {
  const bend = (rnd() - 0.5) * 0.5;
  const x1 = x + Math.cos(ang) * len;
  const y1 = y + Math.sin(ang) * len;
  const cx = x + Math.cos(ang + bend) * len * 0.5;
  const cy = y + Math.sin(ang + bend) * len * 0.5;
  ctx.strokeStyle = bark;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.quadraticCurveTo(cx, cy, x1, y1);
  ctx.stroke();
  if (depth > 3) tips.push([cx, cy, depth]);
  if (depth >= 7 || len < 10) {
    tips.push([x1, y1, depth]);
    return;
  }
  const kids = depth < 2 ? 2 : rnd() > 0.34 ? 2 : 3;
  for (let i = 0; i < kids; i++) {
    const f = i / (kids - 1) - 0.5;
    branch(ctx, tips, x1, y1, len * (0.68 + rnd() * 0.18), ang + f * (0.72 + rnd() * 0.5) + (rnd() - 0.5) * 0.2, depth + 1, width * 0.66, bark);
  }
}

function blossom(ctx: CanvasRenderingContext2D, tips: [number, number, number][], night: boolean, scale: number) {
  const deep = night ? ['#7b3f78', '#964f8a', '#a35c92'] : ['#e692ae', '#efa4bd', '#f2b2c8'];
  const main = night ? ['#c66d9b', '#d681a9', '#e49abb'] : ['#f6bdd0', '#f9cadb', '#fbd4e2'];
  const lit = night ? ['#f0b5cd', '#f7cbd9'] : ['#fff0f4', '#ffe4ec', '#fff8f8'];
  // Volume first: soft shadow masses, then the mid tone, then lit strokes from above.
  for (const [x, y] of tips) {
    const r = (22 + rnd() * 26) * scale;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, night ? 'rgba(110,50,110,0.55)' : 'rgba(232,140,172,0.6)');
    g.addColorStop(1, 'rgba(232,140,172,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const layer = (palette: string[], count: number, spread: number, size: number, lift: number) => {
    for (const [x, y] of tips) {
      for (let i = 0; i < count; i++) {
        const a = rnd() * Math.PI * 2;
        const d = Math.pow(rnd(), 0.6) * spread * scale;
        const px = x + Math.cos(a) * d;
        const py = y + Math.sin(a) * d * 0.8 - lift * scale;
        ctx.fillStyle = palette[(rnd() * palette.length) | 0];
        ctx.globalAlpha = 0.68 + rnd() * 0.32;
        ctx.beginPath();
        ctx.ellipse(px, py, (size * (0.6 + rnd() * 0.8)) * scale, (size * (0.4 + rnd() * 0.5)) * scale, rnd() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  };
  layer(deep, 12, 30, 3.6, -3);
  layer(main, 15, 27, 2.9, 1);
  layer(lit, 6, 22, 2, 7);
}

function paintFront(w: number, h: number, night: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const bark = night ? '#17101f' : '#3d2c33';
  const scale = w / 1920;
  // A large tree rising at the left, reaching over the top of the scene.
  const left: [number, number, number][] = [];
  branch(ctx, left, w * 0.25, h * 1.04, h * 0.3, -Math.PI / 2 + 0.03, 0, 54 * scale, bark);
  branch(ctx, left, w * 0.25, h * 0.72, h * 0.26, -Math.PI / 2 + 0.9, 2, 16 * scale, bark);
  branch(ctx, left, w * 0.25, h * 0.68, h * 0.22, -Math.PI / 2 - 0.7, 2, 14 * scale, bark);
  blossom(ctx, left, night, scale * 1.08);
  // A bough from the top-right corner.
  const right: [number, number, number][] = [];
  branch(ctx, right, w * 1.03, h * 0.02, h * 0.3, Math.PI - 0.4, 2, 20 * scale, bark);
  branch(ctx, right, w * 0.92, h * -0.04, h * 0.26, Math.PI / 2 + 0.4, 2, 14 * scale, bark);
  blossom(ctx, right, night, scale);
  // Near shore: dark stones, grass.
  const shore = ctx.createLinearGradient(0, h * 0.86, 0, h);
  shore.addColorStop(0, night ? 'rgba(20,14,36,0)' : 'rgba(58,70,62,0)');
  shore.addColorStop(1, night ? 'rgba(10,8,22,1)' : 'rgba(58,70,62,1)');
  ctx.fillStyle = shore;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.86);
  for (let x = 0; x <= w; x += 12) {
    const u = x / w;
    ctx.lineTo(x, h * (0.92 + 0.03 * Math.sin(u * 9 + 1) + 0.012 * Math.sin(u * 37)) - Math.max(0, 0.42 - u) * h * 0.1);
  }
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  return canvas;
}

function paint(env: WorldEnv, night: boolean): Layers {
  seedValue = 7;
  const w = env.tier === 'high' ? 2048 : env.tier === 'balanced' ? 1600 : 1152;
  const aspect = Math.max(1.2, env.cssWidth / env.cssHeight);
  const h = Math.round(w / aspect);
  return { back: paintBack(w, h, night), front: paintFront(w, h, night) };
}

const SCENE = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uBack;
uniform sampler2D uFront;
uniform float uGust;
${COMMON_UNIFORMS}
${NOISE_GLSL}
void main() {
  vec2 uv = vUv;
  vec2 par = (uMouse - 0.5) * uStrength;
  float horizon = 0.32;
  // Back: a little parallax; the water below the far shore is shaken.
  vec2 b = uv + vec2(par.x * 0.006, par.y * 0.003);
  float isWater = smoothstep(horizon + 0.002, horizon - 0.002, uv.y);
  float depth = clamp((horizon - uv.y) / horizon, 0.0, 1.0);
  float wave = gnoise(vec2(uv.x * 34.0, uv.y * 180.0 / (0.3 + depth) + uTime * 0.7));
  float wave2 = gnoise(vec2(uv.x * 12.0, uv.y * 70.0 / (0.3 + depth) - uTime * 0.5));
  b.x += (wave * 0.004 + wave2 * 0.005) * (0.4 + depth * 1.4) * isWater;
  b.y += wave2 * 0.012 * depth * isWater;
  vec3 col = texture(uBack, vec2(b.x, 1.0 - b.y)).rgb;
  // a glitter road under the sun
  float lane = exp(-abs(uv.x - 0.62) * (6.0 - depth * 3.0));
  float glint = pow(max(0.0, gnoise(vec2(uv.x * 70.0, uv.y * 300.0 + uTime * 0.9))), 2.5) * 7.0;
  col += mix(vec3(1.0, 0.9, 0.74), vec3(1.0, 0.72, 0.66), uDark) * lane * glint * isWater * (0.7 - depth * 0.4);
  // Sun haze that drifts across the mountains.
  float m = fbm3(vec2(uv.x * 3.0 - uTime * 0.02, uv.y * 11.0));
  col += mix(vec3(0.05, 0.04, 0.03), vec3(0.05, 0.02, 0.05), uDark) * smoothstep(0.4, 0.8, m) * smoothstep(0.2, 0.34, uv.y) * smoothstep(0.62, 0.3, uv.y);

  // Front: boughs sway with a wind that travels; gusts add to it. Trunks stay rooted: motion grows with height.
  vec2 f = uv + vec2(par.x * 0.022, par.y * 0.008);
  float height = smoothstep(0.02, 0.9, uv.y);
  float sway = sin(uTime * 0.7 + uv.y * 4.0 + uv.x * 3.0) * 0.0022 + gnoise(vec2(uv.x * 4.0 + uTime * 0.34, uv.y * 4.0)) * 0.005;
  float fine = gnoise(uv * 40.0 + uTime * 0.8) * 0.0009;
  f.x += (sway * (1.0 + uGust * 3.0) + uGust * 0.006 * sign(uVel.x + 0.001)) * height + fine;
  f.y += gnoise(vec2(uv.x * 6.0 - uTime * 0.3, uv.y * 3.0)) * 0.0022 * height * (1.0 + uGust);
  vec4 front = texture(uFront, vec2(f.x, 1.0 - f.y));
  col = mix(col, front.rgb, front.a);

  // Dust motes in the low sun.
  vec2 g = uv * vec2(uRes.x / uRes.y, 1.0) * 48.0 + vec2(uTime * 0.14, uTime * 0.1);
  vec2 id = floor(g);
  float mote = step(0.97, hash21(id)) * smoothstep(0.3, 0.0, length(fract(g) - 0.5));
  col += mix(vec3(0.34, 0.3, 0.22), vec3(0.2, 0.14, 0.2), uDark) * mote;
  // a gentle vignette that keeps the corners calm
  vec2 v = uv - 0.5;
  col *= 1.0 - dot(v, v) * mix(0.1, 0.5, uDark);
  outColor = vec4(col, 1.0);
}`;

const PETAL_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aInst;
layout(location = 1) in vec3 aMisc;
out vec2 vQuad;
out float vShade;
out float vTone;
uniform float uAspect;
const vec2 Q[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1), vec2(-1,-1), vec2(1,1), vec2(-1,1));
void main() {
  vec2 q = Q[gl_VertexID];
  vQuad = q;
  // a petal tumbles: its width narrows and flips as it turns in the air
  float flip = cos(aMisc.x);
  float rot = aInst.z;
  vec2 size = vec2(aInst.w, aInst.w * (0.28 + 0.72 * abs(flip)));
  vec2 p = vec2(q.x * size.x, q.y * size.y);
  p = mat2(cos(rot), -sin(rot), sin(rot), cos(rot)) * p;
  gl_Position = vec4((aInst.x + p.x / uAspect) * 2.0 - 1.0, (aInst.y + p.y) * 2.0 - 1.0, 0.0, 1.0);
  vShade = 0.72 + 0.34 * abs(flip);
  vTone = aMisc.y;
}`;
const PETAL_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vQuad;
in float vShade;
in float vTone;
out vec4 outColor;
uniform float uDark;
void main() {
  // the outline of a cherry petal: a soft oval with a notch at its tip
  vec2 p = vQuad;
  float body = 1.0 - smoothstep(0.82, 1.0, length(vec2(p.x * 1.45, p.y)));
  float notch = smoothstep(0.0, 0.18, length(p - vec2(0.0, 1.0)) - 0.2);
  float a = body * notch;
  if (a < 0.01) discard;
  vec3 light = mix(vec3(1.0, 0.86, 0.9), vec3(0.96, 0.72, 0.84), uDark);
  vec3 deep = mix(vec3(0.97, 0.66, 0.76), vec3(0.74, 0.42, 0.66), uDark);
  vec3 c = mix(deep, light, vTone) * vShade;
  c = mix(c, c * 0.84, smoothstep(0.1, 0.9, -p.y));
  outColor = vec4(c * a * 0.95, a * 0.95);
}`;

const factory: WorldFactory = async (env) => {
  const gl = env.gl;
  const scene = makeProgram(gl, FULLSCREEN_VS, SCENE);
  const petals = makeProgram(gl, PETAL_VS, PETAL_FS);
  const vao = gl.createVertexArray();

  let paintedDark = env.params.dark;
  const makeTex = (source: HTMLCanvasElement) => {
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  };
  let layers = paint(env, paintedDark);
  let backTex = makeTex(layers.back);
  let frontTex = makeTex(layers.front);
  layers.back.width = 1;
  layers.front.width = 1;

  // Petals: positions live in a typed array and are stepped here. The pointer only adds force.
  const count = env.tier === 'high' ? 900 : env.tier === 'balanced' ? 480 : 200;
  const inst = new Float32Array(count * 4); // u, v, rotation, size
  const misc = new Float32Array(count * 3); // flip phase, tone, depth
  const vel = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    inst[i * 4] = Math.random() * 1.2 - 0.1;
    inst[i * 4 + 1] = Math.random() * 1.1;
    inst[i * 4 + 2] = Math.random() * 6.28;
    const depth = Math.random();
    inst[i * 4 + 3] = (0.0026 + depth * depth * 0.0052) * (1 + Math.random() * 0.3);
    misc[i * 3] = Math.random() * 6.28;
    misc[i * 3 + 1] = Math.random();
    misc[i * 3 + 2] = depth;
  }
  const instBuffer = gl.createBuffer();
  const miscBuffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, miscBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, misc, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.bindVertexArray(null);

  let dark = env.params.dark ? 1 : 0;
  let gust = 0;
  let windX = 0;
  let windY = 0;

  const stepPetals = (dt: number, t: number) => {
    const p = env.pointer;
    const aspect = env.cssWidth / env.cssHeight;
    const blow = 0.022 + 0.012 * Math.sin(t * 0.17) + 0.01 * Math.sin(t * 0.41);
    windX += (p.vx * 0.08 * p.strength - windX) * Math.min(1, dt * 2.2);
    windY += (p.vy * 0.05 * p.strength - windY) * Math.min(1, dt * 2.2);
    for (let i = 0; i < count; i++) {
      const j = i * 4;
      const depth = misc[i * 3 + 2];
      const x = inst[j];
      const y = inst[j + 1];
      const flutter = Math.sin(t * 0.8 + misc[i * 3] + y * 7) * 0.012;
      let ax = (blow * (0.5 + depth) + flutter - vel[i * 2]) * 1.4 + windX * (0.4 + depth);
      let ay = (-0.022 * (0.6 + depth) + Math.cos(t * 0.6 + misc[i * 3] * 2 + x * 9) * 0.006 - vel[i * 2 + 1]) * 1.4 + windY * (0.4 + depth);
      if (p.strength > 0.01) {
        const dx = (x - p.su) * aspect;
        const dy = y - p.sv;
        const d2 = dx * dx + dy * dy;
        if (d2 < 0.05) {
          const fall = 1 - d2 / 0.05;
          ax += ((p.vx * 0.16 + (dx / (Math.sqrt(d2) + 0.01)) * p.energy * 0.16) * fall * p.strength) / aspect;
          ay += (p.vy * 0.16 + (dy / (Math.sqrt(d2) + 0.01)) * p.energy * 0.16) * fall * p.strength;
        }
      }
      vel[i * 2] += ax * dt;
      vel[i * 2 + 1] += ay * dt;
      inst[j] += vel[i * 2] * dt;
      inst[j + 1] += vel[i * 2 + 1] * dt;
      inst[j + 2] += dt * (0.3 + depth * 1.2) * (i % 2 ? 1 : -1) + vel[i * 2] * dt * 4;
      misc[i * 3] += dt * (1.1 + depth * 1.8 + Math.abs(vel[i * 2]) * 14);
      if (inst[j + 1] < -0.03) {
        inst[j + 1] = 1.03;
        inst[j] = Math.random() * 1.2 - 0.2;
      }
      if (inst[j] > 1.08) inst[j] = -0.08;
      if (inst[j] < -0.12) inst[j] = 1.06;
    }
  };

  return {
    warm(seconds) {
      for (let i = 0; i < Math.min(60, seconds * 8); i++) stepPetals(1 / 8, i / 8);
    },
    frame(t, dt) {
      dark = darkEase(dark, env.params.dark, dt);
      // A change of appearance repaints the landscape (a one-off cost; there is no per-frame painting).
      if (paintedDark !== env.params.dark) {
        paintedDark = env.params.dark;
        const next = paint(env, paintedDark);
        gl.deleteTexture(backTex);
        gl.deleteTexture(frontTex);
        backTex = makeTex(next.back);
        frontTex = makeTex(next.front);
        next.back.width = 1;
        next.front.width = 1;
        layers = next;
      }
      if (dt > 0) stepPetals(Math.min(dt, 1 / 20), t);
      const wanted = env.pointer.energy;
      gust += (wanted - gust) * Math.min(1, dt * (wanted > gust ? 4 : 0.8));

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, env.width, env.height);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(vao);
      gl.useProgram(scene.prog);
      setCommon(gl, scene, env, t, paintedDark ? 1 : 0);
      bindTexture(gl, 0, backTex, scene.u('uBack'));
      bindTexture(gl, 1, frontTex, scene.u('uFront'));
      gl.uniform1f(scene.u('uGust'), gust);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(petals.prog);
      gl.uniform1f(petals.u('uAspect'), env.cssWidth / env.cssHeight);
      gl.uniform1f(petals.u('uDark'), paintedDark ? 1 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst);
      gl.bindBuffer(gl.ARRAY_BUFFER, miscBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, misc);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    },
    resize() {},
    dispose() {
      gl.deleteTexture(backTex);
      gl.deleteTexture(frontTex);
      gl.deleteBuffer(instBuffer);
      gl.deleteBuffer(miscBuffer);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(scene.prog);
      gl.deleteProgram(petals.prog);
    },
    pixels: 0.8,
  };
};

export default factory;
