import { ColorMatrixFilter, Container, RenderTexture, Sprite, type Renderer, type Texture } from "pixi.js";

/**
 * Dynamic cast shadows (art architecture for future gameplay).
 *
 * Every sprite (tree, building, bed, crop, prop) owns a separate shadow-factor texture rendered
 * in Blender (RGB light factor, white = unshadowed). They are composed into ONE render texture
 * with a MIN blend — overlapping shadows never double-darken — and that texture is multiplied
 * over the terrain. Nothing dynamic is baked into the terrain, so replacing a crop stage or
 * removing an object only re-composes this texture: no ghost shadow can remain.
 *
 * The composition is re-rendered only when something changes (not every frame).
 *
 * The displayed sprite is the composition converted ONCE per change into a darkness layer (black,
 * alpha = 1 - factor) drawn with normal blending: over the opaque island this equals multiplying by the
 * factor, and over transparent pixels (sky inside the graded scene's offscreen buffer) it adds nothing.
 * A multiply blend there would turn transparent sky into opaque black.
 */
export interface ShadowSpec {
  texture: Texture;
  /** anchor pixel inside the texture (ground point of the casting object) */
  ax: number;
  ay: number;
  /** texture px -> world px */
  scale: number;
}

export class ShadowLayer {
  readonly sprite: Sprite;
  private readonly wrapper = new Container();
  private readonly root = new Container();
  private readonly rt: RenderTexture;
  private readonly dark: RenderTexture;
  private readonly convert: Sprite;
  private readonly convertFilter: ColorMatrixFilter;
  private dirty = true;
  private capMask: Sprite | null = null;
  /** base (high-sun) horizontal scale of every caster's shadow sprite */
  private readonly baseScale = new Map<Sprite, number>();
  /** shadow length factor (1 = high sun; > 1 longer, lower sun) */
  private stretch = 1;

  constructor(
    private readonly renderer: Renderer,
    /** world rectangle covered by the composition */
    private readonly rect: { x: number; y: number; w: number; h: number },
    /** composition texels per world px (shadows are soft; 0.35 - 0.5 is plenty) */
    private readonly k: number,
  ) {
    this.rt = RenderTexture.create({ width: Math.ceil(rect.w * k), height: Math.ceil(rect.h * k), antialias: false });
    this.root.position.set(-rect.x * k, -rect.y * k);
    this.root.scale.set(k);
    this.wrapper.scale.set(1);
    this.wrapper.addChild(this.root);
    this.dark = RenderTexture.create({ width: this.rt.width, height: this.rt.height, antialias: false });
    this.convert = new Sprite(this.rt);
    this.convertFilter = new ColorMatrixFilter();
    // rgb -> 0, alpha -> 1 - factor (red channel; shadow factors are near-neutral)
    this.convertFilter.matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, 1];
    this.convert.filters = [this.convertFilter];
    this.sprite = new Sprite(this.dark);
    this.sprite.position.set(rect.x, rect.y);
    // exactly the covered rect (the RT is rounded up to whole texels; no overhang column)
    this.sprite.scale.set(rect.w / this.dark.width, rect.h / this.dark.height);
    // equals a multiply by the factor over the island (see class note)
    this.sprite.blendMode = "normal";
  }

  /** Add the shadow of an object standing at world point (x, y) with instance scale `s`. */
  add(spec: ShadowSpec, x: number, y: number, s = 1): Sprite {
    const sp = new Sprite(spec.texture);
    sp.anchor.set(spec.ax / spec.texture.width, spec.ay / spec.texture.height);
    sp.position.set(x, y);
    sp.scale.set(spec.scale * s * this.stretch, spec.scale * s);
    this.baseScale.set(sp, spec.scale * s);
    sp.blendMode = "min";
    if (this.capMask) this.root.addChildAt(sp, this.root.getChildIndex(this.capMask));
    else this.root.addChild(sp);
    this.dirty = true;
    return sp;
  }

  /**
   * Restrict shadows to the grass cap: a mask (black on the cap, white elsewhere) composed LAST with
   * a MAX blend turns every off-cap texel back to "unshadowed" — no shadow ever falls into the sky.
   */
  setCapMask(texture: Texture, scale: number) {
    const m = new Sprite(texture);
    m.position.set(this.rect.x, this.rect.y);
    // the mask must reach the rect's last texel column / row (its own size is rounded down)
    m.scale.set(Math.max(scale, this.rect.w / texture.width), Math.max(scale, this.rect.h / texture.height));
    m.blendMode = "max";
    this.root.addChild(m);
    this.capMask = m;
    this.dirty = true;
  }

  /** Swap the shadow of an existing caster (e.g. a crop changing growth stage). */
  replace(sp: Sprite, spec: ShadowSpec, s = 1) {
    sp.texture = spec.texture;
    sp.anchor.set(spec.ax / spec.texture.width, spec.ay / spec.texture.height);
    sp.scale.set(spec.scale * s * this.stretch, spec.scale * s);
    this.baseScale.set(sp, spec.scale * s);
    this.dirty = true;
  }

  /**
   * Sun height: every shadow is rendered with the sun from the screen-left, so it falls to the right of
   * its caster's ground anchor. A lower (sunset) sun lengthens it along that same direction — the
   * sprite is stretched about the caster's anchor, never mirrored. Re-composes only when it changes.
   */
  setStretch(k: number) {
    if (Math.abs(k - this.stretch) < 0.002) return;
    this.stretch = k;
    this.baseScale.forEach((b, sp) => sp.scale.set(b * k, b));
    this.dirty = true;
  }

  get currentStretch(): number {
    return this.stretch;
  }

  /** Phase 3E: the caster left the island (a decoration stored, a path style taken off): its shadow goes with it. */
  remove(sp: Sprite) {
    this.baseScale.delete(sp);
    if (!sp.destroyed) sp.destroy();
    this.dirty = true;
  }

  setVisible(sp: Sprite, visible: boolean) {
    if (sp.visible !== visible) {
      sp.visible = visible;
      this.dirty = true;
    }
  }

  markDirty() {
    this.dirty = true;
  }

  /** Re-compose if needed. Call once per frame; costs nothing while the world is unchanged. */
  update() {
    if (!this.dirty) return;
    this.renderer.render({ container: this.wrapper, target: this.rt, clear: true, clearColor: [1, 1, 1, 1] });
    this.renderer.render({ container: this.convert, target: this.dark, clear: true, clearColor: [0, 0, 0, 0] });
    this.dirty = false;
  }

  /** Composed shadow factor (0..255, 255 = no shadow) at a world point — used by dev validation. */
  sample(x: number, y: number): number {
    this.update();
    const px = this.renderer.extract.pixels(this.rt);
    const ix = Math.round((x - this.rect.x) * this.k);
    const iy = Math.round((y - this.rect.y) * this.k);
    const w = px.width;
    if (ix < 0 || iy < 0 || ix >= w || iy >= px.height) return 255;
    return px.pixels[(iy * w + ix) * 4];
  }

  destroy() {
    this.wrapper.destroy({ children: true });
    this.sprite.destroy();
    this.convert.destroy();
    this.convertFilter.destroy();
    this.rt.destroy(true);
    this.dark.destroy(true);
  }
}
