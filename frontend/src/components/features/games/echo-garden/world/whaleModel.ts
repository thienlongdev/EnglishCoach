/**
 * Echo Whale — procedural 3D model evaluated on the CPU every frame (no sprite atlas).
 *
 * The same stylized model as the Blender master (`build_whale.py`): lofted body with vertical spine
 * undulation, pitching fluke, paddling pectoral flippers, dorsal fin, eyes with highlights, blush.
 * Every part is a lofted closed surface (rings around a centre line), so one generic routine builds
 * the triangles, and their outward winding is fixed once from the rest pose.
 *
 * Local frame: +x = nose, +y = whale's left, +z = up; 1 unit = 1 Blender unit (grid tile).
 */

export const WHALE_LENGTH = 3.6;

const TAU = Math.PI * 2;

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function radius(u: number): number {
  if (u < 0.3) return Math.pow(1 - Math.pow(1 - u / 0.3, 2.4), 0.5);
  return 1 - 0.84 * Math.pow(smooth(0.3, 1.0, u), 0.9);
}

function section(u: number): [number, number, number] {
  const r = radius(u);
  const w = 0.66 * r * (1 - 0.45 * smooth(0.65, 1.0, u));
  const h = 0.6 * r * (1 + 0.15 * smooth(0.65, 1.0, u));
  const c = -0.05 * Math.sin(Math.PI * u) + 0.04 * (1 - u);
  return [w, h, c];
}

/** Vertical undulation at body position u for swim phase p in [0,1): amplitude grows to the tail. */
function spine(u: number, p: number): number {
  return 0.36 * Math.pow(u, 2.2) * Math.sin(TAU * p - 2.4 * u) - 0.035 * Math.pow(1 - u, 3) * Math.sin(TAU * p + 0.6);
}

const xu = (u: number) => WHALE_LENGTH * (0.5 - u);

function surface(u: number, a: number, p: number): [number, number, number] {
  const [w, h, c] = section(u);
  return [xu(u), w * Math.cos(a), c + h * Math.sin(a) + spine(u, p)];
}

function hex(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function mixc(a: number[], b: number[], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 3-stop ramp (positions 0, .5, 1). */
function ramp3(c0: number[], c1: number[], c2: number[], t: number) {
  return t < 0.5 ? mixc(c0, c1, t / 0.5) : mixc(c1, c2, (t - 0.5) / 0.5);
}

const C = {
  backLight: hex("#93dcf6"),
  backMid: hex("#56b8ea"),
  backDark: hex("#2a7fc4"),
  belly: hex("#f6eedb"),
  groove: hex("#e3d6bd"),
  line: hex("#2f6e95"),
  fin: hex("#4aa9de"),
  eye: hex("#141a24"),
  shine: hex("#ffffff"),
  blush: hex("#f49aa6"),
};

interface Part {
  /** first vertex index */
  v0: number;
  /** evaluate the part's local-space vertices for swim phase p into out (xyz triples from v0) */
  eval: (p: number, out: Float32Array) => void;
}

export interface WhaleModel {
  vertexCount: number;
  triangles: Uint16Array;
  /** per-vertex albedo (sRGB 0..1) */
  colors: Float32Array;
  /** per-vertex emissive flag (eye highlights) */
  emissive: Float32Array;
  /** fills local positions for swim phase p */
  evaluate: (p: number, out: Float32Array) => void;
}

type V3 = [number, number, number];

/**
 * Build a lofted closed surface: `rings[k]` are point loops (same count), `centres[k]` points inside.
 * Ends are closed with fans to `startTip` / `endTip` when given.
 */
function loftTriangles(v0: number, nRings: number, nAround: number, startTip: boolean, endTip: boolean): number[] {
  const tris: number[] = [];
  const idx = (k: number, j: number) => v0 + k * nAround + (j % nAround);
  for (let k = 0; k < nRings - 1; k++) {
    for (let j = 0; j < nAround; j++) {
      tris.push(idx(k, j), idx(k, j + 1), idx(k + 1, j + 1));
      tris.push(idx(k, j), idx(k + 1, j + 1), idx(k + 1, j));
    }
  }
  let tip = v0 + nRings * nAround;
  if (startTip) {
    for (let j = 0; j < nAround; j++) tris.push(tip, idx(0, j + 1), idx(0, j));
    tip++;
  }
  if (endTip) {
    for (let j = 0; j < nAround; j++) tris.push(tip, idx(nRings - 1, j), idx(nRings - 1, j + 1));
  }
  return tris;
}

function rotEuler(x: number, y: number, z: number): (v: V3) => V3 {
  // Blender XYZ euler: R = Rz * Ry * Rx
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return ([a, b, c]) => {
    const y1 = b * cx - c * sx, z1 = b * sx + c * cx; // Rx
    const x2 = a * cy + z1 * sy, z2 = -a * sy + z1 * cy; // Ry
    return [x2 * cz - y1 * sz, x2 * sz + y1 * cz, z2]; // Rz
  };
}

export function buildWhaleModel(detail: "high" | "low" = "high"): WhaleModel {
  const NU = detail === "high" ? 46 : 30;
  const NS = detail === "high" ? 26 : 18;
  const parts: Part[] = [];
  const colors: number[] = [];
  const emissive: number[] = [];
  const tris: number[] = [];
  let nv = 0;
  // rest-pose positions + inside reference points, used once to fix outward winding
  const restPos: number[] = [];
  const insideRef: number[] = [];

  const addVerts = (count: number, color: (i: number) => number[], emit = 0) => {
    const start = nv;
    for (let i = 0; i < count; i++) {
      colors.push(...color(i));
      emissive.push(emit);
    }
    nv += count;
    return start;
  };

  /* ---------------- body ---------------- */
  {
    const us: number[] = [];
    for (let i = 0; i <= NU; i++) us.push(0.004 + (0.99 * i) / NU);
    const v0 = addVerts((NU + 1) * NS + 2, (i) => {
      if (i >= (NU + 1) * NS) return i === (NU + 1) * NS ? C.backMid : C.fin;
      const u = us[Math.floor(i / NS)];
      const a = ((i % NS) / NS) * TAU;
      const s = Math.sin(a);
      const edge = -0.12 - 0.22 * smooth(0.12, 0.7, u);
      const belly = smooth(edge + 0.05, edge - 0.05, s) * (1 - smooth(0.62, 0.8, u));
      const top = smooth(-0.2, 0.95, s);
      const line = smooth(0.07, 0.01, Math.abs(s - edge)) * (1 - smooth(0.16, 0.26, u)) * smooth(0.01, 0.04, u);
      const groove = belly * Math.pow(0.5 + 0.5 * Math.cos(a * 22), 6) * smooth(0.6, 0.9, -s);
      const back = ramp3(C.backLight, C.backMid, C.backDark, top);
      const bellyC = mixc(C.belly, C.groove, groove);
      return mixc(mixc(back, bellyC, belly), C.line, line);
    });
    tris.push(...loftTriangles(v0, NU + 1, NS, true, true));
    parts.push({
      v0,
      eval: (p, out) => {
        let o = v0 * 3;
        for (let k = 0; k <= NU; k++) {
          const u = us[k];
          const [w, h, c] = section(u);
          const dz = spine(u, p);
          const x = xu(u);
          for (let j = 0; j < NS; j++) {
            const a = (j / NS) * TAU;
            out[o++] = x;
            out[o++] = w * Math.cos(a);
            out[o++] = c + h * Math.sin(a) + dz;
          }
        }
        out[o++] = xu(0) + 0.02;
        out[o++] = 0;
        out[o++] = section(0.004)[2] + spine(0, p);
        out[o++] = xu(1);
        out[o++] = 0;
        out[o++] = section(0.995)[2] + spine(1, p);
      },
    });
    // inside reference: centre line
    for (let k = 0; k <= NU; k++) {
      const u = us[k];
      const [, , c] = section(u);
      for (let j = 0; j < NS; j++) insideRef.push(xu(u), 0, c + spine(u, 0));
    }
    insideRef.push(xu(0.06), 0, section(0.06)[2], xu(0.95), 0, section(0.95)[2]);
  }

  /* ---------------- pectoral flippers ---------------- */
  const FR = 12;
  const FA = 8;
  for (const side of [1, -1]) {
    const v0 = addVerts(FR * FA, () => C.fin);
    tris.push(...loftTriangles(v0, FR, FA, false, false));
    // flipper strip in its own frame (Blender: top/bottom edges), then solid lens cross-sections
    const ring = (t: number): { mid: V3; ax: V3; nrm: V3 } => {
      const wd = 0.2 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.7) + 0.02;
      const top: V3 = [-t * 0.62, side * t * 0.12, wd * 0.5];
      const bot: V3 = [-t * 0.62 - wd * 0.6, side * t * 0.12, -wd * 0.5];
      const mid: V3 = [(top[0] + bot[0]) / 2, (top[1] + bot[1]) / 2, (top[2] + bot[2]) / 2];
      const ax: V3 = [(top[0] - bot[0]) / 2, (top[1] - bot[1]) / 2, (top[2] - bot[2]) / 2];
      // thickness direction: perpendicular to the strip (length dir x chord)
      const len: V3 = [-0.62, side * 0.12, 0];
      const n: V3 = [len[1] * ax[2] - len[2] * ax[1], len[2] * ax[0] - len[0] * ax[2], len[0] * ax[1] - len[1] * ax[0]];
      const nl = Math.hypot(n[0], n[1], n[2]) || 1;
      const th = 0.03 * (1 - 0.6 * t);
      return { mid, ax, nrm: [(n[0] / nl) * th, (n[1] / nl) * th, (n[2] / nl) * th] };
    };
    const rings = Array.from({ length: FR }, (_, k) => ring(0.02 + (0.97 * k) / (FR - 1)));
    const shape = (k: number, j: number): V3 => {
      const a = (j / FA) * TAU;
      const r = rings[k];
      const ca = Math.cos(a), sa = Math.sin(a);
      return [r.mid[0] + r.ax[0] * ca + r.nrm[0] * sa, r.mid[1] + r.ax[1] * ca + r.nrm[1] * sa, r.mid[2] + r.ax[2] * ca + r.nrm[2] * sa];
    };
    parts.push({
      v0,
      eval: (p, out) => {
        const root = surface(0.3, side > 0 ? -0.55 : Math.PI + 0.55, p);
        const flap = ((14 * Math.PI) / 180) * Math.sin(TAU * p + 1.2);
        const R = rotEuler(side * ((55 * Math.PI) / 180 + flap), (-18 * Math.PI) / 180, side * ((-28 * Math.PI) / 180));
        let o = v0 * 3;
        for (let k = 0; k < FR; k++) {
          for (let j = 0; j < FA; j++) {
            const q = R(shape(k, j));
            out[o++] = root[0] + q[0];
            out[o++] = root[1] + q[1];
            out[o++] = root[2] + q[2];
          }
        }
      },
    });
    {
      const root = surface(0.3, side > 0 ? -0.55 : Math.PI + 0.55, 0);
      const R = rotEuler(side * ((55 * Math.PI) / 180 + ((14 * Math.PI) / 180) * Math.sin(1.2)), (-18 * Math.PI) / 180, side * ((-28 * Math.PI) / 180));
      for (let k = 0; k < FR; k++) {
        const m = R(rings[k].mid);
        for (let j = 0; j < FA; j++) insideRef.push(root[0] + m[0], root[1] + m[1], root[2] + m[2]);
      }
    }
  }

  /* ---------------- fluke ---------------- */
  {
    const SPAN = 15; // rings per half span (centre ring shared)
    const NRF = SPAN * 2 + 1;
    const FA2 = 8;
    const v0 = addVerts(NRF * FA2, () => C.fin);
    tris.push(...loftTriangles(v0, NRF, FA2, false, false));
    const back = (t: number) => 0.42 * Math.pow(Math.sin(Math.PI * t), 0.8) + 0.18 * t * t * t - 0.08 * Math.pow(1 - t, 4);
    const local: V3[][] = [];
    const mids: V3[] = [];
    for (let k = 0; k < NRF; k++) {
      const s = -1 + (2 * k) / (NRF - 1);
      const t = Math.min(0.985, Math.abs(s));
      const y = 0.86 * t * Math.sign(s);
      const xL = 0.18 - 0.36 * t;
      const xT = -back(t);
      const cx = (xL + xT) / 2;
      const hc = Math.max(0.006, (xL - xT) / 2);
      const th = 0.05 * (1 - 0.65 * t);
      const ringPts: V3[] = [];
      for (let j = 0; j < FA2; j++) {
        const a = (j / FA2) * TAU;
        ringPts.push([cx + hc * Math.cos(a), y, th * Math.sin(a) * (0.6 + 0.4 * Math.cos(a) * 0.5 + 0.4)]);
      }
      local.push(ringPts);
      mids.push([cx, y, 0]);
    }
    const place = (p: number) => {
      const u = 0.995;
      const [, h] = section(u);
      const base = surface(u, Math.PI / 2, p);
      base[2] -= h;
      base[0] += 0.12;
      const du = 0.02;
      const slope = (spine(u, p) - spine(u - du, p)) / (WHALE_LENGTH * du);
      const lag = 0.55 * Math.sin(TAU * p - 2.4 - 1.1);
      const pitch = Math.atan(slope) + lag * 0.35;
      return { base, R: rotEuler(0, pitch, 0) };
    };
    parts.push({
      v0,
      eval: (p, out) => {
        const { base, R } = place(p);
        let o = v0 * 3;
        for (let k = 0; k < NRF; k++) {
          for (let j = 0; j < FA2; j++) {
            const q = R(local[k][j]);
            out[o++] = base[0] + q[0];
            out[o++] = base[1] + q[1];
            out[o++] = base[2] + q[2];
          }
        }
      },
    });
    {
      const { base, R } = place(0);
      for (let k = 0; k < NRF; k++) {
        const m = R(mids[k]);
        for (let j = 0; j < FA2; j++) insideRef.push(base[0] + m[0], base[1] + m[1], base[2] + m[2]);
      }
    }
  }

  /* ---------------- dorsal fin ---------------- */
  {
    const DR = 6;
    const DA = 8;
    const v0 = addVerts(DR * DA + 1, () => C.fin);
    tris.push(...loftTriangles(v0, DR, DA, false, true));
    const ringAt = (k: number) => {
      const t = k / (DR - 1);
      const x0 = -0.16 + (-0.2 + 0.16) * t;
      const x1 = 0.16 + (-0.02 - 0.16) * t;
      const z = -0.03 + 0.15 * t;
      return { cx: (x0 + x1) / 2, hc: Math.max(0.01, (x1 - x0) / 2), z, th: 0.025 * (1 - 0.6 * t) };
    };
    parts.push({
      v0,
      eval: (p, out) => {
        const root = surface(0.66, Math.PI / 2, p);
        let o = v0 * 3;
        for (let k = 0; k < DR; k++) {
          const r = ringAt(k);
          for (let j = 0; j < DA; j++) {
            const a = (j / DA) * TAU;
            out[o++] = root[0] + r.cx + r.hc * Math.cos(a);
            out[o++] = root[1] + r.th * Math.sin(a);
            out[o++] = root[2] + r.z;
          }
        }
        out[o++] = root[0] - 0.14;
        out[o++] = root[1];
        out[o++] = root[2] + 0.15;
      },
    });
    const root = surface(0.66, Math.PI / 2, 0);
    for (let k = 0; k < DR; k++) {
      const r = ringAt(k);
      for (let j = 0; j < DA; j++) insideRef.push(root[0] + r.cx, root[1], root[2] + r.z - 0.2);
    }
    insideRef.push(root[0] - 0.1, root[1], root[2] - 0.2);
  }

  /* ---------------- eyes, highlights, blush (ellipsoids riding on the surface) ---------------- */
  const ER = 7;
  const EA = 10;
  const ellipsoid = (
    color: number[],
    emit: number,
    at: (p: number) => V3,
    size: V3,
    rotZ = 0,
  ) => {
    const v0 = addVerts((ER - 2) * EA + 2, () => color, emit);
    // rings exclude the poles (fans close them)
    tris.push(...loftTriangles(v0, ER - 2, EA, true, true));
    const pts: V3[] = [];
    for (let k = 1; k < ER - 1; k++) {
      const phi = -Math.PI / 2 + (Math.PI * k) / (ER - 1);
      for (let j = 0; j < EA; j++) {
        const th = (j / EA) * TAU;
        pts.push([Math.cos(phi) * Math.cos(th) * size[0], Math.cos(phi) * Math.sin(th) * size[1], Math.sin(phi) * size[2]]);
      }
    }
    pts.push([0, 0, -size[2]], [0, 0, size[2]]);
    const cz = Math.cos(rotZ), sz = Math.sin(rotZ);
    const rp = pts.map(([x, y, z]) => [x * cz - y * sz, x * sz + y * cz, z] as V3);
    parts.push({
      v0,
      eval: (p, out) => {
        const c = at(p);
        let o = v0 * 3;
        for (const q of rp) {
          out[o++] = c[0] + q[0];
          out[o++] = c[1] + q[1];
          out[o++] = c[2] + q[2];
        }
      },
    });
    const c0 = at(0);
    for (let i = 0; i < rp.length; i++) insideRef.push(c0[0], c0[1], c0[2]);
  };
  for (const side of [1, -1]) {
    const nrm: V3 = (() => {
      const n: V3 = [0.15, side, 0.1];
      const l = Math.hypot(...n);
      return [n[0] / l, n[1] / l, n[2] / l];
    })();
    const eyeAt = (p: number): V3 => {
      const c = surface(0.13, side > 0 ? 0.12 : Math.PI - 0.12, p);
      return [c[0] + nrm[0] * 0.005, c[1] + nrm[1] * 0.005, c[2] + nrm[2] * 0.005];
    };
    ellipsoid(C.eye, 0, eyeAt, [0.085, 0.055, 0.1]);
    ellipsoid(C.shine, 1, (p) => {
      const c = surface(0.13, side > 0 ? 0.12 : Math.PI - 0.12, p);
      return [c[0] + nrm[0] * 0.05 + 0.025, c[1] + nrm[1] * 0.05, c[2] + nrm[2] * 0.05 + 0.035];
    }, [0.028, 0.016, 0.028]);
    ellipsoid(C.blush, 0, (p) => surface(0.17, side > 0 ? -0.28 : Math.PI + 0.28, p), [0.11, 0.025, 0.06], side * 0.3);
  }

  /* ---------------- fix outward winding once from the rest pose ---------------- */
  const evaluate = (p: number, out: Float32Array) => {
    for (const part of parts) part.eval(p, out);
  };
  const rest = new Float32Array(nv * 3);
  evaluate(0, rest);
  restPos.length = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = rest[b] - rest[a], uy = rest[b + 1] - rest[a + 1], uz = rest[b + 2] - rest[a + 2];
    const vx = rest[c] - rest[a], vy = rest[c + 1] - rest[a + 1], vz = rest[c + 2] - rest[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const ia = tris[t] * 3;
    // outward = away from the inside reference of the triangle's first vertex
    const gx = (rest[a] + rest[b] + rest[c]) / 3 - insideRef[ia];
    const gy = (rest[a + 1] + rest[b + 1] + rest[c + 1]) / 3 - insideRef[ia + 1];
    const gz = (rest[a + 2] + rest[b + 2] + rest[c + 2]) / 3 - insideRef[ia + 2];
    if (nx * gx + ny * gy + nz * gz < 0) {
      const tmp = tris[t + 1];
      tris[t + 1] = tris[t + 2];
      tris[t + 2] = tmp;
    }
  }

  return {
    vertexCount: nv,
    triangles: Uint16Array.from(tris),
    colors: Float32Array.from(colors),
    emissive: Float32Array.from(emissive),
    evaluate,
  };
}
