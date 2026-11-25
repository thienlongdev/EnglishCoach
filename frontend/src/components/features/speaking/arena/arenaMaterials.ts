/**
 * Portions adapted from Abyssal Garden — Copyright (c) 2026 Maksymilian Dendura, MIT License
 *
 * Project ECHO ARCHIPELAGO — Procedural PBR Archipelago Surfaces (Albedo + Tangent Normal +
 * Roughness Variation + Intertidal Wet-Sand/Rock Darkening + Coastal Weathering), Dual-Frequency
 * Branch/Leaf Wind Sway, and Seamless `onBeforeCompile` Underwater Chromatic Caustics + Beer-Lambert Optics.
 */

import * as T from 'three';
import type { ArenaQualityTier, ArenaTimeOfDay } from './arenaContracts';
import { ARENA_WATER_Y } from './arenaTerrain';
import { UNDERWATER_OPTICS_GLSL } from './arenaUnderwaterShaders';

export interface ArenaMaterialsOptions {
  quality?: ArenaQualityTier;
  timeOfDay?: ArenaTimeOfDay;
  causticsTexture?: T.Texture | null;
}

type ProceduralSurfaceKind = 'stone' | 'limestone' | 'wood' | 'soil' | 'sand' | 'rock' | 'thatch' | 'stucco';

function buildFallbackCausticsDataTexture(): T.DataTexture {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    const v = (y / S) * Math.PI * 2;
    for (let x = 0; x < S; x++) {
      const u = (x / S) * Math.PI * 2;
      let ix = u;
      let iy = v;
      let c = 0;
      for (let n = 1; n <= 4; n++) {
        const tt = 19 * (1 - 3.5 / n);
        const nx = u + Math.cos(tt - ix) + Math.sin(tt + iy);
        const ny = v + Math.sin(tt - iy) + Math.cos(tt + ix);
        ix = nx;
        iy = ny;
        const s = Math.sin(ix + tt);
        const k = Math.cos(iy + tt);
        c += Math.abs(s * k) / (1.25 * Math.hypot(s, k) + 1e-4);
      }
      const val = Math.round(T.MathUtils.clamp(Math.pow(Math.abs(1.17 - Math.pow(c / 4, 1.4)), 7) * 0.58, 0, 1) * 255);
      const o = (y * S + x) * 4;
      data[o] = val;
      data[o + 1] = val;
      data[o + 2] = 128;
      data[o + 3] = 128;
    }
  }
  const t = new T.DataTexture(data, S, S, T.RGBAFormat, T.UnsignedByteType);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.minFilter = T.LinearMipmapLinearFilter;
  t.magFilter = T.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Deterministic procedural PBR surface suite with GPU dual-frequency wind sway and
 * seamless underwater chromatic caustics + Beer-Lambert extinction; zero required network textures.
 */
export function arenaMaterials(lowOrOptions: boolean | ArenaMaterialsOptions = false) {
  const initialTier: ArenaQualityTier =
    typeof lowOrOptions === 'boolean'
      ? lowOrOptions
        ? 'low'
        : 'high'
      : (lowOrOptions.quality ?? 'high');
  const low = initialTier === 'low';
  const size = low ? 128 : initialTier === 'balanced' ? 192 : 256;
  const textures: T.Texture[] = [];

  const windUniform = { value: 0 };
  const fallbackCaustics = buildFallbackCausticsDataTexture();
  textures.push(fallbackCaustics);

  const externalCaustics = typeof lowOrOptions === 'object' ? (lowOrOptions.causticsTexture ?? null) : null;
  const underwaterShared = {
    tArenaWater: { value: externalCaustics ?? fallbackCaustics },
    uHasLiveCaustics: { value: externalCaustics ? 1 : 0 },
    uArenaSunDir: { value: new T.Vector3(-0.58, 0.75, 0.40).normalize() },
    uArenaSunTint: { value: new T.Vector3(1.0, 1.0, 1.0) },
    uArenaGrotto: { value: 0.06 },
  };

  // Periodic hash & smooth value noise so tiled PBR maps wrap seamlessly across RepeatWrapping!
  const hashPeriodic = (x: number, y: number, per: number, seed: number) => {
    const wx = ((x % per) + per) % per;
    const wy = ((y % per) + per) % per;
    const n = Math.sin(wx * 127.1 + wy * 311.7 + seed * 74.7) * 43758.5453123;
    return n - Math.floor(n);
  };
  const noisePeriodic = (u: number, v: number, per: number, seed = 0) => {
    const x = u * per;
    const y = v * per;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    let fx = x - ix;
    let fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    return T.MathUtils.lerp(
      T.MathUtils.lerp(hashPeriodic(ix, iy, per, seed), hashPeriodic(ix + 1, iy, per, seed), fx),
      T.MathUtils.lerp(hashPeriodic(ix, iy + 1, per, seed), hashPeriodic(ix + 1, iy + 1, per, seed), fx),
      fy,
    );
  };

  interface PbrMapSet {
    albedo: T.DataTexture;
    normal: T.DataTexture | null;
    roughness: T.DataTexture;
  }

  function buildPbrSet(kind: ProceduralSurfaceKind, normalStrength = 1.6): PbrMapSet {
    const albBytes = new Uint8Array(size * size * 4);
    const rghBytes = new Uint8Array(size * size * 4);
    const heights = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const n1 = noisePeriodic(u, v, 8, 1);
        const n2 = noisePeriodic(u, v, 24, 2);
        const n3 = noisePeriodic(u, v, 56, 3);
        const micro = hashPeriodic(x, y, size, 5);
        const baseN = n1 * 0.48 + n2 * 0.32 + n3 * 0.14 + micro * 0.06;

        let h = baseN;
        let alb = 0.84 + (baseN - 0.5) * 0.22;
        let warm = 0;
        let rgh = 0.72 + baseN * 0.24;

        if (kind === 'wood') {
          const ring = Math.sin(v * Math.PI * 36 + (n1 - 0.5) * 7.5);
          const plankSeam = Math.min(1, Math.abs(((v * 4) % 1) - 0.5) * 26);
          h = ring * 0.18 + n2 * 0.25 - (1 - plankSeam) * 0.45;
          alb = (0.78 + ring * 0.055 + (n2 - 0.5) * 0.12) * (0.68 + 0.32 * plankSeam);
          warm = 0.03;
          rgh = 0.62 + (1 - ring * 0.5) * 0.22;
        } else if (kind === 'sand') {
          const ripple = Math.sin((u * 6 + v * 2 + (n1 - 0.5) * 0.9) * Math.PI * 2) * 0.5 + 0.5;
          const shellGrain = micro > 0.97 ? 0.08 : 0;
          h = ripple * 0.42 + n3 * 0.35 + micro * 0.18;
          alb = 0.86 + (ripple - 0.5) * 0.08 + (n2 - 0.5) * 0.10 + shellGrain;
          warm = 0.025;
          rgh = 0.78 + (1 - ripple) * 0.14 - shellGrain * 0.3;
        } else if (kind === 'rock' || kind === 'limestone') {
          const strata = Math.abs(((v * 5 + (n1 - 0.5) * 1.4) % 1) - 0.5) * 2;
          const crack = Math.min(1, Math.abs(n2 * 2 - 1) * 5.5);
          h = strata * 0.38 + crack * 0.36 + n3 * 0.26;
          alb = (0.78 + strata * 0.16 + (n2 - 0.5) * 0.14) * (0.72 + 0.28 * crack);
          if (kind === 'limestone') {
            alb += 0.08;
            warm = 0.02;
          }
          rgh = 0.68 + (1 - crack) * 0.24 + n3 * 0.08;
        } else if (kind === 'thatch') {
          const stalks = Math.sin((u * 48 + (n2 - 0.5) * 2.2) * Math.PI * 2) * 0.5 + 0.5;
          const tiers = ((v * 5) % 1);
          const tierLip = Math.min(1, tiers * 8);
          h = stalks * 0.45 + (1 - tiers) * 0.35 - (1 - tierLip) * 0.4;
          alb = (0.76 + stalks * 0.16 + (n1 - 0.5) * 0.14) * (0.65 + 0.35 * tierLip);
          warm = 0.04;
          rgh = 0.82 + (1 - stalks) * 0.14;
        } else if (kind === 'stucco') {
          const trowel = noisePeriodic(u * 1.4, v, 12, 9) * 0.6 + n2 * 0.4;
          h = trowel * 0.32 + n3 * 0.15;
          alb = 0.90 + (trowel - 0.5) * 0.10;
          warm = 0.015;
          rgh = 0.76 + trowel * 0.16;
        } else if (kind === 'stone') {
          const vein = Math.pow(Math.abs(Math.sin((u * 3 + v * 2 + (n1 - 0.5) * 1.2) * Math.PI)), 12) * 0.06;
          const pit = micro > 0.985 ? -0.14 : 0;
          h = baseN * 0.65 - vein * 2.0 + pit;
          alb = 0.83 + (baseN - 0.5) * 0.16 + vein + pit;
          warm = 0.018;
          rgh = 0.66 + baseN * 0.26 - pit * 0.4;
        }

        const idx = y * size + x;
        heights[idx] = h;
        const o = idx * 4;
        albBytes[o] = Math.round(T.MathUtils.clamp(alb + warm * 0.5, 0, 1) * 255);
        albBytes[o + 1] = Math.round(T.MathUtils.clamp(alb + warm * 0.15, 0, 1) * 255);
        albBytes[o + 2] = Math.round(T.MathUtils.clamp(alb - warm * 0.6, 0, 1) * 255);
        albBytes[o + 3] = 255;

        const rv = Math.round(T.MathUtils.clamp(rgh, 0.08, 1) * 255);
        rghBytes[o] = rv;
        rghBytes[o + 1] = rv;
        rghBytes[o + 2] = rv;
        rghBytes[o + 3] = 255;
      }
    }

    const makeTex = (bytes: Uint8Array, srgb: boolean): T.DataTexture => {
      const t = new T.DataTexture(bytes, size, size, T.RGBAFormat, T.UnsignedByteType);
      t.wrapS = t.wrapT = T.RepeatWrapping;
      t.magFilter = T.LinearFilter;
      t.minFilter = T.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = low ? 1 : initialTier === 'balanced' ? 2 : 4;
      if (srgb) t.colorSpace = T.SRGBColorSpace;
      t.needsUpdate = true;
      textures.push(t);
      return t;
    };

    let normalTex: T.DataTexture | null = null;
    if (!low) {
      const nrmBytes = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        const ym = (y - 1 + size) % size;
        const yp = (y + 1) % size;
        for (let x = 0; x < size; x++) {
          const xm = (x - 1 + size) % size;
          const xp = (x + 1) % size;
          const dx = (heights[y * size + xp] - heights[y * size + xm]) * normalStrength;
          const dy = (heights[yp * size + x] - heights[ym * size + x]) * normalStrength;
          const len = Math.hypot(dx, dy, 1) || 1;
          const nx = -dx / len;
          const ny = -dy / len;
          const nz = 1 / len;
          const o = (y * size + x) * 4;
          nrmBytes[o] = Math.round((nx * 0.5 + 0.5) * 255);
          nrmBytes[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
          nrmBytes[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
          nrmBytes[o + 3] = 255;
        }
      }
      normalTex = makeTex(nrmBytes, false);
    }

    return {
      albedo: makeTex(albBytes, true),
      normal: normalTex,
      roughness: makeTex(rghBytes, false),
    };
  }

  /**
   * Injects intertidal wet-sand/rock darkening + gloss boost near `ARENA_WATER_Y`, coastal weathering,
   * and `Abyssal Garden` submerged chromatic RGB caustics + Beer-Lambert underwater fog.
   */
  const applyCoastalSubmersion = (
    mat: T.MeshStandardMaterial,
    opts: { wetStrength?: number; mossTint?: boolean; windAmplitude?: number } = {},
  ) => {
    const wetStrength = opts.wetStrength ?? 0.34;
    const mossTint = opts.mossTint ? 1.0 : 0.0;
    const windAmp = opts.windAmplitude ?? 0.0;

    mat.onBeforeCompile = shader => {
      shader.uniforms.uWindTime = windUniform;
      shader.uniforms.tArenaWater = underwaterShared.tArenaWater;
      shader.uniforms.uHasLiveCaustics = underwaterShared.uHasLiveCaustics;
      shader.uniforms.uArenaSunDir = underwaterShared.uArenaSunDir;
      shader.uniforms.uArenaSunTint = underwaterShared.uArenaSunTint;
      shader.uniforms.uArenaGrotto = underwaterShared.uArenaGrotto;

      // 1. Vertex shader: world position + world normal + optional dual-frequency branch/leaf wind sway
      let vs = `uniform float uWindTime;\nvarying vec3 vArenaWorldPos;\nvarying vec3 vArenaWorldNrm;\n` + shader.vertexShader;

      if (windAmp > 0.0001) {
        vs = vs.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vec4 arenaWindWP = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            arenaWindWP = instanceMatrix * arenaWindWP;
          #endif
          arenaWindWP = modelMatrix * arenaWindWP;
          float hMask = clamp((arenaWindWP.y + 0.45) * 0.26, 0.0, 1.45);
          // Primary trunk/branch low-frequency swell (0.38 Hz)
          float branchPh = uWindTime * 1.55 + arenaWindWP.x * 0.36 + arenaWindWP.z * 0.29;
          float branchX = (sin(branchPh) + 0.42 * sin(uWindTime * 2.75 - arenaWindWP.z * 0.68)) * ${windAmp.toFixed(4)} * hMask;
          float branchZ = cos(uWindTime * 1.32 + arenaWindWP.z * 0.35 + arenaWindWP.x * 0.24) * ${(windAmp * 0.74).toFixed(4)} * hMask;
          // Secondary high-frequency leaf/frond edge flutter (2.8 Hz)
          float leafFlutter = sin(uWindTime * 5.9 + dot(arenaWindWP.xyz, vec3(1.7, 1.1, 1.4))) * ${(windAmp * 0.34).toFixed(4)} * clamp(hMask, 0.15, 1.0);
          transformed.x += branchX + objectNormal.x * leafFlutter;
          transformed.z += branchZ + objectNormal.z * leafFlutter;
          transformed.y += objectNormal.y * leafFlutter * 0.45 - 0.18 * (branchX * branchX + branchZ * branchZ);`,
        );
      }

      vs = vs.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 arenaWP4 = vec4(transformed, 1.0);
        vec3 arenaWN3 = objectNormal;
        #ifdef USE_INSTANCING
          arenaWP4 = instanceMatrix * arenaWP4;
          arenaWN3 = mat3(instanceMatrix) * arenaWN3;
        #endif
        arenaWP4 = modelMatrix * arenaWP4;
        vArenaWorldPos = arenaWP4.xyz;
        vArenaWorldNrm = normalize(mat3(modelMatrix) * arenaWN3);`,
      );
      shader.vertexShader = vs;

      // 2. Fragment shader: intertidal wet line, coastal moss/salt weathering, submerged caustics & Beer-Lambert optics
      let fs =
        `uniform float uWindTime;\n` +
        `uniform sampler2D tArenaWater;\n` +
        `uniform float uHasLiveCaustics;\n` +
        `uniform vec3 uArenaSunDir;\n` +
        `uniform vec3 uArenaSunTint;\n` +
        `uniform float uArenaGrotto;\n` +
        `varying vec3 vArenaWorldPos;\n` +
        `varying vec3 vArenaWorldNrm;\n` +
        `${UNDERWATER_OPTICS_GLSL}\n` +
        /* glsl */ `
        vec3 arenaFallbackCaustics(vec3 p, float dist, vec3 sunDir, float t) {
          vec2 q = uwCausticUV(p, sunDir) * 0.28;
          vec2 d1 = q + vec2(t * 0.038, -t * 0.027);
          vec2 d2 = q.yx * 0.62 + vec2(-t * 0.024, t * 0.031) + 0.37;
          vec2 disp = vec2(0.0045, 0.0028);
          vec3 a = vec3(
            texture(tArenaWater, d1 + disp).r,
            texture(tArenaWater, d1).r,
            texture(tArenaWater, d1 - disp).r
          );
          float b = texture(tArenaWater, d2).r;
          vec3 c = min(pow(max(a, vec3(0.0)), vec3(1.65)) * 4.2 * (0.45 + b * 1.35), vec3(3.6));
          return mix(c, vec3(0.33), uwSS(35.0, 100.0, dist));
        }
        \n` +
        shader.fragmentShader;

      fs = fs.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        float arenaRelY = vArenaWorldPos.y - WATER_Y;
        // Wet-sand & wet-stone darkening + glossy tide-lap sheen near waterline
        float arenaWetBand = (1.0 - smoothstep(-0.08, 0.58, arenaRelY));
        diffuseColor.rgb *= mix(1.0, ${(1.0 - wetStrength).toFixed(3)}, arenaWetBand);
        roughnessFactor = mix(roughnessFactor, 0.18, arenaWetBand * ${(wetStrength * 1.85).toFixed(3)});
        if (${mossTint.toFixed(1)} > 0.5) {
          float mossMask = clamp(vArenaWorldNrm.y * 0.85, 0.0, 1.0) * smoothstep(0.15, 1.6, arenaRelY);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.14, 0.28, 0.16), mossMask * 0.55);
          roughnessFactor = mix(roughnessFactor, 0.88, mossMask * 0.5);
        }`,
      );

      fs = fs.replace(
        '#include <opaque_fragment>',
        `float arenaSubMask = uwSS(WATER_Y + 0.10, WATER_Y - 0.16, vArenaWorldPos.y);
        if (arenaSubMask > 0.001) {
          float arenaDist = length(vArenaWorldPos - cameraPosition);
          vec3 arenaCaust = uHasLiveCaustics > 0.5
            ? uwCausticsRGB(tArenaWater, vArenaWorldPos, arenaDist, uArenaSunDir)
            : arenaFallbackCaustics(vArenaWorldPos, arenaDist, uArenaSunDir, uWindTime);
          float upSun = uwSS(0.02, 0.48, dot(normalize(vArenaWorldNrm), uArenaSunDir));
          float subDepth = max(0.0, WATER_Y - vArenaWorldPos.y);
          vec3 depthAtten = exp(-uwKd(uArenaGrotto) * subDepth);
          vec3 caustBoost = diffuseColor.rgb * arenaCaust * uArenaSunTint * depthAtten * upSun * 0.58;
          vec3 absorbed = outgoingLight * mix(vec3(1.0), depthAtten * vec3(0.86, 0.98, 1.06), uwSat(subDepth * 0.18)) + caustBoost;
          outgoingLight = mix(outgoingLight, absorbed, arenaSubMask);
        }
        if (cameraPosition.y < WATER_Y + 0.12) {
          float camSub = uwSS(WATER_Y + 0.12, WATER_Y - 0.12, cameraPosition.y);
          vec3 uwScat = uwApplyFog(outgoingLight, vArenaWorldPos, cameraPosition, uArenaGrotto, uArenaSunDir, 0.85);
          outgoingLight = mix(outgoingLight, uwSafeHDR(uwScat, 24.0), camSub);
        }
        #include <opaque_fragment>`,
      );

      // Cancel pale dry-air scene.fog when submerged so underwater surfaces preserve Beer-Lambert scattering
      fs = fs.replace(
        '#include <fog_fragment>',
        `vec3 arenaPreAirFog = gl_FragColor.rgb;
        #include <fog_fragment>
        if (cameraPosition.y < WATER_Y + 0.12) {
          float camSubFog = uwSS(WATER_Y + 0.12, WATER_Y - 0.12, cameraPosition.y);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, arenaPreAirFog, camSubFog);
        }`,
      );

      shader.fragmentShader = fs;
    };

    mat.customProgramCacheKey = () =>
      `arena-v7-surf-${wetStrength.toFixed(2)}-${mossTint.toFixed(1)}-${windAmp.toFixed(4)}`;
    return mat;
  };

  const applyWindSway = (mat: T.MeshStandardMaterial, amplitude = 0.055) =>
    applyCoastalSubmersion(mat, { wetStrength: 0.12, windAmplitude: amplitude });

  /**
   * Painted tropical foliage & bougainvillea blossom atlas (`512×320` CanvasTexture in browser,
   * deterministic `DataTexture` fallback in headless Node contract environments).
   */
  function foliage(): T.Texture {
    if (typeof document === 'undefined') {
      const fb = new Uint8Array(16 * 16 * 4);
      for (let i = 0; i < 16 * 16; i++) {
        fb[i * 4] = 68;
        fb[i * 4 + 1] = 148;
        fb[i * 4 + 2] = 72;
        fb[i * 4 + 3] = 255;
      }
      const dt = new T.DataTexture(fb, 16, 16);
      dt.colorSpace = T.SRGBColorSpace;
      dt.needsUpdate = true;
      textures.push(dt);
      return dt;
    }

    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 320;
    const g = c.getContext('2d');
    if (!g) {
      const dt = new T.DataTexture(new Uint8Array(16).fill(200), 2, 2);
      dt.needsUpdate = true;
      textures.push(dt);
      return dt;
    }

    let s = 977;
    const r = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    const leafShape = (bx: number, by: number, a: number, len: number, w: number, dark: string, light: string) => {
      const tx = bx + Math.sin(a) * len;
      const ty = by - Math.cos(a) * len;
      const nx = Math.cos(a) * w;
      const ny = Math.sin(a) * w;
      const grad = g.createLinearGradient(bx, by, tx, ty);
      grad.addColorStop(0, dark);
      grad.addColorStop(1, light);
      g.beginPath();
      g.moveTo(bx, by);
      g.bezierCurveTo(
        bx + nx + (tx - bx) * 0.2,
        by + ny + (ty - by) * 0.2,
        tx + nx * 0.6 - (tx - bx) * 0.2,
        ty + ny * 0.6 - (ty - by) * 0.2,
        tx,
        ty,
      );
      g.bezierCurveTo(
        tx - nx * 0.6 - (tx - bx) * 0.2,
        ty - ny * 0.6 - (ty - by) * 0.2,
        bx - nx + (tx - bx) * 0.2,
        by - ny + (ty - by) * 0.2,
        bx,
        by,
      );
      g.fillStyle = grad;
      g.fill();
      g.strokeStyle = 'rgba(214,232,170,.55)';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(bx + (tx - bx) * 0.92, by + (ty - by) * 0.92);
      g.stroke();
    };
    for (let i = 0; i < 11; i++) {
      const a = -1.25 + (i / 10) * 2.5 + (r() - 0.5) * 0.25;
      const len = 150 + r() * 120;
      const tone = r();
      leafShape(
        128 + (r() - 0.5) * 30,
        312,
        a,
        len,
        26 + r() * 14,
        tone > 0.5 ? '#1d5a31' : '#245f2c',
        tone > 0.3 ? '#5f9c45' : '#7ab352',
      );
    }
    for (let i = 0; i < 7; i++) {
      leafShape(384 + (r() - 0.5) * 140, 300 - r() * 120, (r() - 0.5) * 2.4, 70 + r() * 40, 18, '#2a6234', '#5d9a49');
    }
    for (let i = 0; i < 26; i++) {
      const cx = 384 + (r() - 0.5) * 200;
      const cy = 60 + r() * 200;
      const hue = r() > 0.3 ? ['#c43872', '#e05596'] : ['#e0674f', '#f29a74'];
      for (let p = 0; p < 3; p++) {
        const pa = p * 2.09 + r();
        g.beginPath();
        g.ellipse(cx + Math.cos(pa) * 9, cy + Math.sin(pa) * 9, 15, 10, pa, 0, Math.PI * 2);
        const grad = g.createRadialGradient(cx, cy, 2, cx, cy, 22);
        grad.addColorStop(0, hue[1]);
        grad.addColorStop(1, hue[0]);
        g.fillStyle = grad;
        g.fill();
      }
      g.fillStyle = '#fbf0c8';
      g.beginPath();
      g.arc(cx, cy, 3.2, 0, Math.PI * 2);
      g.fill();
    }
    const t = new T.CanvasTexture(c);
    t.colorSpace = T.SRGBColorSpace;
    t.anisotropy = low ? 1 : 4;
    textures.push(t);
    return t;
  }

  const stoneSet = buildPbrSet('stone', 1.45);
  const limestoneSet = buildPbrSet('limestone', 1.75);
  const woodSet = buildPbrSet('wood', 1.35);
  const soilSet = buildPbrSet('soil', 1.25);
  const sandSet = buildPbrSet('sand', 1.15);
  const rockSet = buildPbrSet('rock', 2.05);
  const thatchSet = buildPbrSet('thatch', 1.85);
  const stuccoSet = buildPbrSet('stucco', 0.95);
  const leaves = foliage();

  const card = (color: string, amplitude: number) => {
    const m = new T.MeshStandardMaterial({
      color,
      map: leaves,
      alphaTest: 0.5,
      roughness: 0.76,
      vertexColors: true,
      side: T.DoubleSide,
    });
    return applyWindSway(m, amplitude);
  };

  const pbrSurface = (
    color: string,
    set: PbrMapSet,
    roughness = 0.86,
    normalScale = 0.55,
    wetStrength = 0.30,
    mossTint = false,
  ) => {
    const m = new T.MeshStandardMaterial({
      color,
      map: set.albedo,
      roughness,
      roughnessMap: set.roughness,
      normalMap: set.normal,
      normalScale: new T.Vector2(normalScale, normalScale),
      vertexColors: true,
    });
    return applyCoastalSubmersion(m, { wetStrength, mossTint });
  };

  const mats = {
    // Classic 17 keys (100% backward-compatible with `arenaWorld.ts`)
    stone: pbrSurface('#e7d9bc', stoneSet, 0.86, 0.48, 0.28),
    sand: pbrSurface('#ead7b0', sandSet, 0.90, 0.42, 0.38),
    chalk: pbrSurface('#f3ead6', stuccoSet, 0.84, 0.32, 0.22),
    mortar: pbrSurface('#8b998c', stoneSet, 0.88, 0.45, 0.28),
    rock: pbrSurface('#6f8580', rockSet, 0.87, 0.72, 0.36),
    slate: pbrSurface('#355d63', rockSet, 0.78, 0.52, 0.30),
    wood: pbrSurface('#96714e', woodSet, 0.80, 0.46, 0.34),
    soil: pbrSurface('#4f4d39', soilSet, 0.94, 0.44, 0.25),
    bronze: pbrSurface('#c49d56', stoneSet, 0.48, 0.25, 0.14),
    coral: pbrSurface('#d68b76', limestoneSet, 0.84, 0.50, 0.26),
    teal: pbrSurface('#4a958f', stuccoSet, 0.78, 0.30, 0.24),
    leaf: card('#ffffff', 0.052),
    lightLeaf: card('#e6f3cf', 0.065),
    flower: card('#ffffff', 0.048),
    linen: applyWindSway(
      new T.MeshStandardMaterial({
        color: '#ebe0bf',
        map: stuccoSet.albedo,
        roughness: 0.90,
        roughnessMap: stuccoSet.roughness,
        vertexColors: true,
      }),
      0.028,
    ),
    glow: new T.MeshStandardMaterial({
      color: '#ddeddc',
      emissive: '#83c9ba',
      emissiveIntensity: 0.42,
      roughness: 0.6,
      vertexColors: true,
    }),
    lamp: new T.MeshStandardMaterial({
      color: '#fff3c7',
      emissive: '#ffd799',
      emissiveIntensity: 1.45,
      roughness: 0.52,
      vertexColors: true,
    }),

    // New v7 Archipelago PBR keys (`limestone`, `thatch`, `stucco`, `wetSand`, `mossRock`)
    limestone: pbrSurface('#dfd3ba', limestoneSet, 0.84, 0.68, 0.34),
    thatch: applyWindSway(
      new T.MeshStandardMaterial({
        color: '#c9a96e',
        map: thatchSet.albedo,
        roughness: 0.91,
        roughnessMap: thatchSet.roughness,
        normalMap: thatchSet.normal,
        normalScale: new T.Vector2(0.65, 0.65),
        vertexColors: true,
        side: T.DoubleSide,
      }),
      0.014,
    ),
    stucco: pbrSurface('#f5eee0', stuccoSet, 0.82, 0.36, 0.20),
    wetSand: pbrSurface('#b89f78', sandSet, 0.32, 0.30, 0.48),
    mossRock: pbrSurface('#5c7063', rockSet, 0.86, 0.74, 0.36, true),
  };

  mats.bronze.metalness = 0.58;
  mats.bronze.side = T.DoubleSide;
  mats.teal.side = T.DoubleSide;
  mats.leaf.side = T.DoubleSide;
  mats.lightLeaf.side = T.DoubleSide;
  mats.flower.side = T.DoubleSide;
  mats.linen.side = T.DoubleSide;

  return {
    mats,
    windUniform,
    applyWindSway,
    applyCoastalSubmersion,

    setUnderwaterUniforms(opts: {
      causticsTexture?: T.Texture | null;
      isFloatCaustics?: boolean;
      sunDir?: T.Vector3;
      grottoBoost?: number;
    }) {
      if (opts.causticsTexture !== undefined) {
        if (opts.causticsTexture) {
          underwaterShared.tArenaWater.value = opts.causticsTexture;
          underwaterShared.uHasLiveCaustics.value = opts.isFloatCaustics !== false ? 1 : 0;
        } else {
          underwaterShared.tArenaWater.value = fallbackCaustics;
          underwaterShared.uHasLiveCaustics.value = 0;
        }
      }
      if (opts.sunDir) {
        underwaterShared.uArenaSunDir.value.copy(opts.sunDir).normalize();
      }
      if (opts.grottoBoost !== undefined) {
        underwaterShared.uArenaGrotto.value = opts.grottoBoost;
      }
    },

    setQuality(tier: ArenaQualityTier) {
      const aniso = tier === 'low' ? 1 : tier === 'balanced' ? 2 : 4;
      for (const tex of textures) tex.anisotropy = aniso;
    },

    setTimeOfDay(tod: ArenaTimeOfDay) {
      if (tod === 'sunset') {
        underwaterShared.uArenaSunDir.value.set(-0.74, 0.34, 0.58).normalize();
        underwaterShared.uArenaSunTint.value.set(1.18, 0.84, 0.66);
        underwaterShared.uArenaGrotto.value = 0.24;
      } else {
        underwaterShared.uArenaSunDir.value.set(-0.58, 0.75, 0.40).normalize();
        underwaterShared.uArenaSunTint.value.set(1.0, 1.0, 1.0);
        underwaterShared.uArenaGrotto.value = 0.06;
      }
    },

    update(time: number) {
      windUniform.value = time;
    },

    dispose: () => {
      textures.forEach(t => t.dispose());
      Object.values(mats).forEach(m => m.dispose());
    },
  };
}
