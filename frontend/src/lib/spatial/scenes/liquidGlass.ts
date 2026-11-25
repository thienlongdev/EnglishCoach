import type { SpatialSceneFactory } from '../types';
import { SPATIAL_FS_HEAD, fragmentSpatial, makeWave } from './kit';

/**
 * B01 / I04 Liquid Glass. A thick pane over a deep backdrop. The surface is a real discrete wave equation, and the DOM cards are walls
 * in it, so a ripple started by the pointer travels, hits a card and comes back. Refraction with per-channel offsets, a key light
 * from the pointer side, fresnel from the slope.
 */
const FS = /* glsl */ `${SPATIAL_FS_HEAD}
uniform sampler2D uWave;
uniform vec2 uTexel;
uniform float uDeep;
vec3 backdrop(vec2 p) {
  float a = uCss.x / uCss.y;
  vec2 q = vec2(p.x * a, p.y);
  float f = fbm3(q * 1.5 + vec2(uTime * 0.03, -uTime * 0.02));
  float g = fbm3(q * 3.1 - vec2(uTime * 0.02, f));
  vec3 col = mix(uC0, uC1, smoothstep(0.15, 0.8, f + p.y * 0.25));
  col = mix(col, uC2, smoothstep(0.52, 0.86, g) * 0.42);
  float band = sin((q.x + q.y * 0.6 + f * 1.6) * 9.0 + uTime * 0.1);
  col += uC3 * smoothstep(0.86, 1.0, band) * 0.16 * (0.5 + 0.5 * uDark);
  return col;
}
void main() {
  float h = texture(uWave, vUv).r;
  float dx = texture(uWave, vUv + vec2(uTexel.x, 0.0)).r - texture(uWave, vUv - vec2(uTexel.x, 0.0)).r;
  float dy = texture(uWave, vUv + vec2(0.0, uTexel.y)).r - texture(uWave, vUv - vec2(0.0, uTexel.y)).r;
  // slow swell of the glass itself, so the pane is alive when nobody touches it
  float a = uCss.x / uCss.y;
  vec2 q = vec2(vUv.x * a, vUv.y);
  dx += (gnoise(q * 3.0 + uTime * 0.09) - gnoise(q * 3.0 + vec2(0.02, 0.0) + uTime * 0.09)) * 0.09;
  dy += (gnoise(q * 3.0 - uTime * 0.07) - gnoise(q * 3.0 + vec2(0.0, 0.02) - uTime * 0.07)) * 0.09;
  vec3 n = normalize(vec3(-dx * 7.0, -dy * 7.0, 1.0));
  float bend = (0.09 + 0.14 * uMaterial) * (1.0 + uDeep);
  vec3 col = vec3(backdrop(vUv + n.xy * bend * 0.92).r, backdrop(vUv + n.xy * bend).g, backdrop(vUv + n.xy * bend * 1.08).b);
  vec2 lp = uMouse - vUv;
  vec3 l = normalize(vec3(lp * vec2(a, 1.0), 0.55));
  float spec = pow(max(dot(reflect(-l, n), vec3(0.0, 0.0, 1.0)), 0.0), 60.0);
  float fres = pow(1.0 - n.z, 1.4);
  col += mix(vec3(1.0), uC3, 0.35) * spec * (0.3 + 0.3 * uStrength);
  col += uC3 * min(fres, 0.5) * mix(0.8, 1.2, uDark);
  col += uC2 * clamp(h, 0.0, 0.6) * 0.18;
  // the pane catches a little light where it meets a card
  float c = cardField(vUv);
  col += uC3 * smoothstep(0.08, 0.5, c) * (1.0 - smoothstep(0.5, 0.95, c)) * 0.07;
  fragColor = vec4(col, 1.0);
}`;

const make: SpatialSceneFactory = (env, bridge, opts, palette) => {
  const wave = makeWave(env, { damp: 0.993, walls: 1, force: 1.2 });
  const instance = fragmentSpatial(env, bridge, palette, FS, {
    before(gl, p, _t, dt) {
      wave.step(dt, instance.field.texture);
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, wave.texture());
      gl.uniform1i(p.u('uWave'), 1);
      gl.uniform2f(p.u('uTexel'), 1.4 / 256, 1.4 / 144);
      gl.uniform1f(p.u('uDeep'), Number(opts.deep ?? 0));
    },
    dispose: () => wave.dispose(),
    slabs: 0.9,
  });
  return instance;
};
export default make;
