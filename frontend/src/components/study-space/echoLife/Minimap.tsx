'use client';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import jobs from '@/lib/echo-life/game/jobs.json';
import { cleanDisplayCopy } from '@/lib/echo-life/game/session';
import type { CityPlan } from '@/lib/echo-life/city';
import type { HousePlan, Rect } from '@/lib/echo-life/plan';
import type { CityZoneDef } from '@/lib/echo-life/zones';
import type { EchoLifeGameHost } from '../world/echoLife/gameHost';
import s from './echoLife.module.css';

const DEFAULT_CSS_SIZE = 140;
const CACHE_SCALE = 4.0; // offscreen static city pixels per metre (sharp even at 3.8x indoor zoom)
const PAD_METRES = 36;
const MAP_POLL_MS = 1000;
const DRAW_INTERVAL_MS = 80; // 12.5 Hz smooth radar refresh, 0 React re-renders
const POS_EPS_M = 0.04;
const POS_EPS_SQ = POS_EPS_M * POS_EPS_M;
const YAW_EPS_RAD = (0.4 * Math.PI) / 180;
const SCALE_EPS = 0.015;

const HOME_ZONE_SET = new Set([
  'study',
  'hall',
  'living',
  'kitchen',
  'bedroom',
  'bath',
  'gaming_room',
  'balcony',
  'garage',
  'stair',
  'lobby',
  'lobbyFoot',
]);

const OUTDOOR_REGIONS = new Set(['sidewalk', 'road', 'crossing', 'park', 'garden', 'plaza', 'balcony', 'yard', 'street']);

export type MinimapZoomMode = 'auto' | 'close' | 'street' | 'city';

const ZOOM_ORDER: readonly MinimapZoomMode[] = ['auto', 'close', 'street', 'city'];
const ZOOM_LABELS: Readonly<Record<MinimapZoomMode, string>> = {
  auto: 'Auto',
  close: '2x',
  street: '1x',
  city: '0.6x',
};

type PoiKind =
  | 'home'
  | 'cafe'
  | 'bistro'
  | 'library'
  | 'market'
  | 'park'
  | 'campus'
  | 'plaza'
  | 'atelier'
  | 'botanical';

interface StaticPoi {
  id: string;
  kind: PoiKind;
  x: number;
  z: number;
  priority: number;
}

export interface MinimapBeacon {
  x: number;
  z: number;
  kind: 'objective' | 'event' | 'shift' | 'waypoint';
  label?: string;
}

interface MinimapProps {
  host: EchoLifeGameHost;
  zone?: string;
  /** Optional externally supplied objective/event/shift/waypoint beacons (bypasses game.map() polling). */
  beacons?: readonly MinimapBeacon[];
  onExpand: () => void;
}

interface StaticCityCache {
  city: CityPlan;
  houseH: number;
  canvas: HTMLCanvasElement;
  originX: number;
  originZ: number;
  zoneById: Map<string, CityZoneDef>;
  pois: StaticPoi[];
}

function angleDeltaRad(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function rectCenter(r: Rect): { x: number; z: number } {
  return { x: (r.x0 + r.x1) * 0.5, z: (r.z0 + r.z1) * 0.5 };
}

/**
 * Pre-renders all static city and indoor house geometry (river, avenues, lane markings, crossings, parks,
 * indoor house rooms, stair treads, building footprints, and doorway ticks) once onto an offscreen canvas.
 */
function buildStaticCityCache(city: CityPlan, house: HousePlan): StaticCityCache {
  const houseFootprint = house.footprint;
  let minX = Math.min(city.bounds.x0, houseFootprint.x0);
  let maxX = Math.max(city.bounds.x1, houseFootprint.x1);
  let minZ = Math.min(city.bounds.z0, houseFootprint.z0);
  let maxZ = Math.max(city.bounds.z1, houseFootprint.z1);

  if (city.river) {
    minX = Math.min(minX, city.river.x0);
    maxX = Math.max(maxX, city.river.x1);
    minZ = Math.min(minZ, city.river.z0);
    maxZ = Math.max(maxZ, city.river.z1);
  }
  for (let i = 0; i < city.ground.length; i++) {
    const r = city.ground[i].rect;
    minX = Math.min(minX, r.x0);
    maxX = Math.max(maxX, r.x1);
    minZ = Math.min(minZ, r.z0);
    maxZ = Math.max(maxZ, r.z1);
  }

  const originX = minX - PAD_METRES;
  const originZ = minZ - PAD_METRES;
  const width = Math.max(128, Math.ceil((maxX - minX + PAD_METRES * 2) * CACHE_SCALE));
  const height = Math.max(128, Math.ceil((maxZ - minZ + PAD_METRES * 2) * CACHE_SCALE));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  if (ctx) {
    ctx.fillStyle = '#10232c';
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.setTransform(CACHE_SCALE, 0, 0, CACHE_SCALE, -originX * CACHE_SCALE, -originZ * CACHE_SCALE);

    // 1. River channel + subtle current band + crisp south embankment wall
    const rv = city.river;
    if (rv) {
      ctx.fillStyle = '#1d5570';
      ctx.fillRect(rv.x0, rv.z0, rv.x1 - rv.x0, rv.z1 - rv.z0);
      ctx.fillStyle = '#266989';
      ctx.fillRect(rv.x0, rv.z1 - 4.5, rv.x1 - rv.x0, 3.1);
      ctx.fillStyle = '#4e91b2';
      ctx.fillRect(rv.x0, rv.z1 - 1.35, rv.x1 - rv.x0, 1.35);
    }

    // 2. Decorative urban block lots (subtle architectural depth behind streets)
    if (city.lots?.length) {
      ctx.fillStyle = '#24363e';
      for (let i = 0; i < city.lots.length; i++) {
        const r = city.lots[i].rect;
        ctx.fillRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0);
      }
    }

    // 3. Walkable ground surfaces (parks, plazas, sidewalks, roads, crossings)
    for (let i = 0; i < city.ground.length; i++) {
      const g = city.ground[i];
      const r = g.rect;
      const w = r.x1 - r.x0;
      const d = r.z1 - r.z0;
      ctx.fillStyle =
        g.surface === 'road' ? '#56666d' :
        g.surface === 'crossing' ? '#607179' :
        g.surface === 'park' ? '#336853' :
        g.surface === 'garden' ? '#3a725b' :
        g.surface === 'plaza' ? '#5c6967' : '#3d4f53';
      ctx.fillRect(r.x0, r.z0, w, d);

      // Subtle GTA-style center road lane dashes on carriageways
      if (g.surface === 'road') {
        ctx.strokeStyle = 'rgba(226, 236, 240, 0.28)';
        ctx.lineWidth = 0.28;
        ctx.setLineDash([2.2, 2.4]);
        ctx.beginPath();
        if (w > d * 1.5) {
          const midZ = (r.z0 + r.z1) * 0.5;
          ctx.moveTo(r.x0 + 1.5, midZ);
          ctx.lineTo(r.x1 - 1.5, midZ);
        } else if (d > w * 1.5) {
          const midX = (r.x0 + r.x1) * 0.5;
          ctx.moveTo(midX, r.z0 + 1.5);
          ctx.lineTo(midX, r.z1 - 1.5);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (g.surface === 'crossing') {
        // Crisp pedestrian zebra stripes
        ctx.fillStyle = 'rgba(235, 244, 248, 0.42)';
        if (d >= w) {
          for (let z = r.z0 + 0.6; z < r.z1 - 0.5; z += 1.25) {
            ctx.fillRect(r.x0 + 0.25, z, Math.max(0.4, w - 0.5), 0.55);
          }
        } else {
          for (let x = r.x0 + 0.6; x < r.x1 - 0.5; x += 1.25) {
            ctx.fillRect(x, r.z0 + 0.25, 0.55, Math.max(0.4, d - 0.5));
          }
        }
      }
    }

    // 4. Enterable commercial/civic buildings & neighbor residences + doorway threshold ticks
    for (let i = 0; i < city.buildings.length; i++) {
      const b = city.buildings[i];
      const r = b.rect;
      ctx.fillStyle = b.id === 'library' ? '#8c7e99' : '#a68f78';
      ctx.fillRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0);
      ctx.strokeStyle = '#d8c5b0';
      ctx.lineWidth = 0.32;
      ctx.strokeRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0);
      if (b.door) {
        ctx.fillStyle = '#fde68a';
        const dw = b.door.wallAlong === 'x' ? 1.3 : 0.55;
        const dd = b.door.wallAlong === 'z' ? 1.3 : 0.55;
        ctx.fillRect(b.door.x - dw * 0.5, b.door.z - dd * 0.5, dw, dd);
      }
    }

    if (city.residences.length > 0) {
      for (let i = 0; i < city.residences.length; i++) {
        const b = city.residences[i];
        const r = b.rect;
        ctx.fillStyle = '#8d8075';
        ctx.fillRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0);
        ctx.strokeStyle = '#beb2a6';
        ctx.lineWidth = 0.26;
        ctx.strokeRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0);
        if (b.door) {
          ctx.fillStyle = '#fde68a';
          const dw = b.door.wallAlong === 'x' ? 1.1 : 0.5;
          const dd = b.door.wallAlong === 'z' ? 1.1 : 0.5;
          ctx.fillRect(b.door.x - dw * 0.5, b.door.z - dd * 0.5, dw, dd);
        }
      }
    }

    // 5. Detailed Player Home & Study Room indoor architectural plan
    ctx.fillStyle = '#5e717c';
    ctx.fillRect(
      houseFootprint.x0,
      houseFootprint.z0,
      houseFootprint.x1 - houseFootprint.x0,
      houseFootprint.z1 - houseFootprint.z0,
    );

    // Individual home rooms (hall, living, kitchen, bath, bedroom, gaming_room, lobby, garage)
    for (let i = 0; i < house.rooms.length; i++) {
      const rm = house.rooms[i];
      const rr = rm.rect;
      ctx.fillStyle =
        rm.id === 'living' || rm.id === 'bedroom' ? '#748894' :
        rm.id === 'kitchen' || rm.id === 'bath' ? '#6b828e' :
        rm.id === 'gaming_room' ? '#627992' :
        rm.id === 'stair' ? '#556873' : '#687b86';
      ctx.fillRect(rr.x0, rr.z0, rr.x1 - rr.x0, rr.z1 - rr.z0);
      ctx.strokeStyle = '#22333c';
      ctx.lineWidth = 0.24;
      ctx.strokeRect(rr.x0, rr.z0, rr.x1 - rr.x0, rr.z1 - rr.z0);
    }

    // Staircase tread lines
    if (house.stair) {
      const st = house.stair.rect;
      ctx.strokeStyle = 'rgba(226, 238, 245, 0.38)';
      ctx.lineWidth = 0.18;
      for (let z = st.z0 + 0.55; z < st.z1 - 0.3; z += 0.65) {
        ctx.beginPath();
        ctx.moveTo(st.x0 + 0.18, z);
        ctx.lineTo(st.x1 - 0.18, z);
        ctx.stroke();
      }
    }

    // Study Room highlight (player's sanctuary at [-h..h, -h..h])
    const h = house.h;
    ctx.fillStyle = '#3b6280';
    ctx.fillRect(-h, -h, h * 2, h * 2);
    ctx.strokeStyle = '#93c5fd';
    ctx.lineWidth = 0.32;
    ctx.strokeRect(-h, -h, h * 2, h * 2);

    // Home outer shell border + interior/exterior doorway threshold ticks
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 0.34;
    ctx.strokeRect(
      houseFootprint.x0,
      houseFootprint.z0,
      houseFootprint.x1 - houseFootprint.x0,
      houseFootprint.z1 - houseFootprint.z0,
    );
    ctx.fillStyle = '#fde68a';
    for (let i = 0; i < house.doors.length; i++) {
      const d = house.doors[i];
      const dw = d.wallAlong === 'x' ? 1.05 : 0.46;
      const dd = d.wallAlong === 'z' ? 1.05 : 0.46;
      ctx.fillRect(d.x - dw * 0.5, d.z - dd * 0.5, dw, dd);
    }

    ctx.restore();
  }

  const zoneById = new Map<string, CityZoneDef>();
  for (let i = 0; i < city.zones.length; i++) {
    const z = city.zones[i];
    zoneById.set(z.id, z);
  }

  // Build static upright POI markers for key venues and landmarks
  const pois: StaticPoi[] = [{ id: 'home', kind: 'home', x: 0, z: 0, priority: 1 }];
  const addBuildingPoi = (id: string, kind: PoiKind, priority: number) => {
    const b = city.buildings.find(item => item.id === id);
    if (b) {
      const c = rectCenter(b.rect);
      pois.push({ id, kind, x: c.x, z: c.z, priority });
      return;
    }
    const z = zoneById.get(id);
    if (z) {
      const c = rectCenter(z.rect);
      pois.push({ id, kind, x: c.x, z: c.z, priority });
    }
  };
  const addZonePoi = (id: string, kind: PoiKind, priority: number) => {
    const z = zoneById.get(id);
    if (!z) return;
    const c = rectCenter(z.rect);
    pois.push({ id, kind, x: c.x, z: c.z, priority });
  };

  addBuildingPoi('cafe', 'cafe', 1);
  addBuildingPoi('bistro', 'bistro', 1);
  addBuildingPoi('library', 'library', 1);
  addBuildingPoi('market', 'market', 1);
  addZonePoi('park', 'park', 1);
  addZonePoi('campus', 'campus', 2);
  addZonePoi('fountain_plaza', 'plaza', 2);
  addBuildingPoi('atelier', 'atelier', 2);
  addZonePoi('botanical', 'botanical', 2);

  return { city, houseH: house.h, canvas, originX, originZ, zoneById, pois };
}

const POI_COLORS: Readonly<Record<PoiKind, string>> = {
  home: '#0284c7',
  cafe: '#d97706',
  bistro: '#e11d48',
  library: '#6366f1',
  market: '#059669',
  park: '#16a34a',
  campus: '#0d9488',
  plaza: '#0891b2',
  atelier: '#9333ea',
  botanical: '#10b981',
};

/** Draws a crisp, always-upright 11 px circular POI badge + vector glyph in screen space. */
function drawPoiBadge(ctx: CanvasRenderingContext2D, x: number, y: number, kind: PoiKind) {
  ctx.save();
  ctx.translate(x, y);

  ctx.fillStyle = POI_COLORS[kind];
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = 1.15;
  ctx.beginPath();
  ctx.arc(0, 0, 5.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 1.15;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (kind) {
    case 'home': {
      ctx.beginPath();
      ctx.moveTo(-3.0, -0.2);
      ctx.lineTo(0, -2.9);
      ctx.lineTo(3.0, -0.2);
      ctx.stroke();
      ctx.fillRect(-1.9, -0.2, 3.8, 2.9);
      break;
    }
    case 'cafe': {
      ctx.fillRect(-2.4, -1.5, 3.8, 3.2);
      ctx.beginPath();
      ctx.arc(1.7, 0.1, 1.1, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      break;
    }
    case 'bistro': {
      ctx.beginPath();
      ctx.arc(0, 0.8, 2.7, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-3.0, 1.5);
      ctx.lineTo(3.0, 1.5);
      ctx.stroke();
      break;
    }
    case 'library': {
      ctx.beginPath();
      ctx.moveTo(-2.8, -1.9);
      ctx.lineTo(0, -1.1);
      ctx.lineTo(2.8, -1.9);
      ctx.lineTo(2.8, 2.1);
      ctx.lineTo(0, 1.3);
      ctx.lineTo(-2.8, 2.1);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -1.1);
      ctx.lineTo(0, 1.3);
      ctx.stroke();
      break;
    }
    case 'market': {
      ctx.strokeRect(-2.3, -0.9, 4.6, 3.4);
      ctx.beginPath();
      ctx.arc(0, -0.9, 1.4, Math.PI, 0);
      ctx.stroke();
      break;
    }
    case 'park':
    case 'botanical': {
      ctx.beginPath();
      ctx.moveTo(0, -3.0);
      ctx.lineTo(2.6, 1.0);
      ctx.lineTo(-2.6, 1.0);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(-0.55, 1.0, 1.1, 1.9);
      break;
    }
    case 'campus': {
      ctx.beginPath();
      ctx.moveTo(0, -2.7);
      ctx.lineTo(3.0, -0.7);
      ctx.lineTo(0, 1.3);
      ctx.lineTo(-3.0, -0.7);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'plaza': {
      ctx.beginPath();
      ctx.arc(0, 0, 2.3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'atelier': {
      ctx.beginPath();
      ctx.moveTo(-0.6, 1.8);
      ctx.lineTo(-0.6, -2.3);
      ctx.lineTo(2.2, -1.5);
      ctx.lineTo(2.2, 1.1);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(-1.4, 1.8, 1.0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
  }

  ctx.restore();
}

function drawVehicleMarker(
  ctx: CanvasRenderingContext2D,
  ux: number,
  uy: number,
  kind: 'bike' | 'moto' | 'car',
) {
  ctx.save();
  ctx.translate(ux, uy);
  if (kind === 'car') {
    ctx.fillStyle = '#fb923c';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.roundRect(-4.6, -2.8, 9.2, 5.6, 1.8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff7ed';
    ctx.fillRect(-2.2, -1.7, 4.4, 3.4);
  } else {
    ctx.fillStyle = kind === 'moto' ? '#2dd4bf' : '#38bdf8';
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(0, 0, 4.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(-1.6, 0.4, 1.05, 0, Math.PI * 2);
    ctx.arc(1.6, 0.4, 1.05, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawRimIndicator(
  ctx: CanvasRenderingContext2D,
  halfCss: number,
  sdx: number,
  sdy: number,
  color: string,
  radius: number,
) {
  const ang = Math.atan2(sdy, sdx);
  const rimR = halfCss - 8.5;
  const rx = halfCss + Math.cos(ang) * rimR;
  const ry = halfCss + Math.sin(ang) * rimR;

  ctx.save();
  ctx.translate(rx, ry);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#0b1922';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(radius + 1.4, 0);
  ctx.lineTo(-radius, -radius * 0.85);
  ctx.lineTo(-radius * 0.45, 0);
  ctx.lineTo(-radius, radius * 0.85);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function positionCompassDom(
  halfCss: number,
  rotYaw: number,
  nEl: HTMLSpanElement | null,
  eEl: HTMLSpanElement | null,
  sEl: HTMLSpanElement | null,
  wEl: HTMLSpanElement | null,
) {
  const r = Math.max(36, halfCss - 10);
  const c = Math.cos(rotYaw);
  const sn = Math.sin(rotYaw);

  // North (0, -1), East (+1, 0), South (0, +1), West (-1, 0) under map rotation `rotYaw`
  const setPos = (el: HTMLSpanElement | null, dx: number, dz: number) => {
    if (!el) return;
    const x = halfCss + (dx * c - dz * sn) * r;
    const y = halfCss + (dx * sn + dz * c) * r;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  };
  setPos(nEl, 0, -1);
  setPos(eEl, 1, 0);
  setPos(sEl, 0, 1);
  setPos(wEl, -1, 0);
}

export const Minimap = memo(function Minimap({ host, zone, beacons, onExpand }: MinimapProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const northRef = useRef<HTMLSpanElement>(null);
  const eastRef = useRef<HTMLSpanElement>(null);
  const southRef = useRef<HTMLSpanElement>(null);
  const westRef = useRef<HTMLSpanElement>(null);

  const [rotateMap, setRotateMap] = useState(true);
  const [zoomMode, setZoomMode] = useState<MinimapZoomMode>('auto');

  const rotateMapRef = useRef(rotateMap);
  const zoomModeRef = useRef<MinimapZoomMode>(zoomMode);
  const beaconsRef = useRef<readonly MinimapBeacon[] | undefined>(beacons);
  const forceRedrawRef = useRef(true);
  const frameCssSizeRef = useRef(DEFAULT_CSS_SIZE);

  rotateMapRef.current = rotateMap;
  zoomModeRef.current = zoomMode;

  useEffect(() => {
    beaconsRef.current = beacons;
    forceRedrawRef.current = true;
  }, [beacons]);

  useEffect(() => {
    forceRedrawRef.current = true;
  }, [rotateMap, zoomMode]);

  // Seed compass badges immediately on layout so N/E/S/W sit cleanly on the bezel from Frame 0.
  useLayoutEffect(() => {
    const el = frameRef.current;
    const sz = el && el.clientWidth > 0 ? el.clientWidth : DEFAULT_CSS_SIZE;
    frameCssSizeRef.current = sz;
    positionCompassDom(
      sz * 0.5,
      rotateMapRef.current ? host.lookDirection : 0,
      northRef.current,
      eastRef.current,
      southRef.current,
      westRef.current,
    );
  }, [host]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let staticCache: StaticCityCache | null = null;
    let lastMapPollAt = -Infinity;
    let cachedObjectiveZone: string | null = null;
    let cachedEventZones: string[] = [];

    let currentScale = 2.2;
    let lastPx = Number.NaN;
    let lastPz = Number.NaN;
    let lastYaw = Number.NaN;
    let lastScale = Number.NaN;
    let lastRotateMode: boolean | null = null;
    let lastCssSize = 0;
    let lastBackingPx = 0;
    let lastNpcHash = 0;
    let lastNpcCount = -1;
    let lastFocusNpc = '';
    let lastVehHash = 0;
    let lastBeaconSig = '';
    let lastCityRef: CityPlan | null = null;
    let lastCompassYaw = Number.NaN;
    let lastCompassHalf = 0;

    // Reusable scratch buffers (zero 12.5 Hz heap allocations).
    const activeBeacons: MinimapBeacon[] = [];
    const rimBeacons: { sdx: number; sdy: number; kind: MinimapBeacon['kind'] }[] = [];

    const onResize = () => {
      const fEl = frameRef.current;
      if (fEl && fEl.clientWidth >= 64) {
        frameCssSizeRef.current = fEl.clientWidth;
        forceRedrawRef.current = true;
      }
    };
    onResize();
    const ro = typeof ResizeObserver !== 'undefined' && frameRef.current
      ? new ResizeObserver(onResize)
      : null;
    if (ro && frameRef.current) ro.observe(frameRef.current);

    function resolveTargetScale(game: NonNullable<EchoLifeGameHost['game']>): number {
      const mode = zoomModeRef.current;
      if (mode === 'close') return 3.75;
      if (mode === 'street') return 2.2;
      if (mode === 'city') return 1.28;
      // Auto GTA-style speed/context zoom:
      if (game.drivenVehicle || game.riding) return 1.38;
      const zId = game.s.player.zone;
      const reg = host.worldRegion;
      const isIndoor = HOME_ZONE_SET.has(zId) || Boolean(reg && !OUTDOOR_REGIONS.has(reg));
      return isIndoor ? 3.55 : 2.2;
    }

    function draw() {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const cssSize = frameCssSizeRef.current || DEFAULT_CSS_SIZE;
      const halfCss = cssSize * 0.5;
      const dpr = typeof window !== 'undefined' ? Math.min(2, Math.max(1, window.devicePixelRatio || 1)) : 1;
      const backingPx = Math.max(128, Math.round(cssSize * dpr));

      if (backingPx !== lastBackingPx) {
        canvas!.width = backingPx;
        canvas!.height = backingPx;
        lastBackingPx = backingPx;
        forceRedrawRef.current = true;
      }

      const yaw = host.lookDirection;
      const rotateWithHeading = rotateMapRef.current;
      const rotYaw = rotateWithHeading ? yaw : 0;

      if (
        halfCss !== lastCompassHalf ||
        Number.isNaN(lastCompassYaw) ||
        angleDeltaRad(rotYaw, lastCompassYaw) >= YAW_EPS_RAD
      ) {
        positionCompassDom(halfCss, rotYaw, northRef.current, eastRef.current, southRef.current, westRef.current);
        lastCompassHalf = halfCss;
        lastCompassYaw = rotYaw;
      }

      const p = host.bodyNow();
      const game = host.game;
      if (!p || !game || !ctx) return;

      const city = game.nav.city;
      const house = game.nav.house;
      if (!staticCache || staticCache.city !== city || staticCache.houseH !== house.h) {
        staticCache = buildStaticCityCache(city, house);
        forceRedrawRef.current = true;
      }

      const targetScale = resolveTargetScale(game);
      if (Number.isNaN(lastScale)) {
        currentScale = targetScale;
      } else {
        const diff = targetScale - currentScale;
        currentScale = Math.abs(diff) < SCALE_EPS ? targetScale : currentScale + diff * 0.34;
      }

      const effScale = currentScale;
      const span = halfCss / effScale + 8;
      const spanSq = span * span;
      const now = performance.now();

      // 1. Resolve beacons (objectives, events, shift, custom phone waypoint) into scratch buffer
      const propBeacons = beaconsRef.current;
      activeBeacons.length = 0;
      let beaconSig = '';
      if (propBeacons) {
        for (let i = 0; i < propBeacons.length; i++) {
          const b = propBeacons[i];
          activeBeacons.push(b);
          beaconSig += `${b.kind}:${Math.round(b.x * 20)},${Math.round(b.z * 20)};`;
        }
      } else {
        if (now - lastMapPollAt >= MAP_POLL_MS) {
          lastMapPollAt = now;
          const m = game.map();
          cachedObjectiveZone = m.objectives[0]?.zone ?? null;
          cachedEventZones = m.events.map(ev => ev.zone);
        }
        if (cachedObjectiveZone) {
          const z = staticCache.zoneById.get(cachedObjectiveZone);
          if (z) {
            activeBeacons.push({ x: z.waypoint.x, z: z.waypoint.z, kind: 'objective' });
            beaconSig += `o:${cachedObjectiveZone};`;
          }
        }
        for (let i = 0; i < cachedEventZones.length; i++) {
          const ezId = cachedEventZones[i];
          const z = staticCache.zoneById.get(ezId);
          if (z) {
            activeBeacons.push({ x: z.waypoint.x, z: z.waypoint.z, kind: 'event' });
            beaconSig += `e:${ezId};`;
          }
        }
        const shift = game.activeShift;
        if (shift) {
          const station = jobs[shift.job]?.steps[shift.step] as readonly (string | readonly string[])[] | undefined;
          const shiftZone = typeof station?.[0] === 'string' ? station[0] : null;
          const shiftSpotId = typeof station?.[1] === 'string' ? station[1] : null;
          const shiftAliases = Array.isArray(station?.[3]) ? station[3] : [];
          if (shiftZone) {
            const spot = game.hotspots.find(
              h => h.zone === shiftZone && (h.id === shiftSpotId || shiftAliases.includes(h.id)),
            );
            if (spot) {
              activeBeacons.push({ x: spot.at.x, z: spot.at.z, kind: 'shift' });
              beaconSig += `s:${shift.job}:${shift.step}:${Math.round(spot.at.x * 20)},${Math.round(spot.at.z * 20)};`;
            } else {
              const sz = staticCache.zoneById.get(shiftZone);
              if (sz) {
                activeBeacons.push({ x: sz.waypoint.x, z: sz.waypoint.z, kind: 'shift' });
                beaconSig += `s:${shiftZone};`;
              }
            }
          }
        }
      }

      // 2. Dirty-check nearby NPCs, focused/talking resident, and ALL parked vehicles independently
      const focusNpcId =
        game.people.talking ?? (host.focus?.kind === 'npc' ? host.focus.id : '');
      let npcHash = 0;
      let npcCount = 0;
      for (const w of game.people.walkers.values()) {
        const wx = w.seat ? w.seat.sit.x : w.x;
        const wz = w.seat ? w.seat.sit.z : w.z;
        const dx = wx - p.x;
        const dz = wz - p.z;
        if (dx * dx + dz * dz > spanSq) continue;
        npcCount++;
        const qx = Math.round(wx * 20) | 0;
        const qz = Math.round(wz * 20) | 0;
        npcHash = ((npcHash * 31) ^ (qx * 73856093) ^ (qz * 19349663)) | 0;
      }

      let vehHash = game.riding || game.drivenVehicle ? 97 : 0;
      if (!game.riding) {
        vehHash = (vehHash * 31 + 2 + Math.round(game.bike.x * 20) * 13 + Math.round(game.bike.z * 20) * 17) | 0;
      }
      if (game.twoWheeler.spec && !game.twoWheeler.driving) {
        vehHash = (vehHash * 31 + 3 + Math.round(game.twoWheeler.pose.x * 20) * 13 + Math.round(game.twoWheeler.pose.z * 20) * 17) | 0;
      }
      if (game.car.spec && !game.car.driving) {
        vehHash = (vehHash * 31 + 5 + Math.round(game.car.pose.x * 20) * 19 + Math.round(game.car.pose.z * 20) * 23) | 0;
      }

      const dpx = p.x - lastPx;
      const dpz = p.z - lastPz;
      const playerMoved = Number.isNaN(lastPx) || dpx * dpx + dpz * dpz >= POS_EPS_SQ;
      const yawChanged = Number.isNaN(lastYaw) || angleDeltaRad(yaw, lastYaw) >= YAW_EPS_RAD;
      const scaleChanged = Number.isNaN(lastScale) || Math.abs(effScale - lastScale) >= 0.005;

      if (
        !forceRedrawRef.current &&
        lastCityRef === city &&
        lastCssSize === cssSize &&
        lastRotateMode === rotateWithHeading &&
        !playerMoved &&
        !yawChanged &&
        !scaleChanged &&
        npcCount === lastNpcCount &&
        npcHash === lastNpcHash &&
        focusNpcId === lastFocusNpc &&
        vehHash === lastVehHash &&
        beaconSig === lastBeaconSig
      ) {
        return;
      }

      forceRedrawRef.current = false;
      lastCityRef = city;
      lastCssSize = cssSize;
      lastRotateMode = rotateWithHeading;
      lastPx = p.x;
      lastPz = p.z;
      lastYaw = yaw;
      lastScale = effScale;
      lastNpcCount = npcCount;
      lastNpcHash = npcHash;
      lastFocusNpc = focusNpcId;
      lastVehHash = vehHash;
      lastBeaconSig = beaconSig;

      // 3. Blit rotated/scaled static city + indoor home canvas in 1 hardware-accelerated drawImage
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#10232c';
      ctx.fillRect(0, 0, cssSize, cssSize);

      ctx.save();
      ctx.translate(halfCss, halfCss);
      if (rotYaw !== 0) ctx.rotate(rotYaw);
      const cacheRatio = effScale / CACHE_SCALE;
      ctx.scale(cacheRatio, cacheRatio);
      ctx.drawImage(
        staticCache.canvas,
        -(p.x - staticCache.originX) * CACHE_SCALE,
        -(p.z - staticCache.originZ) * CACHE_SCALE,
      );
      ctx.restore();

      const cosR = Math.cos(rotYaw);
      const sinR = Math.sin(rotYaw);
      const maxBadgeR = halfCss - 12.5;
      const showSecondaryPois = effScale >= 1.65;

      // 4. Upright Landmark & Venue POI Icons (Home, Cafe, Bistro, Library, Market, Park, Campus, Plaza, Atelier, Botanical)
      const pois = staticCache.pois;
      for (let i = 0; i < pois.length; i++) {
        const poi = pois[i];
        if (poi.priority > 1 && !showSecondaryPois) continue;
        const dx = poi.x - p.x;
        const dz = poi.z - p.z;
        if (dx * dx + dz * dz > spanSq) continue;
        const sdx = (dx * cosR - dz * sinR) * effScale;
        const sdy = (dx * sinR + dz * cosR) * effScale;
        if (sdx * sdx + sdy * sdy > maxBadgeR * maxBadgeR) continue;
        // Skip overlapping home badge when zoomed closely inside Study Room right on top of (0,0)
        if (poi.kind === 'home' && effScale > 3.0 && dx * dx + dz * dz < 9) continue;
        drawPoiBadge(ctx, halfCss + sdx, halfCss + sdy, poi.kind);
      }

      // 5. Parked Vehicles (starter bicycle, owned two-wheeler, and owned car rendered independently!)
      const plotVehicle = (vx: number, vz: number, kind: 'bike' | 'moto' | 'car') => {
        const dx = vx - p.x;
        const dz = vz - p.z;
        if (dx * dx + dz * dz > spanSq) return;
        const sdx = (dx * cosR - dz * sinR) * effScale;
        const sdy = (dx * sinR + dz * cosR) * effScale;
        if (sdx * sdx + sdy * sdy > maxBadgeR * maxBadgeR) return;
        drawVehicleMarker(ctx, halfCss + sdx, halfCss + sdy, kind);
      };
      if (!game.riding) {
        plotVehicle(game.bike.x, game.bike.z, 'bike');
      }
      if (game.twoWheeler.spec && !game.twoWheeler.driving) {
        plotVehicle(game.twoWheeler.pose.x, game.twoWheeler.pose.z, 'moto');
      }
      if (game.car.spec && !game.car.driving) {
        plotVehicle(game.car.pose.x, game.car.pose.z, 'car');
      }

      // 6. Nearby Residents + Focused / Talking NPC Highlight
      for (const w of game.people.walkers.values()) {
        const wx = w.seat ? w.seat.sit.x : w.x;
        const wz = w.seat ? w.seat.sit.z : w.z;
        const dx = wx - p.x;
        const dz = wz - p.z;
        if (dx * dx + dz * dz > spanSq) continue;
        const sdx = (dx * cosR - dz * sinR) * effScale;
        const sdy = (dx * sinR + dz * cosR) * effScale;
        if (sdx * sdx + sdy * sdy > (halfCss - 6) * (halfCss - 6)) continue;
        const ux = halfCss + sdx;
        const uy = halfCss + sdy;
        const isHighlighted = w.id === focusNpcId;
        if (isHighlighted) {
          ctx.strokeStyle = '#fde047';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(ux, uy, 5.2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#38bdf8';
          ctx.beginPath();
          ctx.arc(ux, uy, 3.1, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = '#7de6c3';
          ctx.strokeStyle = '#0c1d24';
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.arc(ux, uy, 2.7, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      // 7. In-range Beacons (objective gold, event teal, shift amber, phone waypoint violet-sky) + Rim Beacons
      rimBeacons.length = 0;
      const inRangeLim = halfCss - 11;
      for (let i = 0; i < activeBeacons.length; i++) {
        const b = activeBeacons[i];
        const dx = b.x - p.x;
        const dz = b.z - p.z;
        const sdx = (dx * cosR - dz * sinR) * effScale;
        const sdy = (dx * sinR + dz * cosR) * effScale;
        const distPx = Math.hypot(sdx, sdy);
        if (distPx > inRangeLim) {
          rimBeacons.push({ sdx, sdy, kind: b.kind });
          continue;
        }
        const ux = halfCss + sdx;
        const uy = halfCss + sdy;
        if (b.kind === 'event') {
          ctx.strokeStyle = 'rgba(45, 212, 191, 0.72)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(ux, uy, 6.4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#2dd4bf';
          ctx.beginPath();
          ctx.arc(ux, uy, 3.6, 0, Math.PI * 2);
          ctx.fill();
        } else if (b.kind === 'shift') {
          ctx.fillStyle = '#fb923c';
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(ux, uy - 5.2);
          ctx.lineTo(ux + 4.8, uy);
          ctx.lineTo(ux, uy + 5.2);
          ctx.lineTo(ux - 4.8, uy);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else if (b.kind === 'waypoint') {
          ctx.strokeStyle = 'rgba(192, 132, 252, 0.85)';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(ux, uy, 6.6, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#c084fc';
          ctx.beginPath();
          ctx.arc(ux, uy, 3.7, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = 'rgba(248, 204, 75, 0.72)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(ux, uy, 6.8, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#f8cc4b';
          ctx.beginPath();
          ctx.arc(ux, uy, 4.0, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 8. Subtle GTA radar range ring + Player Vision Cone + Crisp Directional Heading Chevron
      ctx.strokeStyle = 'rgba(186, 230, 253, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(halfCss, halfCss, halfCss * 0.56, 0, Math.PI * 2);
      ctx.stroke();

      ctx.save();
      ctx.translate(halfCss, halfCss);
      const arrowRot = rotateWithHeading ? 0 : -yaw;
      if (arrowRot !== 0) ctx.rotate(arrowRot);

      // Vision FOV cone
      ctx.fillStyle = 'rgba(255, 246, 198, 0.20)';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, Math.min(34, halfCss * 0.48), -Math.PI / 2 - 0.52, -Math.PI / 2 + 0.52);
      ctx.closePath();
      ctx.fill();

      // Active driving / riding ring around player arrow
      if (game.drivenVehicle || game.riding) {
        ctx.strokeStyle = game.car.driving ? '#fb923c' : '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, 8.8, 0, Math.PI * 2);
        ctx.stroke();
      }

      // High-contrast GTA player heading chevron
      ctx.fillStyle = '#fff8dc';
      ctx.strokeStyle = '#09151d';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(0, -7.8);
      ctx.lineTo(5.6, 5.6);
      ctx.lineTo(0, 2.8);
      ctx.lineTo(-5.6, 5.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // 9. Rim-clamped directional arrows for off-radar objectives, events, shifts, and Phone waypoints
      for (let i = 0; i < rimBeacons.length; i++) {
        const r = rimBeacons[i];
        const color =
          r.kind === 'event' ? '#2dd4bf' :
          r.kind === 'shift' ? '#fb923c' :
          r.kind === 'waypoint' ? '#c084fc' : '#f8cc4b';
        drawRimIndicator(ctx, halfCss, r.sdx, r.sdy, color, 4.3);
      }

      // Crisp inner bezel vignette ring
      ctx.strokeStyle = 'rgba(15, 35, 48, 0.65)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(halfCss, halfCss, halfCss - 1, 0, Math.PI * 2);
      ctx.stroke();
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        forceRedrawRef.current = true;
        draw();
      }
    };

    draw();
    const id = window.setInterval(draw, DRAW_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(id);
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [host]);

  const handleCycleZoom = useCallback(() => {
    setZoomMode(prev => ZOOM_ORDER[(ZOOM_ORDER.indexOf(prev) + 1) % ZOOM_ORDER.length]);
  }, []);

  const handleToggleRotation = useCallback(() => {
    setRotateMap(prev => !prev);
  }, []);

  const safeZone = zone ? cleanDisplayCopy(zone) : '';

  return (
    <div
      className={s.minimapWrap}
      data-testid="echo-life-minimap"
      data-rotation={rotateMap ? 'heading' : 'north'}
      data-zoom={zoomMode}
    >
      {safeZone && (
        <div className={s.minimapZoneRow}>
          <div className={s.minimapZone} title={safeZone}>{safeZone}</div>
        </div>
      )}
      <div className={s.minimapFrame} ref={frameRef}>
        <button
          type="button"
          className={s.minimap}
          onClick={onExpand}
          aria-label="Expand Riverside map"
          title="Expand map (M)"
        >
          <canvas width={DEFAULT_CSS_SIZE} height={DEFAULT_CSS_SIZE} ref={canvasRef} aria-hidden="true" />
        </button>
        <span ref={northRef} className={s.minimapNorth} aria-hidden="true">N</span>
        <span ref={eastRef} className={s.minimapEast} aria-hidden="true">E</span>
        <span ref={southRef} className={s.minimapSouth} aria-hidden="true">S</span>
        <span ref={westRef} className={s.minimapWest} aria-hidden="true">W</span>
        <div className={s.minimapTools}>
          <button
            type="button"
            className={s.minimapToolBtn}
            data-testid="minimap-zoom-btn"
            aria-label={`Minimap zoom: ${ZOOM_LABELS[zoomMode]}`}
            title={`Cycle radar zoom (${ZOOM_LABELS[zoomMode]})`}
            onClick={handleCycleZoom}
          >
            {ZOOM_LABELS[zoomMode]}
          </button>
          <button
            type="button"
            className={s.minimapToolBtn}
            data-testid="minimap-heading-btn"
            aria-pressed={rotateMap}
            aria-label={rotateMap ? 'Rotating heading radar active' : 'North-up radar active'}
            title={rotateMap ? 'Heading-up radar (click for North-up)' : 'North-up radar (click for Heading-up)'}
            onClick={handleToggleRotation}
          >
            {rotateMap ? '3D' : 'N'}
          </button>
        </div>
        <kbd className={s.minimapKey} aria-hidden="true">M</kbd>
      </div>
    </div>
  );
});
