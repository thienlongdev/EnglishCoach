import { CanvasSource, Texture } from "pixi.js";

/**
 * Night-glow textures are drawn additively over the scene. A glow whose light still has strength at the edge of its
 * own image is cut there, and at night the cut reads as a lit rectangle behind the crop or the tree (the premium crop
 * cultivars, the frost and phoenix Knowledge Tree sets, the frost house: their haze fills the whole image).
 *
 * `featherGlow` returns a copy whose HAZE fades to nothing before every edge. The emissive shapes themselves (a moon,
 * a glowing ear of wheat, a crystal: strong alpha) are kept as authored, also where they touch the edge; only a glow
 * that is mostly one solid white area is turned down as a whole. A glow that already ends inside its image is not
 * copied at all (null): its pixels reach the screen untouched.
 *
 * One pass over the pixels when the texture is loaded; nothing per frame, no filter, no render target.
 */

/** a border this faint cannot be seen as an edge (≈ 6 % of full light before the night weight) */
const BORDER_VISIBLE = 16;
/** alpha from which a pixel counts as part of the emissive shape rather than its haze */
const CORE_FROM = 0.58;
const CORE_FULL = 0.9;
/**
 * A glow that is mostly one solid near-white area (a whole field of glowing wheat, not a lantern or a few crystals) adds
 * up to plain white over its sprite and hides the art. From this share of solid near-white pixels on, the whole glow is
 * turned down, to at most the factor below: the crop still shines, and its ears can be seen again.
 */
const WHITE_SHARE_FROM = 0.08;
const WHITE_DIM_PER_SHARE = 2.2;
const WHITE_DIM_FLOOR = 0.55;

let scratch: HTMLCanvasElement | null = null;

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export function featherGlow(texture: Texture): Texture | null {
  if (typeof document === "undefined") return null;
  const source = texture.source;
  const image = source?.resource as CanvasImageSource | undefined;
  const w = source?.pixelWidth ?? 0;
  const h = source?.pixelHeight ?? 0;
  if (!image || w < 8 || h < 8) return null;
  try {
    scratch ??= document.createElement("canvas");
    if (scratch.width < w) scratch.width = w;
    if (scratch.height < h) scratch.height = h;
    const sctx = scratch.getContext("2d", { willReadFrequently: true });
    if (!sctx) return null;
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(image, 0, 0, w, h);
    const px = sctx.getImageData(0, 0, w, h);
    const d = px.data;
    let border = 0;
    for (let x = 0; x < w; x++) border = Math.max(border, d[x * 4 + 3], d[((h - 1) * w + x) * 4 + 3]);
    for (let y = 0; y < h; y++) border = Math.max(border, d[y * w * 4 + 3], d[(y * w + w - 1) * 4 + 3]);
    if (border < BORDER_VISIBLE) return null;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 230 && d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++;
    }
    const share = white / (w * h);
    const dim = share <= WHITE_SHARE_FROM ? 1 : Math.max(WHITE_DIM_FLOOR, 1 - (share - WHITE_SHARE_FROM) * WHITE_DIM_PER_SHARE);

    const m = Math.max(6, Math.min(56, Math.round(Math.min(w, h) * 0.2)));
    const fx = new Float32Array(w);
    for (let x = 0; x < w; x++) fx[x] = smooth(Math.min(x, w - 1 - x) / m);
    for (let y = 0; y < h; y++) {
      const fy = smooth(Math.min(y, h - 1 - y) / m);
      for (let x = 0; x < w; x++) {
        const mask = fx[x] * fy;
        const i = (y * w + x) * 4 + 3;
        if (mask >= 1) {
          if (dim < 1) d[i] = Math.round(d[i] * dim);
          continue;
        }
        const a = d[i] / 255;
        const core = smooth((a - CORE_FROM) / (CORE_FULL - CORE_FROM));
        d[i] = Math.round(d[i] * (mask + (1 - mask) * core) * dim);
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.putImageData(px, 0, 0);
    const out = new Texture({ source: new CanvasSource({ resource: canvas, resolution: source.resolution }) });
    out.source.scaleMode = "linear";
    return out;
  } catch {
    // a tainted or unreadable image: keep the authored texture
    return null;
  }
}
