import { Circle, Container, Geometry, Mesh, Shader, Sprite, Texture, UniformGroup } from "pixi.js";
import { WHALE_LENGTH, buildWhaleModel, type WhaleModel } from "./whaleModel";

/**
 * Echo Whale — a real-time 3D character (no pre-rendered views).
 *
 * The procedural model (`whaleModel.ts`, same design as the Blender master `build_whale.py`) is
 * evaluated every frame, rotated by a CONTINUOUS heading, pitch and bank, projected through the exact
 * 2:1 dimetric mapping of the world (screen = ((X+Y)·64, (X−Y)·32 − Z·78.38) for Blender X = gx,
 * Y = −gy) and shaded on the GPU with the world's own light rig (warm sun from screen-left, cool sky
 * fill, warm cloud bounce, soft rim). Back faces are culled and the remaining triangles are drawn far
 * to near (painter's order), so there is no depth buffer and no atlas: no view popping, no ghosting,
 * sharp at every zoom, and turning banks the body for real.
 *
 * Motion: a wide elliptical orbit (near arc in front of the island, far arc behind — the layer
 * switches at the orbit's extremes, outside the island silhouette); heading eased with momentum from
 * the world velocity; bank follows the turn rate (with recovery); pitch follows the vertical bob;
 * the swim cycle advances with speed; soft spout puffs on the near arc.
 */

const TILE_HALF_W = 64;
const TILE_HALF_H = 32;
const PX_PER_BU_Z = 78.38;

// camera / light basis in the Blender ground frame (identical to eg_common.py)
const S2 = Math.SQRT1_2;
const RIGHT = [S2, S2, 0];
const FWD_H = [-S2, S2, 0];
const ELEV = Math.PI / 6;
const FORWARD = [FWD_H[0] * Math.cos(ELEV), FWD_H[1] * Math.cos(ELEV), -Math.sin(ELEV)];
const SUN_DIR = (() => {
  const v = [RIGHT[0] * 0.7 + FWD_H[0] * 0.08, RIGHT[1] * 0.7 + FWD_H[1] * 0.08, -0.95];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

const VERTEX = `
in vec2 aPosition;
in vec3 aNormal;
in vec3 aColor;
in float aEmit;
out vec3 vNormal;
out vec3 vColor;
out float vEmit;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vNormal = aNormal;
  vColor = aColor;
  vEmit = aEmit;
}
`;

const FRAGMENT = `
in vec3 vNormal;
in vec3 vColor;
in float vEmit;
out vec4 finalColor;
uniform vec4 uColor;
uniform vec3 uLightDir;
uniform vec3 uViewDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uBounceColor;
uniform vec3 uHazeColor;
uniform float uHaze;
void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo = pow(vColor, vec3(2.2));
  float ndl = dot(n, uLightDir);
  // soft wrap lighting (stylized, painterly terminator)
  float diff = clamp((ndl + 0.3) / 1.3, 0.0, 1.0);
  diff = diff * diff * (3.0 - 2.0 * diff);
  vec3 light = uSunColor * diff;
  light += uSkyColor * (0.55 + 0.45 * n.z);
  light += uBounceColor * clamp(-n.z, 0.0, 1.0);
  vec3 col = albedo * light;
  vec3 h = normalize(uLightDir + uViewDir);
  float spec = pow(max(dot(n, h), 0.0), 40.0) * 0.22;
  col += spec * uSunColor * (1.0 - vEmit);
  float rim = pow(1.0 - max(dot(n, uViewDir), 0.0), 3.0);
  col += rim * 0.16 * uSkyColor;
  col = mix(col, albedo * 2.4, vEmit);
  // gentle filmic shoulder, back to display space
  col = vec3(1.0) - exp(-col * 1.15);
  col = pow(col, vec3(1.0 / 2.2));
  col = mix(col, uHazeColor, uHaze);
  finalColor = vec4(col * uColor.rgb, 1.0) * uColor.a;
}
`;

function angleLerp(a: number, b: number, k: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * k;
}

export class EchoWhale3D {
  readonly root = new Container();
  layer: "front" | "back" = "front";
  private readonly model: WhaleModel;
  private readonly mesh: Mesh<Geometry, Shader>;
  private readonly geometry: Geometry;
  private readonly local: Float32Array;
  private readonly world: Float32Array;
  private readonly pos2: Float32Array;
  private readonly normals: Float32Array;
  private readonly depth: Float32Array;
  private readonly triDepth: Float32Array;
  private readonly order: Uint32Array;
  private readonly index: Uint16Array;
  private readonly uniforms: UniformGroup;
  private readonly puffs: Array<{ s: Sprite; age: number }> = [];
  private readonly puffLayer = new Container();
  private phi = 2.1;
  private readonly omega = (Math.PI * 2) / 84;
  private heading = 0;
  private bank = 0;
  private pitch = 0;
  private swim = 0;
  private t = 0;
  private spoutClock = 6;
  /** Phase 3B: a milestone cheer in progress (start on the whale's own clock), or null */
  private cheerAt: number | null = null;
  /** Phase 3B: Echo has a hint for the player — a soft breathing halo marks the whale as worth a tap */
  attention = false;
  private readonly halo: Sprite;

  constructor(
    private readonly centre: { x: number; y: number },
    private readonly radii: { a: number; b: number },
    soft: Texture,
    private readonly baseScale = 1,
    detail: "high" | "low" = "high",
  ) {
    this.model = buildWhaleModel(detail);
    const n = this.model.vertexCount;
    this.local = new Float32Array(n * 3);
    this.world = new Float32Array(n * 3);
    this.normals = new Float32Array(n * 3);
    this.pos2 = new Float32Array(n * 2);
    this.depth = new Float32Array(n);
    const nt = this.model.triangles.length / 3;
    this.triDepth = new Float32Array(nt);
    this.order = new Uint32Array(nt);
    this.index = new Uint16Array(this.model.triangles.length);
    this.geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.pos2, format: "float32x2" },
        aNormal: { buffer: this.normals, format: "float32x3" },
        aColor: { buffer: this.model.colors, format: "float32x3" },
        aEmit: { buffer: this.model.emissive, format: "float32" },
      },
      indexBuffer: this.index,
    });
    const L = SUN_DIR.map((v) => -v);
    this.uniforms = new UniformGroup({
      uLightDir: { value: new Float32Array(L), type: "vec3<f32>" },
      uViewDir: { value: new Float32Array(FORWARD.map((v) => -v)), type: "vec3<f32>" },
      uSunColor: { value: new Float32Array([1.0 * 1.55, 0.925 * 1.55, 0.8 * 1.55]), type: "vec3<f32>" },
      uSkyColor: { value: new Float32Array([0.5 * 0.62, 0.66 * 0.62, 0.95 * 0.62]), type: "vec3<f32>" },
      uBounceColor: { value: new Float32Array([1.0 * 0.3, 0.94 * 0.3, 0.86 * 0.3]), type: "vec3<f32>" },
      uHazeColor: { value: new Float32Array([0.78, 0.86, 0.96]), type: "vec3<f32>" },
      uHaze: { value: 0, type: "f32" },
    });
    const shader = Shader.from({ gl: { vertex: VERTEX, fragment: FRAGMENT, name: "echo-whale-3d" }, resources: { whale: this.uniforms } });
    this.mesh = new Mesh({ geometry: this.geometry, shader });
    this.mesh.eventMode = "none";
    this.halo = new Sprite(soft);
    this.halo.anchor.set(0.5);
    this.halo.tint = 0x9cefe0;
    this.halo.blendMode = "add";
    this.halo.alpha = 0;
    this.halo.eventMode = "none";
    this.root.addChild(this.halo, this.mesh, this.puffLayer);
    for (let i = 0; i < 6; i++) {
      const s = new Sprite(soft);
      s.anchor.set(0.5);
      s.alpha = 0;
      s.tint = 0xf2fbff;
      this.puffLayer.addChild(s);
      this.puffs.push({ s, age: 99 });
    }
    this.root.eventMode = "static";
    this.root.cursor = "pointer";
    this.root.hitArea = new Circle(0, 0, 150);
    const v = this.velocity(1);
    this.heading = this.worldHeading(v.vx, v.vy);
    this.update(0, true);
  }

  /**
   * A milestone cheer: a short happy rise with a roll and a spout, layered on the normal swim (the orbit, the heading
   * and the swim cycle are untouched, so the whale never jumps or mirrors). Does nothing while one is running.
   */
  cheer() {
    if (this.cheerAt !== null) return;
    this.cheerAt = this.t;
    this.puffs.forEach((p, i) => (p.age = -i * 0.12));
  }

  /** depth in [0,1]: 1 = nearest point of the orbit */
  get depthFactor(): number {
    return (Math.sin(this.phi) + 1) / 2;
  }

  private velocity(speedMul: number) {
    const { a, b } = this.radii;
    return { vx: -a * Math.sin(this.phi) * this.omega * speedMul, vy: b * Math.cos(this.phi) * this.omega * speedMul };
  }

  /** Screen velocity of horizontal flight -> heading angle in the Blender ground frame (X=gx, Y=-gy). */
  private worldHeading(vx: number, vy: number): number {
    const sum = vy / TILE_HALF_H; // gx + gy
    const diff = vx / TILE_HALF_W; // gx - gy
    const dgx = (sum + diff) / 2;
    const dgy = (sum - diff) / 2;
    return Math.atan2(-dgy, dgx);
  }

  /** Evaluate, pose, project, light-ready normals, cull and painter-sort the model. */
  private pose(phase: number, scale: number) {
    const m = this.model;
    const n = m.vertexCount;
    m.evaluate(phase, this.local);
    // R = Rz(heading) * Ry(-pitch) * Rx(bank): nose along +x, bank about the body axis
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    const cp = Math.cos(-this.pitch), sp = Math.sin(-this.pitch);
    const cb = Math.cos(this.bank), sb = Math.sin(this.bank);
    const L = this.local;
    const W = this.world;
    const P = this.pos2;
    const D = this.depth;
    const fx = FORWARD[0], fy = FORWARD[1], fz = FORWARD[2];
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      // centre the body (model origin is mid-body already)
      const x = L[o], y = L[o + 1], z = L[o + 2];
      const y1 = y * cb - z * sb, z1 = y * sb + z * cb;
      const x2 = x * cp + z1 * sp, z2 = -x * sp + z1 * cp;
      const X = x2 * ch - y1 * sh, Y = x2 * sh + y1 * ch, Z = z2;
      W[o] = X;
      W[o + 1] = Y;
      W[o + 2] = Z;
      P[i * 2] = (X + Y) * TILE_HALF_W * scale;
      P[i * 2 + 1] = ((X - Y) * TILE_HALF_H - Z * PX_PER_BU_Z) * scale;
      D[i] = X * fx + Y * fy + Z * fz;
    }
    // vertex normals from face normals (world frame); back-face cull + depth key per triangle
    const N = this.normals;
    N.fill(0);
    const tris = m.triangles;
    const nt = tris.length / 3;
    const vx = -fx, vy = -fy, vz = -fz;
    let visible = 0;
    for (let t = 0; t < nt; t++) {
      const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
      const ux = W[b] - W[a], uy = W[b + 1] - W[a + 1], uz = W[b + 2] - W[a + 2];
      const wx = W[c] - W[a], wy = W[c + 1] - W[a + 1], wz = W[c + 2] - W[a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
      N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
      N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
      if (nx * vx + ny * vy + nz * vz > 0) {
        this.triDepth[t] = D[a / 3] + D[b / 3] + D[c / 3];
        this.order[visible++] = t;
      }
    }
    // painter's order: far (large depth) first
    const keys = this.triDepth;
    const ord = this.order.subarray(0, visible);
    ord.sort((p, q) => keys[q] - keys[p]);
    const idx = this.index;
    let k = 0;
    for (let i = 0; i < visible; i++) {
      const t = ord[i] * 3;
      idx[k++] = tris[t];
      idx[k++] = tris[t + 1];
      idx[k++] = tris[t + 2];
    }
    idx.fill(0, k); // culled triangles become degenerate
    this.geometry.getBuffer("aPosition").update();
    this.geometry.getBuffer("aNormal").update();
    this.geometry.indexBuffer.update();
  }

  update(dt: number, still = false) {
    this.t += dt;
    const speedMul = 1 + 0.28 * Math.sin(this.t * 0.21) + 0.12 * Math.sin(this.t * 0.53 + 1.3);
    if (!still) this.phi += this.omega * speedMul * dt;
    const { a, b } = this.radii;
    const bob = still ? 0 : Math.sin(this.t * 0.9) * 16 + Math.sin(this.t * 0.37 + 0.6) * 10;
    const bobV = still ? 0 : Math.cos(this.t * 0.9) * 0.9 * 16 + Math.cos(this.t * 0.37 + 0.6) * 0.37 * 10;
    // cheer: one eased arc (closed form in its age); reduced motion keeps only the spout
    let lift = 0, roll = 0, nose = 0;
    if (this.cheerAt !== null) {
      const u = (this.t - this.cheerAt) / 1.8;
      if (u >= 1) this.cheerAt = null;
      else if (!still) {
        const arc = Math.sin(Math.PI * u);
        lift = -46 * arc;
        roll = 0.42 * Math.sin(2 * Math.PI * u) * arc;
        nose = 0.22 * Math.cos(Math.PI * u) * arc;
      }
    }
    this.root.position.set(this.centre.x + a * Math.cos(this.phi), this.centre.y + b * Math.sin(this.phi) + bob + lift);
    this.layer = Math.sin(this.phi) >= 0 ? "front" : "back";

    // heading with momentum toward the world travel direction; bank follows the turn rate
    const v = this.velocity(speedMul);
    const want = this.worldHeading(v.vx, v.vy);
    const prev = this.heading;
    this.heading = still ? want : angleLerp(this.heading, want, 1 - Math.exp(-dt * 1.6));
    if (!still && dt > 0) {
      const turnRate = Math.atan2(Math.sin(this.heading - prev), Math.cos(this.heading - prev)) / dt;
      const wantBank = Math.max(-0.5, Math.min(0.5, -turnRate * 1.1));
      this.bank += (wantBank - this.bank) * (1 - Math.exp(-dt * 2.2));
      // rising -> nose up (screen y up is negative bobV)
      const wantPitch = Math.max(-0.16, Math.min(0.16, -bobV / 160));
      this.pitch += (wantPitch - this.pitch) * (1 - Math.exp(-dt * 2.0));
      this.swim += dt * (0.62 + 0.38 * speedMul);
    } else if (still) {
      this.bank = -0.2;
      this.pitch = 0;
    }

    // perspective: slightly smaller and hazier on the far arc
    const persp = 0.8 + 0.2 * this.depthFactor;
    const scale = this.baseScale * persp;
    const bank0 = this.bank, pitch0 = this.pitch;
    this.bank += roll;
    this.pitch += nose;
    this.pose(((this.swim % 1) + 1) % 1, scale);
    this.bank = bank0;
    this.pitch = pitch0;
    // hint halo: a soft teal breath around the body (never a blinking marker)
    const haloSize = WHALE_LENGTH * scale * 64 * 2.6;
    this.halo.scale.set(haloSize / this.halo.texture.width, (haloSize * 0.62) / this.halo.texture.height);
    this.halo.alpha = this.attention ? (still ? 0.3 : 0.24 + 0.1 * Math.sin(this.t * 1.7)) : 0;
    this.uniforms.uniforms.uHaze = 0.16 * (1 - this.depthFactor);

    // spout: soft puffs from the blowhole (front-top of the head), near arc only
    const Lb = WHALE_LENGTH * scale;
    const hx = Math.cos(this.heading) * 0.18 * WHALE_LENGTH;
    const hy = Math.sin(this.heading) * 0.18 * WHALE_LENGTH;
    const blow = {
      x: (hx + hy) * TILE_HALF_W * scale,
      y: ((hx - hy) * TILE_HALF_H - 0.55 * PX_PER_BU_Z) * scale,
    };
    this.root.hitArea = new Circle(0, 0, Math.max(60, Lb * 42));
    if (!still) {
      this.spoutClock -= dt;
      if (this.spoutClock <= 0) {
        this.spoutClock = 15 + Math.random() * 7;
        if (this.layer === "front") this.puffs.forEach((p, i) => (p.age = -i * 0.12));
      }
      for (const p of this.puffs) {
        p.age += dt;
        const q = p.age / 1.6;
        if (q < 0 || q > 1) {
          p.s.alpha = 0;
          continue;
        }
        p.s.position.set(blow.x + Math.sin(p.age * 3 + q) * 6, blow.y - q * 70);
        p.s.scale.set(0.35 + q * 0.9, 0.45 + q * 1.1);
        p.s.alpha = 0.7 * Math.sin(Math.min(1, q * 3) * Math.PI * 0.5) * (1 - q);
      }
    }
  }

  /** development diagnostics */
  debugState() {
    return {
      heading: +this.heading.toFixed(3),
      bank: +this.bank.toFixed(3),
      pitch: +this.pitch.toFixed(3),
      triangles: this.model.triangles.length / 3,
      vertices: this.model.vertexCount,
      puffs: this.puffs.filter((p) => p.s.alpha > 0).length,
    };
  }

  destroy() {
    this.root.destroy({ children: true });
    this.geometry.destroy(true);
  }
}
