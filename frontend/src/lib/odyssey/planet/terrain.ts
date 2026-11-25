/* Echo Living Planet — the terrain function. One deterministic function of a direction on the unit sphere gives
   elevation, ground colour, rock colour, surface kinds and forest density. It is used by the planet builder (worker)
   and by the tests; nothing here touches the DOM, the network or a renderer. */
import { makeNoise3, fbm, ridged, seeded, smoothstep, clamp01, lerp } from './noise';
import { SITES, CONNECTIONS, BY_ID, siteDir, bearingOffset, frameAt, type Biome, type Site } from './layout';

export const SEA_DEPTH = 7;      // deepest ocean below sea level (world units)
const RAD = Math.PI / 180;

type RGB = [number, number, number];
const lin = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
  return c.map(v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) as RGB;
};

interface Palette { low: RGB; high: RGB; alt: RGB; rock: RGB; sand: RGB; accent?: RGB; hills: number; mountains: number; terrace: number; forest: number; snowline: number }
const P = (low: string, high: string, alt: string, rock: string, sand: string, hills: number, mountains: number, forest: number, extra: Partial<{ accent: string; terrace: number; snowline: number }> = {}): Palette => ({
  low: lin(low), high: lin(high), alt: lin(alt), rock: lin(rock), sand: lin(sand), accent: extra.accent ? lin(extra.accent) : undefined,
  hills, mountains, forest, terrace: extra.terrace ?? 0, snowline: extra.snowline ?? 99,
});

/** Ground palettes, tuned by eye against the owner's references (soft, saturated miniature landscape). */
export const PALETTES: Record<Biome, Palette> = {
  meadow:      P('#6db23f', '#4e9a33', '#a9c75a', '#8f8678', '#ecd9a2', 0.75, 0.12, 0.5, { accent: '#f4e27a' }),
  blossom:     P('#82c25a', '#5fa847', '#b6d47a', '#9a8f86', '#efdcb0', 0.9, 0.08, 0.55, { accent: '#f6b8d0' }),
  forest:      P('#3f8a2c', '#2f7224', '#6aa23d', '#7f7a6c', '#e6d39b', 1.0, 0.18, 0.97),
  cliffs:      P('#6aa04a', '#557f3d', '#8bb35c', '#a39c8c', '#e3d3a5', 0.65, 0.55, 0.55, { terrace: 1.25 }),
  tropical:    P('#7cc457', '#59ad45', '#a7d56c', '#b8a789', '#f6e7b8', 0.25, 0.04, 0.42),
  coastal:     P('#8bbd52', '#6fa645', '#c2cf7a', '#a69a86', '#eedaa4', 0.6, 0.1, 0.32, { accent: '#f1c56a' }),
  autumn:      P('#b9883a', '#9c6a2c', '#c9a14e', '#8b7766', '#e7d3a0', 0.8, 0.2, 0.92),
  ink:         P('#6f9f6c', '#567f5c', '#93b483', '#7f7f92', '#e0d6b8', 0.4, 0.05, 0.5, { accent: '#a989e2' }),
  archipelago: P('#5f9f47', '#4b863c', '#86b25a', '#8c877c', '#e9d8a8', 0.6, 0.3, 0.58),
  port:        P('#a7b55b', '#8c9c48', '#c8b56a', '#b48d6c', '#efd9a2', 0.7, 0.1, 0.22, { accent: '#d98f5d' }),
  savanna:     P('#d3b257', '#c09840', '#e2c873', '#b0765a', '#f0dca4', 0.4, 0.15, 0.12, { terrace: 1.6 }),
  alpine:      P('#6b9a4c', '#4f7f3d', '#8bac63', '#9a958c', '#e1d3ac', 0.55, 1.0, 0.7, { snowline: 5.6 }),
  polar:       P('#e8f0f8', '#d6e6f3', '#f6fafe', '#6c7584', '#d8e4ee', 0.5, 0.7, 0.05, { snowline: -10 }),
  sanctuary:   P('#5fa36f', '#4b8a5d', '#86c08f', '#7d9a95', '#e3dcc0', 0.5, 0.1, 0.55, { accent: '#9fd8cf' }),
  volcanic:    P('#5d5550', '#463f3d', '#77695f', '#3b3534', '#3d3836', 0.5, 0.35, 0.08),
};
const WILD = P('#6aa848', '#4f8d39', '#94bb5c', '#8d877a', '#ead8a4', 0.7, 0.2, 0.6);
const BIOMES = Object.keys(PALETTES) as Biome[];

export interface TerrainSample {
  h: number;            // elevation relative to sea level
  land: number;         // land field (>0 = land)
  r: number; g: number; b: number;   // ground albedo (linear)
  rr: number; rg: number; rb: number; // rock albedo (linear)
  sand: number;         // beach / seabed weight
  snow: number;         // snow weight (before slope)
  special: number;      // lava (volcanic) or flowers (accent biomes)
  forest: number;       // tree density 0..1
  site: number;         // index of the dominant site (-1 = wild)
  biome: number;        // index into BIOMES of the dominant site (-1 = wild)
  pad: number;          // 0..1 inside a landmark plateau
}
export const newSample = (): TerrainSample => ({ h: 0, land: 0, r: 0, g: 0, b: 0, rr: 0, rg: 0, rb: 0, sand: 0, snow: 0, special: 0, forest: 0, site: -1, biome: -1, pad: 0 });
export const biomeName = (i: number): Biome | null => i >= 0 ? BIOMES[i] : null;

interface Blob { x: number; y: number; z: number; r: number }

/** detail: weight of the fine relief (1 for the densest mesh; lower meshes get less so props never float). */
export function createTerrain(seed = 20261114, detail = 1) {
  const n1 = makeNoise3(seed), n2 = makeNoise3(seed + 17), n3 = makeNoise3(seed + 41), n4 = makeNoise3(seed + 73);
  const rand = seeded(seed + 5);
  const count = SITES.length;
  const sx = new Float64Array(count), sy = new Float64Array(count), sz = new Float64Array(count), sr = new Float64Array(count);
  const pal: Palette[] = [], biomeIndex = new Int8Array(count);
  const islets: Blob[][] = [];
  const bays: (Blob | null)[] = [], outlets: (Blob | null)[] = [];
  let volcano: { x: number; y: number; z: number; e: [number, number, number]; n: [number, number, number] } | null = null;
  SITES.forEach((s: Site, i) => {
    const d = siteDir(s); sx[i] = d[0]; sy[i] = d[1]; sz[i] = d[2]; sr[i] = s.radius * RAD * 1.22;
    pal.push(PALETTES[s.biome]); biomeIndex[i] = BIOMES.indexOf(s.biome);
    if (s.islands) {
      const list: Blob[] = [{ x: d[0], y: d[1], z: d[2], r: 3.2 * RAD }];
      for (let k = 0; k < 7; k++) {
        const a = rand() * Math.PI * 2, dist = 3.5 + rand() * (s.radius - 4);
        const o = bearingOffset(d, a / RAD, dist);
        list.push({ x: o[0], y: o[1], z: o[2], r: (1.3 + rand() * 1.9) * RAD });
      }
      islets.push(list);
    } else islets.push([]);
    if (s.bay) {
      const o = bearingOffset(d, s.bay.bearing, s.bay.dist), far = bearingOffset(d, s.bay.bearing, s.bay.dist + s.radius * 1.1);
      bays.push({ x: o[0], y: o[1], z: o[2], r: s.bay.radius * RAD }); outlets.push({ x: far[0], y: far[1], z: far[2], r: 0 });
    } else { bays.push(null); outlets.push(null); }
    if (s.landmark === 'gateway') {
      const o = bearingOffset(d, 55, 5.4), f = frameAt(o);
      volcano = { x: o[0], y: o[1], z: o[2], e: f.east, n: f.north };
    }
  });
  // Uninhabited islands on the open ocean: decoration only, no learning meaning.
  const wild: Blob[] = [];
  for (let k = 0; k < 9; k++) {
    const lon = 105 + rand() * 150, lat = -50 + rand() * 100;
    const la = lat * RAD, lo = lon * RAD;
    wild.push({ x: Math.cos(la) * Math.sin(lo), y: Math.sin(la), z: Math.cos(la) * Math.cos(lo), r: (2.5 + rand() * 4.5) * RAD });
  }
  const links = CONNECTIONS.map(([a, b, w]) => {
    const A = siteDir(BY_ID.get(a)!), B = siteDir(BY_ID.get(b)!);
    let nx = A[1] * B[2] - A[2] * B[1], ny = A[2] * B[0] - A[0] * B[2], nz = A[0] * B[1] - A[1] * B[0];
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    return { A, B, nx, ny, nz, span: Math.acos(A[0] * B[0] + A[1] * B[1] + A[2] * B[2]), w: w * RAD * 1.3 };
  });
  // Chord length: equals the angle to within 1 % below 20°, monotonic beyond, and much cheaper than acos.
  const angle = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    const d = 2 - 2 * (ax * bx + ay * by + az * bz); return d > 0 ? Math.sqrt(d) : 0;
  };
  const dist = new Float64Array(count);

  // Landmark plateaus sit at the land's own height there (never a pit dug into hills, never a mesa on a plain).
  const padH = new Float64Array(count).fill(NaN);
  function sample(px: number, py: number, pz: number, out: TerrainSample, flatten = true) {
    // Domain warp: organic coastlines that never look like circles.
    const wx = px + 0.075 * fbm(n2, px * 2.1 + 3.1, py * 2.1, pz * 2.1, 2);
    const wy = py + 0.075 * fbm(n2, px * 2.1, py * 2.1 + 7.7, pz * 2.1, 2);
    const wz = pz + 0.075 * fbm(n2, px * 2.1, py * 2.1, pz * 2.1 + 1.9, 2);
    const wl = Math.hypot(wx, wy, wz), qx = wx / wl, qy = wy / wl, qz = wz / wl;

    // Land field: soft union of site masses, islets, land bridges and wild islands.
    let acc = 0;
    const K = 7;
    for (let i = 0; i < count; i++) {
      dist[i] = angle(px, py, pz, sx[i], sy[i], sz[i]);
      const list = islets[i];
      if (list.length) {
        let best = -2;
        for (const b of list) best = Math.max(best, 1 - angle(qx, qy, qz, b.x, b.y, b.z) / b.r);
        acc += Math.exp(K * (best * 0.75));
      } else acc += Math.exp(K * (1 - angle(qx, qy, qz, sx[i], sy[i], sz[i]) / sr[i]));
    }
    for (const l of links) {
      const sdot = qx * l.nx + qy * l.ny + qz * l.nz;
      // The projection lies between A and B when it is on the inner side of both end planes.
      const inA = (l.A[1] * qz - l.A[2] * qy) * l.nx + (l.A[2] * qx - l.A[0] * qz) * l.ny + (l.A[0] * qy - l.A[1] * qx) * l.nz;
      const inB = (qy * l.B[2] - qz * l.B[1]) * l.nx + (qz * l.B[0] - qx * l.B[2]) * l.ny + (qx * l.B[1] - qy * l.B[0]) * l.nz;
      const d = inA >= 0 && inB >= 0 ? Math.abs(sdot) : Math.min(angle(qx, qy, qz, l.A[0], l.A[1], l.A[2]), angle(qx, qy, qz, l.B[0], l.B[1], l.B[2]));
      acc += Math.exp(K * 0.8 * (1 - d / l.w));
    }
    for (const b of wild) acc += Math.exp(K * 0.85 * (1 - angle(qx, qy, qz, b.x, b.y, b.z) / b.r));
    let land = Math.log(acc) / K;
    land += 0.2 * fbm(n1, px * 3.2, py * 3.2, pz * 3.2, 4) + 0.07 * fbm(n3, px * 9.5, py * 9.5, pz * 9.5, 2);
    if (land < -0.16) {
      // Open ocean: only the seabed matters (the water shader colours it); no biome, relief or vegetation work.
      const h = Math.max(-SEA_DEPTH, land * 9.5), d = clamp01(-h / 4.5);
      out.h = h; out.land = land; out.r = 0.02 + 0.6 * (1 - d) * 0.3; out.g = 0.16 + 0.2 * (1 - d); out.b = 0.2 + 0.12 * (1 - d);
      out.rr = 0.3; out.rg = 0.3; out.rb = 0.3; out.sand = 1; out.snow = 0; out.special = 0; out.forest = 0; out.site = -1; out.biome = -1; out.pad = 0;
      for (let i = 0; i < count; i++) dist[i] = 9;
      return out;
    }

    // Biome weights (gaussian by angular distance), dominant site.
    let wsum = 0.035, dom = -1, domW = 0;
    let gr = 0, gg = 0, gb = 0, rr = 0, rg = 0, rb = 0, hills = 0, mountains = 0, terrace = 0, forestBase = 0, snowline = 0, accent = 0;
    let ar = 0, ag = 0, ab = 0;
    const v = clamp01(fbm(n3, px * 5.3, py * 5.3, pz * 5.3, 3) * 0.75 + 0.5);
    const v2 = clamp01(fbm(n4, px * 13, py * 13, pz * 13, 2) * 0.9 + 0.5);
    const mixPal = (p: Palette, w: number) => {
      const t = v;
      const cr = lerp(p.low[0], p.high[0], t), cg = lerp(p.low[1], p.high[1], t), cb = lerp(p.low[2], p.high[2], t);
      const k = smoothstep(0.55, 0.85, v2) * 0.55;
      gr += w * lerp(cr, p.alt[0], k); gg += w * lerp(cg, p.alt[1], k); gb += w * lerp(cb, p.alt[2], k);
      rr += w * p.rock[0]; rg += w * p.rock[1]; rb += w * p.rock[2];
      hills += w * p.hills; mountains += w * p.mountains; terrace += w * p.terrace; forestBase += w * p.forest; snowline += w * p.snowline;
      if (p.accent) { accent += w; ar += w * p.accent[0]; ag += w * p.accent[1]; ab += w * p.accent[2]; }
    };
    mixPal(WILD, 0.035);
    for (let i = 0; i < count; i++) {
      const t = dist[i] / (sr[i] * 1.05);
      const w = Math.exp(-t * t * 2.4);
      if (w < 1e-4) continue;
      wsum += w; mixPal(pal[i], w);
      if (w > domW) { domW = w; dom = i; }
    }
    gr /= wsum; gg /= wsum; gb /= wsum; rr /= wsum; rg /= wsum; rb /= wsum;
    hills /= wsum; mountains /= wsum; terrace /= wsum; forestBase /= wsum; snowline /= wsum;
    const accentW = accent / wsum;
    if (accent > 0) { ar /= accent; ag /= accent; ab /= accent; }

    // Elevation.
    let h: number;
    if (land < 0) h = Math.max(-SEA_DEPTH, land * 9.5);
    else {
      const t = land;
      h = 0.35 + 2.1 * smoothstep(0, 0.55, t);
      const hill = (fbm(n1, px * 6.2 + 11, py * 6.2, pz * 6.2, 4) * 0.5 + 0.5) * 2.7;
      h += hills * hill * smoothstep(0.02, 0.25, t);
      const ridge = ridged(n4, px * 4.4, py * 4.4, pz * 4.4, 5);
      h += mountains * Math.pow(ridge, 1.55) * 16.5 * smoothstep(0.12, 0.6, t);
      // Fine relief: rocky ribs and gullies on mountain flanks, soft undulation on the lowlands.
      // Around the landmarks (where the stations stand) the ground stays calmer and readable.
      if (detail > 0) {
        let near = 9; for (let i = 0; i < count; i++) near = Math.min(near, dist[i]);
        const calm = 0.3 + 0.7 * smoothstep(4.5 * RAD, 9 * RAD, near);
        const rugged = 0.16 + 0.85 * mountains * smoothstep(2.5, 9, h) + 0.3 * terrace;
        h += detail * calm * rugged * fbm(n3, px * 23 + 1.3, py * 23, pz * 23, 3) * smoothstep(0.03, 0.2, t);
      }
      if (terrace > 0.05) { const step = 1.35; const q = Math.floor(h / step) * step, f = (h - q) / step; h = lerp(h, q + step * smoothstep(0.55, 0.85, f), clamp01(terrace)); }
      h = lerp(0.35 * smoothstep(0, 0.08, t), h, smoothstep(0, 0.06, t));
    }
    // Bays and the volcano.
    let special = 0;
    for (let i = 0; i < count; i++) {
      const b = bays[i]; if (!b) continue;
      const d = angle(px, py, pz, b.x, b.y, b.z);
      // A bowl with a gentle beach slope: deepest in the middle, rising to the land over the whole radius.
      if (d < b.r * 1.6) { const target = -2.8 + 3.6 * smoothstep(b.r * 0.25, b.r * 1.15, d); h = lerp(h, Math.min(h, target), smoothstep(b.r * 1.6, b.r * 0.7, d)); }
      // An inlet from the bay to the open sea, so harbours face real water rather than a pit.
      const o = outlets[i]!;
      const sx0 = o.x - b.x, sy0 = o.y - b.y, sz0 = o.z - b.z, len2 = sx0 * sx0 + sy0 * sy0 + sz0 * sz0;
      const u = clamp01(((px - b.x) * sx0 + (py - b.y) * sy0 + (pz - b.z) * sz0) / len2);
      const cx = b.x + sx0 * u - px, cy = b.y + sy0 * u - py, cz = b.z + sz0 * u - pz, dc = Math.sqrt(cx * cx + cy * cy + cz * cz), w = b.r * (0.62 - 0.2 * u);
      if (dc < w) h = lerp(h, Math.min(h, -2.2), smoothstep(w, w * 0.35, dc));
    }
    if (volcano) {
      const d = angle(px, py, pz, volcano.x, volcano.y, volcano.z), R = 4.6 * RAD;
      if (d < R * 1.4) {
        const c = clamp01(1 - d / R);
        h += 16 * Math.pow(c, 1.55) + 1.2 * smoothstep(R * 1.4, R * 0.6, d);
        h -= 4.2 * smoothstep(0.75 * RAD, 0.15 * RAD, d);
        const ex = px - volcano.x, ey = py - volcano.y, ez = pz - volcano.z;
        const az = Math.atan2(ex * volcano.e[0] + ey * volcano.e[1] + ez * volcano.e[2], ex * volcano.n[0] + ey * volcano.n[1] + ez * volcano.n[2]);
        const stream = Math.pow(Math.abs(Math.sin(az * 2.5 + 1.2 + 0.9 * n2(px * 30, py * 30, pz * 30))), 26);
        special = Math.max(special, stream * smoothstep(0.1, 0.45, c) * smoothstep(0.98, 0.8, c)) + smoothstep(0.86, 0.95, c) * 0.9;
      }
    }
    // Landmark plateaus.
    let pad = 0;
    for (let i = 0; flatten && i < count; i++) {
      const pr = 2.1 * RAD, d = dist[i];
      if (d < pr * 1.7) {
        const w = smoothstep(pr * 1.7, pr * 0.95, d); pad = Math.max(pad, w);
        h = lerp(h, padH[i] + 0.25 * fbm(n3, px * 40, py * 40, pz * 40, 2), w);
      }
    }

    // Surface kinds.
    const beach = h < 0.75 ? smoothstep(0.75, 0.25, h) : 0;
    let sand = beach;
    let snow = smoothstep(snowline - 0.6, snowline + 1.6, h + 1.8 * (v2 - 0.5));
    if (h < 0) { sand = 1; snow = 0; }
    const flower = accentW * smoothstep(0.66, 0.84, v2) * smoothstep(0.3, 1.6, h) * (1 - pad);
    // Forest density: clustered stands, none on beaches, snow, plateaus or the volcano's slope.
    const clusters = clamp01(fbm(n1, px * 8.5 + 5, py * 8.5, pz * 8.5, 3) * 1.15 + 0.5);
    let forest = forestBase * smoothstep(0.45 - forestBase * 0.4, 0.75 - forestBase * 0.3, clusters);
    forest *= smoothstep(0.55, 1.1, h) * (1 - snow * 0.9) * (1 - smoothstep(0.25, 0.85, pad));
    if (volcano && angle(px, py, pz, volcano.x, volcano.y, volcano.z) < 6 * RAD) forest *= 0.15;

    // Ground colour: beach, seabed and accents.
    let cr = gr, cg = gg, cb = gb;
    if (accentW > 0 && flower > 0) { const k = flower * 0.75; cr = lerp(cr, ar, k); cg = lerp(cg, ag, k); cb = lerp(cb, ab, k); }
    const sandC = dom >= 0 ? pal[dom].sand : WILD.sand;
    if (sand > 0) {
      if (h >= 0) { cr = lerp(cr, sandC[0], sand); cg = lerp(cg, sandC[1], sand); cb = lerp(cb, sandC[2], sand); }
      else {
        const d = clamp01(-h / 4.5);
        // Seabed: pale sand in the shallows, deep teal further down (the water shader adds the rest).
        cr = lerp(sandC[0] * 0.92, 0.02, d); cg = lerp(sandC[1] * 0.95, 0.16, d); cb = lerp(sandC[2] * 0.9, 0.2, d);
      }
    }
    // Forest floor: a little darker under dense stands (soft baked occlusion).
    const shade = 1 - forest * 0.32;
    out.h = h; out.land = land;
    out.r = cr * shade; out.g = cg * shade; out.b = cb * shade;
    out.rr = rr; out.rg = rg; out.rb = rb;
    out.sand = sand; out.snow = snow; out.special = special; out.forest = forest;
    out.site = domW > 0.12 ? dom : -1; out.biome = out.site >= 0 ? biomeIndex[out.site] : -1; out.pad = pad;
    return out;
  }
  const probe = newSample();
  SITES.forEach((site, i) => {
    const d = siteDir(site); let sum = 0, n = 0;
    for (let k = 0; k < 7; k++) {
      const p = k === 0 ? d : bearingOffset(d, k * 60, 1.7);
      sum += sample(p[0], p[1], p[2], probe, false).h; n++;
    }
    padH[i] = Math.min(9, Math.max(site.pad * 0.7, 0.8, sum / n));
  });
  return { sample, volcano: volcano as null | { x: number; y: number; z: number }, padHeight: (i: number) => padH[i] };
}
export type Terrain = ReturnType<typeof createTerrain>;
