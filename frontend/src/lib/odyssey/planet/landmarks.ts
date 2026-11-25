/* The fifteen landmarks of the Echo Living Planet, built from primitives in a local frame:
   X = east, Y = up (radial), Z = south (the default camera looks north, so +Z is the landmark's front).
   Units: world units (planet radius 100; 1° ≈ 1.75 units; a landmark plateau is ~7 units across).
   Every landmark is original geometry written for English Coach. */
import * as THREE from 'three';
import { Kit, T, blob, gableRoof, curvedRoof } from './kit';
import type { Landmark } from './layout';

export interface LandmarkResult { beacon: [number, number, number]; mills: { p: [number, number, number]; ry: number; r: number }[]; lights: [number, number, number][] }

const C = {
  stone: '#ece4d2', warm: '#dcc9a7', grey: '#aaa49b', dark: '#6e6862', basalt: '#3d3836', wood: '#8d5c37', darkWood: '#5a3a24',
  red: '#c9463a', blue: '#3f70ab', teal: '#2d8f9c', gold: '#e3b84c', white: '#f8f4ea', ink: '#4a3b7c', pink: '#f2a7c3', jade: '#5aa58c',
  glow: '#ffd27a', sand: '#efdcab', lava: '#ff7a2a', ice: '#e9f4fb', moss: '#6aa36f', copper: '#4f9f8f', canvas: '#f4ead2',
};

const box = (k: Kit, w: number, h: number, d: number, x: number, y: number, z: number, color: string, ry = 0, glow = 0) =>
  k.add(new THREE.BoxGeometry(w, h, d), T(x, y + h / 2, z, 0, ry), color, 0, glow);
const cyl = (k: Kit, rt: number, rb: number, h: number, x: number, y: number, z: number, color: string, seg = 12, glow = 0) =>
  k.add(new THREE.CylinderGeometry(rt, rb, h, seg), T(x, y + h / 2, z), color, 0, glow);
const cone = (k: Kit, r: number, h: number, x: number, y: number, z: number, color: string, seg = 12) =>
  k.add(new THREE.ConeGeometry(r, h, seg), T(x, y + h / 2, z), color);
const ball = (k: Kit, r: number, x: number, y: number, z: number, color: string, glow = 0, seg = 10) =>
  k.add(new THREE.SphereGeometry(r, seg, Math.max(6, seg * 0.7 | 0)), T(x, y, z), color, 0, glow);

/** A small house: walls + gable roof (+ lit window). Used by landmarks; villages use instancing. */
function house(k: Kit, x: number, y: number, z: number, ry: number, w: number, d: number, h: number, wall: string, roof: string) {
  const m = T(x, y, z, 0, ry);
  k.add(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), m, wall);
  k.add(gableRoof(w, d, h * 0.62).translate(0, h, 0), m, roof);
  k.add(new THREE.BoxGeometry(w * 0.22, h * 0.3, 0.03).translate(w * 0.18, h * 0.45, d / 2 + 0.01), m, C.glow, 0, 0.8);
}

function arches(k: Kit, count: number, radius: number, y: number, h: number, color: string, from = 0, to = Math.PI * 2) {
  for (let i = 0; i < count; i++) {
    const a = from + (to - from) * (i + 0.5) / count;
    cyl(k, 0.16, 0.2, h, Math.cos(a) * radius, y, Math.sin(a) * radius, color, 8);
  }
}

const builders: Record<Landmark, (k: Kit, r: LandmarkResult) => void> = {
  lighthouse(k, r) {
    // Rocky promontory base, keeper's cottage, striped tower, gallery, glowing lantern, red cap; a pier to the south-east.
    k.add(blob(1, 0.35, 3), T(0.6, 0.2, 0.4, 0, 0, 0, 2.6, 0.9, 2.2), C.grey);
    for (let i = 0; i < 6; i++) cyl(k, 0.82 - i * 0.07, 0.88 - i * 0.07, 0.9, 0, 0.9 + i * 0.9, 0, i % 2 ? C.red : C.white, 18);
    cyl(k, 1.05, 1.05, 0.14, 0, 6.3, 0, C.dark, 20);
    arches(k, 10, 0.95, 6.44, 0.36, C.dark);
    cyl(k, 0.5, 0.5, 0.75, 0, 6.44, 0, C.glow, 14, 1);
    cone(k, 0.7, 0.85, 0, 7.19, 0, C.red, 16);
    ball(k, 0.12, 0, 8.1, 0, C.gold);
    house(k, -1.9, 0.75, 0.9, 0.3, 1.5, 1.2, 1.05, C.white, C.teal);
    for (let i = 0; i < 7; i++) box(k, 0.7, 0.14, 0.62, 1.6 + i * 0.55, 0.4, 2.1 + i * 0.62, C.wood, -0.7);
    for (let i = 0; i < 7; i += 2) cyl(k, 0.07, 0.07, 1.2, 1.9 + i * 0.55, -0.7, 2.4 + i * 0.62, C.darkWood, 6);
    r.beacon = [0, 9.6, 0]; r.lights.push([0, 6.8, 0]);
  },
  pavilion(k, r) {
    // Stone terrace, red pillars, double curved roof, a torii in front, stone lanterns, a still pond.
    box(k, 4.4, 0.45, 4.4, 0, 0, 0, C.stone);
    box(k, 3.6, 0.3, 3.6, 0, 0.45, 0, C.warm);
    for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) cyl(k, 0.13, 0.15, 1.9, x, 0.75, z, C.red, 10);
    box(k, 2.6, 1.5, 2.6, 0, 0.75, 0, '#f6efe0');
    k.add(curvedRoof(2.9, 1.1, 0.55), T(0, 3.15, 0), '#5b3f6e');
    cyl(k, 0.95, 0.95, 0.5, 0, 3.7, 0, C.red, 8);
    k.add(curvedRoof(1.8, 0.85, 0.4), T(0, 4.6, 0), '#5b3f6e');
    cone(k, 0.12, 0.9, 0, 5.0, 0, C.gold, 8);
    for (const x of [-1.05, 1.05]) cyl(k, 0.12, 0.14, 2.3, x, 0, 4.4, C.red, 10);
    box(k, 3.0, 0.22, 0.35, 0, 2.15, 4.4, '#2b2324'); box(k, 2.5, 0.16, 0.24, 0, 1.75, 4.4, C.red);
    for (const [x, z] of [[-2.6, 2.2], [2.6, 2.2], [-2.6, -2.2], [2.6, -2.2]]) {
      box(k, 0.36, 0.5, 0.36, x, 0, z, C.grey); box(k, 0.44, 0.34, 0.44, x, 0.5, z, C.glow, 0, 0.9); cone(k, 0.42, 0.3, x, 0.84, z, C.grey, 4);
    }
    k.add(new THREE.CylinderGeometry(1.5, 1.5, 0.05, 28), T(-3.4, 0.05, -1.2), '#6fb3c9', 0, 0.05);
    r.beacon = [0, 6.8, 0]; r.lights.push([0, 1.6, 0]);
  },
  worldtree(k, r) {
    // The Wordroot: a vast trunk on spreading roots, a layered canopy, a platform with a lantern.
    k.add(new THREE.CylinderGeometry(0.75, 1.5, 6.5, 14, 6), T(0, 3.25, 0, 0, 0.4, 0.04), '#6a4a2f');
    for (let i = 0; i < 7; i++) { const a = i / 7 * Math.PI * 2; k.add(new THREE.CylinderGeometry(0.12, 0.45, 3.0, 7), T(Math.cos(a) * 1.5, 0.35, Math.sin(a) * 1.5, Math.sin(a) * 1.25, 0, -Math.cos(a) * 1.25), '#5d4029'); }
    for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2 + 0.3; k.add(new THREE.CylinderGeometry(0.18, 0.38, 3.2, 7), T(Math.cos(a) * 1.4, 6.6, Math.sin(a) * 1.4, Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9), '#6a4a2f'); }
    const greens = ['#2f7d32', '#3e9234', '#2a6b2c', '#4fa23a', '#368b30'];
    const crowns: [number, number, number, number][] = [[0, 9.2, 0, 3.6], [2.6, 8.2, 0.8, 2.4], [-2.5, 8.4, -0.6, 2.5], [0.6, 8.0, 2.6, 2.2], [-0.8, 8.3, -2.6, 2.3], [1.4, 10.6, -1.0, 2.0], [-1.4, 10.4, 1.2, 1.9]];
    crowns.forEach(([x, y, z, s], i) => k.add(blob(2, 0.28, i * 7.1), T(x, y, z, 0, 0, 0, s, s * 0.78, s), greens[i % greens.length], 0, 0, [0.62, -0.6]));
    box(k, 2.4, 0.16, 2.4, 0, 4.2, 0, C.wood, 0.4);
    cyl(k, 0.18, 0.18, 0.4, 1.0, 4.36, 0.6, C.glow, 8, 1);
    r.beacon = [0, 14.2, 0]; r.lights.push([1.0, 4.6, 0.6]);
  },
  tidetower(k, r) {
    // An octagonal sea tower in three stages, crenellated, with a slate cone and a wave banner.
    cyl(k, 2.1, 2.4, 1.0, 0, 0, 0, C.grey, 8);
    cyl(k, 1.55, 1.75, 3.8, 0, 1.0, 0, C.stone, 8);
    cyl(k, 1.85, 1.85, 0.3, 0, 4.8, 0, C.dark, 8);
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; box(k, 0.42, 0.42, 0.42, Math.cos(a) * 1.68, 5.1, Math.sin(a) * 1.68, C.stone, -a); }
    cyl(k, 1.2, 1.35, 2.8, 0, 5.1, 0, C.warm, 8);
    for (let i = 0; i < 8; i++) { const a = (i + 0.5) / 8 * Math.PI * 2; box(k, 0.28, 0.6, 0.05, Math.cos(a) * 1.25, 6.2, Math.sin(a) * 1.25, C.glow, -a + Math.PI / 2, 0.9); }
    cone(k, 1.55, 2.6, 0, 7.9, 0, C.blue, 8);
    cyl(k, 0.04, 0.04, 1.4, 0, 10.4, 0, C.dark, 6);
    k.add(new THREE.PlaneGeometry(0.9, 0.45, 4, 1), T(0.45, 11.5, 0, 0, 0, 0), C.teal);
    box(k, 1.0, 1.6, 0.25, 0, 1.0, 1.62, C.darkWood);
    for (let i = 0; i < 5; i++) box(k, 1.1, 0.25, 0.5, 0, 0.0 + i * 0.2, 2.3 + i * 0.45, C.grey);
    r.beacon = [0, 13.2, 0]; r.lights.push([0, 6.2, 0]);
  },
  atoll(k, r) {
    // The Listening Shell: a great spiral conch on the central islet, a stilt hut, coral heads in the shallows.
    const shell = new THREE.LatheGeometry(Array.from({ length: 14 }, (_, i) => new THREE.Vector2(0.15 + Math.sin(i / 13 * Math.PI) * (1.8 - i * 0.1), i * 0.32)), 24);
    k.add(shell, T(0, 0.6, 0, 0.0, 0, 1.2), '#f7d9c4');
    k.add(new THREE.TorusGeometry(1.2, 0.35, 10, 24, Math.PI * 1.4), T(-0.5, 1.4, 0, 0, 0, 0.6), '#f1b9a6');
    k.add(new THREE.ConeGeometry(0.7, 3.4, 16), T(1.7, 3.0, 0, 0, 0, -1.25), '#f5cfb6');
    for (const [x, z] of [[-2.2, 1.5], [-2.2, 2.6], [-1.2, 1.5], [-1.2, 2.6]]) cyl(k, 0.07, 0.07, 1.4, x, -0.4, z, C.darkWood, 6);
    box(k, 1.5, 0.14, 1.5, -1.7, 1.0, 2.05, C.wood);
    box(k, 1.2, 0.8, 1.0, -1.7, 1.14, 2.05, C.sand);
    k.add(gableRoof(1.2, 1.0, 0.6).translate(0, 1.94, 0), T(-1.7, 0, 2.05), '#d9a65a');
    const corals = ['#ff7a8a', '#ffb347', '#c77dff', '#4fd1c5', '#ff6fb5'];
    for (let i = 0; i < 18; i++) {
      const a = i * 2.4, d = 4.5 + (i % 5) * 0.9;
      k.add(blob(1, 0.5, i), T(Math.cos(a) * d, -0.55, Math.sin(a) * d, 0, 0, 0, 0.45 + (i % 3) * 0.2, 0.35, 0.45), corals[i % corals.length], 0, 0.15);
    }
    r.beacon = [0, 7.6, 0]; r.lights.push([-1.7, 1.6, 2.05]);
  },
  amphitheatre(k, r) {
    // Stepped stone seating in a half ring facing a stage with columns and a sail canopy.
    for (let i = 0; i < 5; i++) {
      k.add(new THREE.CylinderGeometry(3.6 - i * 0.12 + i * 0.5, 3.6 + i * 0.5, 0.36, 36, 1, false, Math.PI * 0.05, Math.PI * 0.9), T(0, i * 0.36 + 0.18, -0.4), i % 2 ? C.warm : C.stone);
    }
    k.add(new THREE.CylinderGeometry(2.6, 2.6, 0.4, 32, 1, false, 0, Math.PI * 2), T(0, 0.2, 0.4), C.stone);
    box(k, 3.4, 0.5, 1.2, 0, 0, 2.6, C.warm);
    for (let i = 0; i < 6; i++) cyl(k, 0.13, 0.15, 2.4, -1.5 + i * 0.6, 0.5, 2.9, C.white, 10);
    box(k, 3.8, 0.3, 0.6, 0, 2.9, 2.9, C.stone);
    // Three sailcloth awnings shading the stage, on slim masts.
    for (const x of [-1.3, 0, 1.3]) k.add(new THREE.ConeGeometry(0.75, 0.42, 3).rotateY(Math.PI / 6), T(x, 3.35, 2.9, 0, 0, 0, 1, 1, 0.75), x === 0 ? '#e9a05c' : C.canvas);
    for (const x of [-1.4, 1.4]) { cyl(k, 0.14, 0.14, 0.7, x, 0.5, 2.0, C.dark, 8); cyl(k, 0.2, 0.12, 0.25, x, 1.2, 2.0, C.glow, 8, 1); }
    r.beacon = [0, 6.8, 0]; r.lights.push([0, 1.4, 2.0]);
  },
  library(k, r) {
    // A classical library: stylobate, colonnade, pediment, a green copper dome and a tower of books.
    box(k, 5.6, 0.5, 4.4, 0, 0, 0, C.stone);
    for (let i = 0; i < 3; i++) box(k, 3.4 - i * 0.2, 0.18, 0.5, 0, 0, 2.4 + i * 0.4, C.stone);
    box(k, 4.6, 2.6, 3.4, 0, 0.5, 0, C.warm);
    for (let i = 0; i < 7; i++) cyl(k, 0.16, 0.19, 2.4, -1.95 + i * 0.65, 0.5, 1.95, C.white, 12);
    box(k, 4.9, 0.35, 0.7, 0, 2.9, 1.9, C.stone);
    k.add(gableRoof(4.9, 0.9, 0.9, 0.05).rotateY(0).translate(0, 3.25, 1.9), new THREE.Matrix4(), C.stone);
    for (let i = 0; i < 4; i++) box(k, 0.5, 0.5, 0.05, -1.5 + i, 1.4, 1.71, C.glow, 0, 0.75);
    cyl(k, 1.3, 1.3, 0.6, 0, 3.1, -0.4, C.stone, 20);
    k.add(new THREE.SphereGeometry(1.3, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2), T(0, 3.7, -0.4), C.copper);
    cone(k, 0.12, 0.7, 0, 4.95, -0.4, C.gold, 8);
    const books = ['#b8443a', '#3f6f9e', '#d9a441', '#4c8a5d', '#7a4f8f'];
    for (let i = 0; i < 9; i++) box(k, 1.2 - (i % 3) * 0.1, 0.32, 0.85, 3.6, 0.5 + i * 0.32, -1.0, books[i % books.length], i * 0.17);
    for (let i = 0; i < 3; i++) { box(k, 0.5, 2.0 - i * 0.5, 0.5, -3.4 + i * 0.4, 0, 1.6 - i * 1.1, C.grey, 0.3); }
    r.beacon = [0, 7.2, 0]; r.lights.push([0, 1.8, 1.8]);
  },
  scriptorium(k, r) {
    // A slender scriptorium on a stone base, an ink-dark dome like an inkwell and a quill spire.
    cyl(k, 1.9, 2.1, 0.6, 0, 0, 0, C.grey, 10);
    cyl(k, 1.1, 1.3, 4.4, 0, 0.6, 0, C.white, 10);
    for (let i = 0; i < 5; i++) { const a = i / 5 * Math.PI * 2; box(k, 0.25, 0.7, 0.05, Math.cos(a) * 1.16, 2.6, Math.sin(a) * 1.16, C.glow, -a + Math.PI / 2, 0.9); }
    cyl(k, 1.4, 1.4, 0.25, 0, 5.0, 0, C.dark, 12);
    k.add(new THREE.SphereGeometry(1.25, 20, 12), T(0, 5.9, 0, 0, 0, 0, 1, 0.85, 1), C.ink);
    cyl(k, 0.35, 0.5, 0.4, 0, 6.85, 0, C.ink, 12);
    k.add(new THREE.ConeGeometry(0.42, 3.2, 3), T(0.3, 8.6, 0, 0, 0, -0.32, 1, 1, 0.25), C.white);
    cyl(k, 0.04, 0.04, 1.6, 0.05, 6.9, 0, C.gold, 6);
    for (let i = 0; i < 6; i++) box(k, 0.6, 0.12, 0.6, 2.4 + i * 0.5, 0.0, 0.5 + i * 0.25, C.wood, 0.4);
    r.beacon = [0, 11.8, 0]; r.lights.push([0, 2.9, 0]);
  },
  bridges(k, r) {
    // A pavilion of meeting on the central islet; the arch bridges themselves are built by the planet builder.
    box(k, 2.6, 0.3, 2.6, 0, 0, 0, C.stone);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) cyl(k, 0.12, 0.14, 1.6, x, 0.3, z, C.white, 10);
    k.add(new THREE.SphereGeometry(1.45, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), T(0, 1.9, 0), C.teal);
    cyl(k, 1.5, 1.5, 0.2, 0, 1.75, 0, C.stone, 18);
    cone(k, 0.1, 0.6, 0, 3.3, 0, C.gold, 8);
    r.beacon = [0, 5.4, 0]; r.lights.push([0, 1.0, 0]);
  },
  port(k, r) {
    // A living port: quay wall, clock tower, a market hall with striped awnings, a crane.
    box(k, 6.0, 0.6, 1.2, 0.2, 0, 2.8, C.grey);
    box(k, 1.2, 4.8, 1.2, -2.0, 0.6, 0.4, C.warm);
    box(k, 1.4, 0.3, 1.4, -2.0, 5.4, 0.4, C.stone);
    k.add(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 18).rotateX(Math.PI / 2), T(-2.0, 4.6, 1.02), C.white, 0, 0.6);
    cone(k, 1.0, 1.5, -2.0, 5.7, 0.4, C.red, 4);
    box(k, 3.0, 1.6, 1.8, 1.2, 0.6, 0.0, C.white);
    k.add(gableRoof(3.0, 1.8, 0.9).translate(0, 2.2, 0), T(1.2, 0, 0), C.red);
    const awn = ['#e0533d', '#f2c14e', '#3a8fb7', '#5fb37a'];
    for (let i = 0; i < 4; i++) k.add(new THREE.BoxGeometry(0.8, 0.06, 0.7).rotateX(0.35), T(0.0 + i * 0.85, 1.4, 1.1), awn[i]);
    cyl(k, 0.1, 0.12, 3.0, 2.8, 0.6, 2.6, C.darkWood, 6);
    k.add(new THREE.BoxGeometry(2.4, 0.1, 0.1), T(2.0, 3.6, 2.6, 0, 0, -0.25), C.darkWood);
    r.beacon = [0, 8.4, 0]; r.lights.push([1.2, 1.4, 0.95]);
  },
  windmills(k, r) {
    // Trade winds: windmills (their sails turn in the scene), a warehouse, market tents and crates.
    const mill = (x: number, z: number, s: number, ry: number) => {
      cyl(k, 0.55 * s, 0.85 * s, 3.0 * s, x, 0, z, C.white, 10);
      cone(k, 0.75 * s, 1.1 * s, x, 3.0 * s, z, '#b4652e', 10);
      box(k, 0.35 * s, 0.6 * s, 0.05, x + Math.sin(ry) * 0.86 * s, 0.1, z + Math.cos(ry) * 0.86 * s, C.darkWood, ry);
      r.mills.push({ p: [x + Math.sin(ry) * 0.8 * s, 3.25 * s, z + Math.cos(ry) * 0.8 * s], ry, r: 1.9 * s });
    };
    mill(0, 0, 1.25, 0.2); mill(3.2, -1.6, 0.95, 0.5); mill(-3.0, -1.2, 1.0, -0.2); mill(-1.6, -3.4, 0.85, 0.1);
    box(k, 2.6, 1.3, 1.6, 2.5, 0, 2.0, C.warm); k.add(gableRoof(2.6, 1.6, 0.8).translate(0, 1.3, 0), T(2.5, 0, 2.0), '#a8692e');
    const tents = ['#e0533d', '#f2c14e', '#3a8fb7'];
    for (let i = 0; i < 3; i++) { box(k, 0.9, 0.5, 0.9, -2.2 + i * 1.2, 0, 2.6, C.canvas); cone(k, 0.75, 0.6, -2.2 + i * 1.2, 0.5, 2.6, tents[i], 4); }
    for (let i = 0; i < 5; i++) box(k, 0.38, 0.38, 0.38, 0.6 + (i % 3) * 0.42, (i > 2 ? 0.38 : 0), 3.0, C.wood, i);
    r.beacon = [0, 8.0, 0]; r.lights.push([2.5, 0.8, 2.85]);
  },
  citadel(k, r) {
    // A mountain citadel: curtain walls with corner towers, a keep with spires and banners.
    const wall = (x: number, z: number, w: number, d: number) => { box(k, w, 1.4, d, x, 0, z, C.stone); for (let i = 0; i < Math.max(w, d) / 0.5; i++) box(k, 0.25, 0.3, 0.25, x + (w > d ? -w / 2 + 0.25 + i * 0.5 : 0), 1.4, z + (d > w ? -d / 2 + 0.25 + i * 0.5 : 0), C.stone); };
    wall(0, 2.6, 5.4, 0.45); wall(0, -2.6, 5.4, 0.45); wall(2.6, 0, 0.45, 5.4); wall(-2.6, 0, 0.45, 5.4);
    for (const [x, z] of [[-2.6, -2.6], [2.6, -2.6], [-2.6, 2.6], [2.6, 2.6]]) { cyl(k, 0.55, 0.62, 2.4, x, 0, z, C.warm, 10); cone(k, 0.72, 1.3, x, 2.4, z, C.blue, 10); }
    box(k, 1.2, 1.6, 0.4, 0, 0, 2.75, C.darkWood);
    box(k, 2.6, 3.6, 2.4, 0, 0, -0.3, C.stone);
    for (let i = 0; i < 3; i++) box(k, 0.3, 0.5, 0.05, -0.8 + i * 0.8, 2.2, 0.91, C.glow, 0, 0.85);
    k.add(gableRoof(2.6, 2.4, 1.3).translate(0, 3.6, 0), T(0, 0, -0.3), C.blue);
    for (const [x, z, h] of [[-1.0, -1.2, 5.6], [1.1, -1.3, 6.4], [0, 0.6, 4.8]]) { cyl(k, 0.38, 0.42, h, x, 0, z, C.warm, 10); cone(k, 0.55, 1.6, x, h, z, C.blue, 10); cyl(k, 0.03, 0.03, 0.8, x, h + 1.5, z, C.dark, 4); k.add(new THREE.PlaneGeometry(0.5, 0.28), T(x + 0.25, h + 2.1, z), C.gold); }
    r.beacon = [0, 10.4, 0]; r.lights.push([0, 2.4, 0.95]);
  },
  observatory(k, r) {
    // A polar observatory: drum, a dome with an open slit and a telescope, a small ice station and an antenna.
    cyl(k, 2.1, 2.3, 1.6, 0, 0, 0, C.white, 24);
    k.add(new THREE.SphereGeometry(2.15, 28, 14, 0.35, Math.PI * 2 - 0.7, 0, Math.PI / 2), T(0, 1.6, 0), '#c9d7e6');
    k.add(new THREE.CylinderGeometry(0.32, 0.42, 3.0, 12), T(0.2, 3.2, 1.0, -0.75, 0, 0), C.dark);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; box(k, 0.4, 0.35, 0.05, Math.cos(a) * 2.2, 0.9, Math.sin(a) * 2.2, C.glow, -a + Math.PI / 2, 0.85); }
    box(k, 1.8, 1.0, 1.4, -3.1, 0, 1.0, C.ice); k.add(new THREE.SphereGeometry(0.9, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), T(-3.1, 1.0, 1.0, 0, 0, 0, 1.0, 0.6, 0.78), C.ice);
    cyl(k, 0.05, 0.08, 4.2, 2.8, 0, -1.2, C.dark, 6); ball(k, 0.18, 2.8, 4.3, -1.2, '#ff6a6a', 1, 8);
    r.beacon = [0, 6.6, 0]; r.lights.push([0, 1.0, 2.2]);
  },
  stonecircle(k, r) {
    // The Sanctuary of Return: a ring of standing stones with glowing runes around a spring altar.
    k.add(new THREE.CylinderGeometry(3.5, 3.7, 0.25, 40), T(0, 0, 0), C.moss);
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2, x = Math.cos(a) * 3.0, z = Math.sin(a) * 3.0, h = 1.6 + (i % 3) * 0.45;
      k.add(new THREE.BoxGeometry(0.55, h, 0.4).translate(0, h / 2, 0), T(x, 0.1, z, 0.04 * (i % 2 ? 1 : -1), -a, 0), '#a7b3ad');
      k.add(new THREE.BoxGeometry(0.2, 0.42, 0.02).translate(0, h * 0.6, 0.21), T(x, 0.1, z, 0, -a + Math.PI / 2, 0), '#8ff0e0', 0, 1);
    }
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.26; k.add(new THREE.BoxGeometry(0.5, 0.35, 3.0).translate(0, 0, 0), T(Math.cos(a) * 3.0, 2.25, Math.sin(a) * 3.0, 0, -a, 0), '#9aa6a0'); }
    cyl(k, 0.9, 1.1, 0.7, 0, 0.2, 0, C.grey, 16);
    k.add(new THREE.CylinderGeometry(0.75, 0.75, 0.05, 20), T(0, 0.92, 0), '#7fe3d3', 0, 0.8);
    r.beacon = [0, 6.0, 0]; r.lights.push([0, 1.2, 0]);
  },
  gateway(k, r) {
    // The Evidence Gateway: two basalt pillars and a lintel framing a glowing portal, braziers, a stair.
    for (const x of [-1.9, 1.9]) { box(k, 1.2, 6.2, 1.2, x, 0, 0, C.basalt); box(k, 1.5, 0.5, 1.5, x, 0, 0, '#2d2827'); box(k, 1.4, 0.4, 1.4, x, 6.2, 0, '#2d2827'); }
    box(k, 5.4, 0.9, 1.4, 0, 6.6, 0, C.basalt);
    k.add(new THREE.PlaneGeometry(2.6, 5.6, 1, 1), T(0, 3.2, 0.02), '#ffb15e', 0, 1);
    k.add(new THREE.PlaneGeometry(2.6, 5.6, 1, 1), T(0, 3.2, -0.02, 0, Math.PI, 0), '#ffb15e', 0, 1);
    for (let i = 0; i < 6; i++) box(k, 3.0 + i * 0.4, 0.2, 0.55, 0, 0.0 + 0, 1.0 + i * 0.5, C.dark);
    for (const x of [-3.2, 3.2]) { cyl(k, 0.3, 0.45, 1.2, x, 0, 1.4, C.basalt, 8); cyl(k, 0.42, 0.3, 0.3, x, 1.2, 1.4, C.lava, 8, 1); }
    r.beacon = [0, 9.4, 0]; r.lights.push([0, 3.2, 0.3]);
  },
};

export function buildLandmark(kind: Landmark, kit: Kit): LandmarkResult {
  const result: LandmarkResult = { beacon: [0, 8, 0], mills: [], lights: [] };
  builders[kind](kit, result);
  return result;
}
