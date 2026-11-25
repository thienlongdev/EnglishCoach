import * as T from 'three';

/**
 * The strength meter: a glass column beside the furniture being moved, filled from cyan through blue, violet and orange to gold by the
 * force the person is putting in, with an arrow at the exact force the floor demands. Every number on it is the simulation's own
 * (newtons from mass and friction, the gauge the clicks feed): nothing on it is decoration that runs by itself. Drawn over the room
 * (never hidden behind a wall), facing the eyes, one draw call each for the column, the arrow, the label and the sparks.
 */
const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform float fill; uniform float need; uniform float time; uniform float glow; uniform float opacity; uniform float reached;
vec3 ramp(float y){
  vec3 c0 = vec3(.13,.83,.93), c1 = vec3(.23,.51,.96), c2 = vec3(.55,.36,.96), c3 = vec3(.98,.57,.24), c4 = vec3(.98,.80,.08);
  if (y < .28) return mix(c0, c1, y / .28);
  if (y < .55) return mix(c1, c2, (y - .28) / .27);
  if (y < .8) return mix(c2, c3, (y - .55) / .25);
  return mix(c3, c4, (y - .8) / .2);
}
float box(vec2 p, vec2 b, float r){ vec2 d = abs(p) - b + r; return length(max(d, 0.)) + min(max(d.x, d.y), 0.) - r; }
void main(){
  vec2 p = vUv - .5;
  // The capsule: rounded column with a glass rim.
  float d = box(p * vec2(1., 6.), vec2(.36, 2.86), .34);
  if (d > .03) discard;
  float rim = smoothstep(.03, -.02, d) - smoothstep(-.02, -.07, d);
  float inside = smoothstep(.0, -.05, d);
  float y = clamp((vUv.y - .035) / .93, 0., 1.);
  vec3 glass = vec3(.05,.09,.2);
  float a = .58 * inside;
  vec3 col = glass;
  // The force put in, from the bottom.
  float filled = step(y, fill) * inside;
  vec3 r = ramp(y);
  float shimmer = .5 + .5 * sin(y * 46. - time * 7.);
  col = mix(col, r * (1.05 + .25 * shimmer * glow), filled);
  a = mix(a, .96, filled);
  // The bright edge of the fill.
  float edge = exp(-pow((y - fill) * 90., 2.)) * inside;
  col += vec3(1.) * edge * .9;
  // The force the floor demands: a gold line across the column.
  float line = exp(-pow((y - need) * 140., 2.)) * smoothstep(.0, -.02, d);
  col = mix(col, vec3(1., .93, .6), line);
  a = max(a, line);
  // Past the line the whole column warms.
  col += r * .35 * reached * inside;
  col += vec3(.75,.9,1.) * rim * .85;
  a = max(a, rim * .9);
  gl_FragColor = vec4(col, a * opacity);
}`;

export class EffortMeter {
  readonly group = new T.Group();
  private bar: T.Mesh<T.PlaneGeometry, T.ShaderMaterial>;
  private arrow: T.Mesh<T.ShapeGeometry, T.MeshBasicMaterial>;
  private label: T.Sprite;
  private canvas: HTMLCanvasElement;
  private texture: T.CanvasTexture;
  private sparks: T.Points<T.BufferGeometry, T.PointsMaterial>;
  private sparkLife = new Float32Array(28);
  private sparkVel: T.Vector3[] = Array.from({ length: 28 }, () => new T.Vector3());
  private shown = 0;
  private wanted = false;
  private drawnKey = '';
  private reached = false;
  private font = 'sans-serif';
  private applied = 0;
  private need = 0;
  private max = 1;
  private vi = true;
  private time = 0;

  constructor() {
    this.bar = new T.Mesh(new T.PlaneGeometry(.075, .44), new T.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { fill: { value: 0 }, need: { value: .5 }, time: { value: 0 }, glow: { value: 0 }, opacity: { value: 0 }, reached: { value: 0 } },
    }));
    const tri = new T.Shape(); tri.moveTo(0, 0); tri.lineTo(.036, .02); tri.lineTo(.036, -.02); tri.closePath();
    this.arrow = new T.Mesh(new T.ShapeGeometry(tri), new T.MeshBasicMaterial({ color: '#ffe9a3', transparent: true, depthTest: false, depthWrite: false }));
    this.canvas = document.createElement('canvas'); this.canvas.width = 256; this.canvas.height = 512;
    this.texture = new T.CanvasTexture(this.canvas); this.texture.colorSpace = T.SRGBColorSpace;
    this.label = new T.Sprite(new T.SpriteMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false }));
    this.label.scale.set(.22, .44, 1); this.label.center.set(0, .5);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(28 * 3), 3));
    this.sparks = new T.Points(g, new T.PointsMaterial({ color: '#ffd76a', size: .018, transparent: true, depthTest: false, depthWrite: false, blending: T.AdditiveBlending, opacity: 0 }));
    for (const o of [this.bar, this.arrow, this.label, this.sparks]) { o.renderOrder = 999; o.frustumCulled = false; this.group.add(o); }
    this.group.visible = false;
    try { this.font = getComputedStyle(document.body).fontFamily || this.font; } catch { /* default face */ }
  }
  show(on: boolean, vi = true) { this.wanted = on; this.vi = vi; if (on) this.group.visible = true; }
  get visible() { return this.group.visible; }
  /** Newtons put in, newtons the floor demands, the most a person brings: the meter's scale. */
  set(applied: number, need: number, max: number) {
    this.applied = applied; this.need = need; this.max = Math.max(1, max);
    const now = applied >= need && need > 0;
    if (now && !this.reached) this.burst();
    this.reached = now;
  }
  private burst() {
    const pos = this.sparks.geometry.getAttribute('position') as T.BufferAttribute;
    const y = (this.need / this.max - .5) * .4;
    for (let i = 0; i < this.sparkLife.length; i++) {
      pos.setXYZ(i, (Math.random() - .5) * .05, y, 0);
      const a = Math.random() * Math.PI * 2;
      this.sparkVel[i].set(Math.cos(a) * (.18 + Math.random() * .3), Math.sin(a) * (.18 + Math.random() * .3) + .12, 0);
      this.sparkLife[i] = .45 + Math.random() * .4;
    }
    pos.needsUpdate = true;
  }
  private draw() {
    const key = `${Math.round(this.applied / 5) * 5}|${Math.round(this.need)}|${this.reached}|${this.vi}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    const c = this.canvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, 256, 512);
    c.textBaseline = 'middle';
    const needY = 512 * (1 - (.035 + .93 * Math.min(1, this.need / this.max)));
    const shadow = (fn: () => void) => { c.shadowColor = 'rgba(4,10,30,.85)'; c.shadowBlur = 10; fn(); c.shadowBlur = 0; };
    // Readable over a bright window or a lamp: the numbers stand on their own dark glass.
    const glass = (y: number, w: number, h: number) => { c.fillStyle = 'rgba(8,18,32,.62)'; c.beginPath(); c.roundRect(6, y - h / 2, w, h, 12); c.fill(); };
    glass(Math.min(470, Math.max(40, needY)), 210, 46);
    glass(needY < 110 ? 470 : 44, 178, 62);
    // Required: beside the arrow.
    c.font = `700 30px ${this.font}`;
    c.fillStyle = '#ffe9a3';
    shadow(() => c.fillText(`${this.vi ? 'cần' : 'need'} ${Math.round(this.need)} N`, 46, Math.min(470, Math.max(40, needY))));
    // Applied: at the top, coloured like the fill.
    const level = Math.min(1, this.applied / this.max);
    const hue = level < .28 ? '#38d6ee' : level < .55 ? '#6f8cff' : level < .8 ? '#a879ff' : level < .94 ? '#ff9a4a' : '#ffd23f';
    c.font = `800 44px ${this.font}`;
    c.fillStyle = this.reached ? '#ffe27a' : hue;
    const top = needY < 110 ? 470 : 44;
    shadow(() => c.fillText(`${Math.round(this.applied)} N`, 18, top));
    if (this.reached) { c.font = `700 24px ${this.font}`; c.fillStyle = '#fff4c4'; shadow(() => c.fillText(this.vi ? 'Đủ sức!' : 'Enough!', 20, top + (top < 200 ? 38 : -38))); }
    this.texture.needsUpdate = true;
  }
  /** Each frame: where it stands (world), the camera it faces, the room's scale; `dt` drives the fill and the sparks. */
  update(dt: number, anchor: T.Vector3, camera: T.Camera, scale: number, reduced: boolean) {
    this.time += dt;
    const target = this.wanted ? 1 : 0;
    this.shown += (target - this.shown) * (reduced ? 1 : 1 - Math.exp(-14 * dt));
    if (!this.wanted && this.shown < .02) { this.group.visible = false; this.shown = 0; return; }
    this.group.position.copy(anchor);
    // Beside the thing, but always in view: close up in first person the side of a desk is off the screen, so the meter is slid back
    // into the frame at the same depth (its numbers sit to its right, hence the narrower right margin).
    const parent = this.group.parent;
    if (parent && (camera as T.PerspectiveCamera).isPerspectiveCamera) {
      const world = parent.localToWorld(anchor.clone()), ndc = world.clone().project(camera);
      if (ndc.z < 1) {
        const x = T.MathUtils.clamp(ndc.x, -.78, .5), y = T.MathUtils.clamp(ndc.y, -.32, .52);
        if (x !== ndc.x || y !== ndc.y) this.group.position.copy(parent.worldToLocal(new T.Vector3(x, y, ndc.z).unproject(camera)));
      }
    }
    this.group.quaternion.copy(camera.quaternion);
    // A little overshoot as it appears, nothing while reduced motion is asked for.
    const pop = reduced ? 1 : this.shown * (1 + .12 * Math.sin(Math.min(1, this.shown) * Math.PI));
    this.group.scale.setScalar(Math.max(.001, pop * scale));
    const u = this.bar.material.uniforms, fill = Math.min(1, this.applied / this.max), need = Math.min(1, this.need / this.max);
    u.fill.value += (fill - u.fill.value) * (reduced ? 1 : 1 - Math.exp(-18 * dt));
    u.need.value = need; u.time.value = reduced ? 0 : this.time; u.glow.value = reduced ? 0 : 1; u.opacity.value = this.shown; u.reached.value += ((this.reached ? 1 : 0) - u.reached.value) * Math.min(1, dt * 8);
    this.arrow.position.set(.046, (.035 + .93 * need - .5) * .44, 0);
    this.arrow.material.opacity = this.shown;
    this.label.position.set(.088, 0, 0);
    (this.label.material as T.SpriteMaterial).opacity = this.shown;
    this.draw();
    const pos = this.sparks.geometry.getAttribute('position') as T.BufferAttribute;
    let alive = 0;
    for (let i = 0; i < this.sparkLife.length; i++) {
      if (this.sparkLife[i] <= 0) continue;
      this.sparkLife[i] -= dt; alive++;
      this.sparkVel[i].y -= .5 * dt;
      pos.setXYZ(i, pos.getX(i) + this.sparkVel[i].x * dt, pos.getY(i) + this.sparkVel[i].y * dt, 0);
    }
    if (alive) pos.needsUpdate = true;
    this.sparks.material.opacity = reduced ? 0 : Math.min(1, alive / 10) * this.shown;
  }
  dispose() {
    this.group.removeFromParent();
    this.bar.geometry.dispose(); this.bar.material.dispose();
    this.arrow.geometry.dispose(); this.arrow.material.dispose();
    (this.label.material as T.SpriteMaterial).dispose(); this.texture.dispose();
    this.sparks.geometry.dispose(); this.sparks.material.dispose();
  }
}
