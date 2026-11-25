import * as THREE from 'three';

/**
 * Event-bound effects. Every burst is emitted by a real game event (a door opening, a rejected door, a dash, the
 * finish); nothing here runs on its own schedule except ambient motes. Fixed-size pools: no allocation per frame.
 */
const pointVertex = /* glsl */`
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
varying float vAlpha; varying vec3 vColor;
void main(){ vAlpha = aAlpha; vColor = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (320.0 / -mv.z); gl_Position = projectionMatrix * mv; }`;
const pointFragment = /* glsl */`
varying float vAlpha; varying vec3 vColor;
void main(){ vec2 d = gl_PointCoord - .5; float r = length(d); if (r > .5) discard;
  float core = smoothstep(.5, .0, r); gl_FragColor = vec4(vColor * (1.0 + core), vAlpha * core); }`;

interface Particle { life: number; max: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; size: number; drag: number; gravity: number; r: number; g: number; b: number }

export class SkyEffects {
  readonly group = new THREE.Group();
  private points: THREE.Points;
  private positions: Float32Array; private colors: Float32Array; private sizes: Float32Array; private alphas: Float32Array;
  private particles: Particle[] = [];
  private cursor = 0;
  private lines: THREE.LineSegments;
  private linePositions: Float32Array;
  private lineSeeds: { a: number; r: number; z: number; len: number }[] = [];
  private lineMat: THREE.LineBasicMaterial;
  private motes: THREE.Points;
  private moteMat: THREE.PointsMaterial;
  private color = new THREE.Color();
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private aura: THREE.Mesh;
  private auraMat: THREE.MeshBasicMaterial;

  constructor(quality: 'high' | 'medium' | 'low') {
    const max = quality === 'low' ? 220 : quality === 'medium' ? 420 : 640;
    this.positions = new Float32Array(max * 3); this.colors = new Float32Array(max * 3); this.sizes = new Float32Array(max); this.alphas = new Float32Array(max);
    for (let i = 0; i < max; i++) this.particles.push({ life: 0, max: 1, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0, size: 0, drag: 0, gravity: 0, r: 1, g: 1, b: 1 });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(geometry, new THREE.ShaderMaterial({ vertexShader: pointVertex, fragmentShader: pointFragment, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.points.frustumCulled = false; this.group.add(this.points);

    // Speed streaks: thin lines in a tunnel around the camera, visible only above sprint pace.
    const lineCount = quality === 'low' ? 24 : 56;
    this.linePositions = new Float32Array(lineCount * 6);
    for (let i = 0; i < lineCount; i++) this.lineSeeds.push({ a: Math.random() * Math.PI * 2, r: 2.2 + Math.random() * 3.5, z: -Math.random() * 30, len: .8 + Math.random() * 1.8 });
    const lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.lines = new THREE.LineSegments(lineGeo, this.lineMat); this.lines.frustumCulled = false; this.group.add(this.lines);

    const moteCount = quality === 'low' ? 60 : 160, mp = new Float32Array(moteCount * 3);
    for (let i = 0; i < moteCount; i++) { mp[i * 3] = (Math.random() - .5) * 40; mp[i * 3 + 1] = Math.random() * 8 - 1; mp[i * 3 + 2] = -Math.random() * 120; }
    const moteGeo = new THREE.BufferGeometry(); moteGeo.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    this.moteMat = new THREE.PointsMaterial({ color: 0xfff3c4, size: .09, transparent: true, opacity: .75, depthWrite: false, blending: THREE.AdditiveBlending });
    this.motes = new THREE.Points(moteGeo, this.moteMat); this.motes.frustumCulled = false; this.group.add(this.motes);

    // Local runner marker ring and momentum aura (opacity grows with the earned streak).
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffd36e, transparent: true, opacity: .85, depthWrite: false, toneMapped: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(.34, .42, 40).rotateX(-Math.PI / 2), this.ringMat); this.ring.renderOrder = 2;
    this.auraMat = new THREE.MeshBasicMaterial({ color: 0x5ff0e0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.aura = new THREE.Mesh(new THREE.CircleGeometry(.62, 40).rotateX(-Math.PI / 2), this.auraMat);
    this.group.add(this.ring, this.aura);
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: number, size: number, life: number, gravity = 0, drag = 1.4) {
    const p = this.particles[this.cursor]; this.cursor = (this.cursor + 1) % this.particles.length;
    this.color.set(color);
    Object.assign(p, { life, max: life, x, y, z, vx, vy, vz, size, drag, gravity, r: this.color.r, g: this.color.g, b: this.color.b });
  }

  /** The chosen door dissolves into lane-coloured and golden shards that fly through the doorway. */
  doorBurst(x: number, z: number, lane: number, reduced: boolean) {
    const n = reduced ? 12 : 70;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 1.5 + Math.random() * 4;
      this.spawn(x + (Math.random() - .5) * 1.2, .4 + Math.random() * 2, z, Math.cos(a) * s * .6, Math.random() * 3 + 1, -Math.random() * 5 - 1, i % 3 ? lane : 0xffe39a, .22 + Math.random() * .3, .7 + Math.random() * .7, -4);
    }
  }
  /** A sealed door repels: red sparks thrown back toward the runner. */
  rejectBurst(x: number, z: number, reduced: boolean) {
    const n = reduced ? 6 : 34;
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 3; this.spawn(x + Math.cos(a) * .3, .5 + Math.random() * 1.6, z + .3, Math.cos(a) * s, Math.sin(a) * s * .6 + 1, Math.random() * 3 + 1, i % 2 ? 0xff5468 : 0xffa07a, .16 + Math.random() * .16, .45 + Math.random() * .3, -6); }
  }
  /** Dash burst behind the runner's feet. */
  dash(x: number, z: number, reduced: boolean) {
    const n = reduced ? 4 : 22;
    for (let i = 0; i < n; i++) this.spawn(x + (Math.random() - .5) * .6, .1 + Math.random() * .5, z + .3, (Math.random() - .5) * 1.5, Math.random() * .8, 3 + Math.random() * 4, 0x8ff6ff, .18 + Math.random() * .15, .35 + Math.random() * .25, 0, 3);
  }
  /** Dust ring on take-off / landing / a fall (strength scales the count and spread). */
  puff(x: number, z: number, strength: number, reduced: boolean) {
    const n = Math.round((reduced ? 6 : 26) * strength);
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, s = (1.2 + Math.random() * 1.6) * strength; this.spawn(x + Math.cos(a) * .2, .06, z + Math.sin(a) * .2, Math.cos(a) * s, .3 + Math.random() * .6, Math.sin(a) * s, i % 3 ? 0xf3e2bd : 0xffffff, .18 + Math.random() * .16 * strength, .45 + Math.random() * .3, -1, 3); }
  }
  /** Echo's recovery light: a rising spiral of teal and gold where the runner reappears. */
  respawn(x: number, z: number, reduced: boolean) {
    const n = reduced ? 10 : 48;
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 6, r = .45 + (i % 4) * .05; this.spawn(x + Math.cos(a) * r, .1 + i / n * 1.6, z + Math.sin(a) * r, -Math.sin(a) * .8, .9 + Math.random() * .5, Math.cos(a) * .8, i % 2 ? 0x5ff0e0 : 0xffd36e, .2 + Math.random() * .12, .7 + Math.random() * .4, 0, 1.2); }
  }
  footstep(x: number, z: number, strength: number) {
    for (let i = 0; i < 2; i++) this.spawn(x + (Math.random() - .5) * .25, .05, z + .1, (Math.random() - .5) * .6, .4 + Math.random() * .4, .8 + Math.random(), 0xf3e2bd, .1 + strength * .08, .35, -1.5, 2.5);
  }
  /** Momentum trail: small motes off the scarf while a streak is running. */
  trail(x: number, y: number, z: number, streak: number) {
    if (streak <= 0 || Math.random() > .25 + streak * .12) return;
    this.spawn(x + (Math.random() - .5) * .3, y, z + .25, (Math.random() - .5) * .3, Math.random() * .3, 1 + Math.random(), streak >= 4 ? 0xffd36e : 0x5ff0e0, .12 + streak * .02, .5, 0, 2);
  }
  confetti(x: number, z: number, reduced: boolean) {
    const n = reduced ? 20 : 140, palette = [0xff7f6e, 0xf6c453, 0x3fd2c7, 0xa98bff, 0xffffff];
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 5; this.spawn(x + (Math.random() - .5) * 2, 1 + Math.random(), z, Math.cos(a) * s * .5, 5 + Math.random() * 6, Math.sin(a) * s * .5, palette[i % palette.length], .2 + Math.random() * .2, 2.2 + Math.random() * 1.4, -5, .8); }
  }

  update(dt: number, time: number, camera: THREE.PerspectiveCamera, runner: THREE.Vector3, speed01: number, streak: number, reduced: boolean, local: boolean) {
    let live = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (p.life > 0) {
        p.life -= dt; const k = Math.exp(-p.drag * dt);
        p.vx *= k; p.vy = p.vy * k + p.gravity * dt; p.vz *= k;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; live++;
      }
      const alive = p.life > 0, t = alive ? p.life / p.max : 0;
      this.positions[i * 3] = p.x; this.positions[i * 3 + 1] = alive ? p.y : -999; this.positions[i * 3 + 2] = p.z;
      this.colors[i * 3] = p.r; this.colors[i * 3 + 1] = p.g; this.colors[i * 3 + 2] = p.b;
      this.sizes[i] = p.size * (.4 + .6 * t); this.alphas[i] = alive ? Math.min(1, t * 2.2) : 0;
    }
    const g = this.points.geometry;
    if (live || this.points.userData.wasLive) { for (const key of ['position', 'aColor', 'aSize', 'aAlpha']) (g.attributes[key] as THREE.BufferAttribute).needsUpdate = true; }
    this.points.userData.wasLive = live > 0;

    // Streaks in camera space, only when genuinely fast (sprint+momentum, dash, Echo Rush).
    const strength = reduced ? 0 : Math.max(0, (speed01 - .62) / .38);
    this.lineMat.opacity = strength * .5;
    if (strength > .01) {
      this.lineSeeds.forEach((s, i) => {
        s.z += dt * (24 + 30 * strength); if (s.z > 2) { s.z = -28 - Math.random() * 6; s.a = Math.random() * Math.PI * 2; }
        const x = camera.position.x + Math.cos(s.a) * s.r, y = camera.position.y - .4 + Math.sin(s.a) * s.r * .55, z = camera.position.z - 3 + s.z;
        this.linePositions.set([x, y, z, x, y, z - s.len * (1 + strength)], i * 6);
      });
      (this.lines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }

    // Motes travel with the camera window.
    const mp = this.motes.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < mp.count; i++) {
      let z = mp.getZ(i); if (z > camera.position.z + 4) z -= 120; if (z < camera.position.z - 116) z += 120;
      mp.setZ(i, z); if (!reduced) mp.setY(i, mp.getY(i) + Math.sin(time + i) * .002);
    }
    mp.needsUpdate = true;
    this.moteMat.opacity = .55 + .25 * Math.sin(time * .7);

    this.ring.visible = local; this.aura.visible = local;
    this.ring.position.set(runner.x, .02, runner.z);
    this.aura.position.set(runner.x, .015, runner.z);
    this.auraMat.opacity = Math.min(.55, streak * .1) * (reduced ? .6 : .8 + .2 * Math.sin(time * 6));
    this.auraMat.color.set(streak >= 4 ? 0xffd36e : 0x5ff0e0);
  }

  setRingColor(color: number) { this.ringMat.color.set(color); }

  dispose() {
    this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose();
    this.lines.geometry.dispose(); this.lineMat.dispose();
    this.motes.geometry.dispose(); this.moteMat.dispose();
    this.ring.geometry.dispose(); this.ringMat.dispose(); this.aura.geometry.dispose(); this.auraMat.dispose();
  }
}
