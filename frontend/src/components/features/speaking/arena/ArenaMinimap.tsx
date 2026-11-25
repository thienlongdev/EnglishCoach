'use client';

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Anchor,
  BookOpen,
  Compass,
  Crosshair,
  Map as MapIcon,
  MapPin,
  Navigation,
  Ship,
  Sun,
  Sunset,
  Waves,
  X,
} from 'lucide-react';
import type {
  ArenaIslandProfile,
  ArenaIslandSpec,
  ArenaTimeOfDay,
  ArenaWaterMode,
  MinimapSnapshot,
  MinimapWaypoint,
} from './arenaContracts';
import {
  arenaIslandCatalog,
  arenaIslandNames,
  arenaStationList,
  resolveArchipelagoIslandMeta,
  type IslandStationCard,
} from './arenaCopy';
import { arenaLayout, arenaShoreRadius } from './arenaTerrain';
import hud from './arenaHud.module.css';

export interface ArenaMinimapProps {
  /** Reactive snapshot (optional when `snapshotRef` is supplied for zero-rerender polling) */
  snapshot?: MinimapSnapshot;
  /** High-frequency imperative snapshot ref polled at 12 Hz directly onto the radar canvas */
  snapshotRef?: React.RefObject<MinimapSnapshot | null>;
  timeOfDay?: ArenaTimeOfDay;
  onToggleTimeOfDay?: () => void;
  vi: boolean;
  worldMapOpen?: boolean;
  onWorldMapOpenChange?: (open: boolean) => void;
  onSelectWaypoint?: (waypoint: MinimapWaypoint | null) => void;
  onOpenCollection?: () => void;
  visitedStationIds?: ReadonlySet<string>;
  /** Set false when typing in a form or another modal owns keyboard shortcuts */
  shortcutEnabled?: boolean;
}

type StationFilterGroup = 'all' | 'ielts' | 'roleplay' | 'nature' | 'stories';

interface PrecomputedIslandCoast {
  id: string;
  x: number;
  z: number;
  radius: number;
  profile?: ArenaIslandProfile;
  fillColor: string;
  shoreColor: string;
  accentColor: string;
  nameEn: string;
  nameVi: string;
  isMajor: boolean;
  /** Interleaved [x0, z0, x1, z1, ...] shoreline vertices in world metres */
  coastPoints: Float32Array;
  /** Interleaved [x0, z0, ...] shallow reef skirt vertices */
  reefPoints: Float32Array;
  svgCoastPath: string;
  svgReefPath: string;
}

interface ResolvedStationPin {
  station: IslandStationCard;
  x: number;
  z: number;
}

const DEFAULT_SNAPSHOT: MinimapSnapshot = {
  selfX: 0,
  selfZ: 0,
  selfYaw: Math.PI,
  cameraYaw: Math.PI,
  swimMode: 'land',
  activeIslandId: 'commons',
  waypoint: null,
  peers: [],
  boats: [],
};

const RADAR_SIZE_PX = 168;
const RADAR_RANGE_METRES = 132;
const COAST_SAMPLES = 48;
const STATIC_CACHE_PX_PER_M = 2.0;
const CARDINAL_BADGE_HALF_PX = 9;
const CARDINAL_ORBIT_RADIUS_PX = RADAR_SIZE_PX * 0.5 - 8;

interface StaticArchipelagoCache {
  canvas: HTMLCanvasElement;
  minX: number;
  minZ: number;
  worldW: number;
  worldH: number;
}

function matchesStationFilter(station: IslandStationCard, filter: StationFilterGroup): boolean {
  if (filter === 'all') return true;
  if (filter === 'ielts') {
    return (
      station.category === 'ielts_part1' ||
      station.category === 'ielts_part2' ||
      station.category === 'ielts_part3'
    );
  }
  if (filter === 'roleplay') {
    return (
      station.category === 'directions' ||
      station.category === 'food_market' ||
      station.category === 'daily'
    );
  }
  if (filter === 'nature') {
    return (
      station.category === 'scenery' ||
      station.category === 'marine' ||
      station.category === 'weather_nature'
    );
  }
  return (
    station.category === 'travel' ||
    station.category === 'storytelling' ||
    station.category === 'discussion'
  );
}

function pointsToSvgPath(pts: Float32Array): string {
  if (pts.length < 4) return '';
  let d = `M ${pts[0].toFixed(1)} ${pts[1].toFixed(1)}`;
  for (let i = 2; i < pts.length; i += 2) {
    d += ` L ${pts[i].toFixed(1)} ${pts[i + 1].toFixed(1)}`;
  }
  return `${d} Z`;
}

function formatSwimModeLabel(mode: ArenaWaterMode, onBoat: boolean, vi: boolean): string {
  if (onBoat) return vi ? 'Trên thuyền' : 'Boating';
  switch (mode) {
    case 'wading':
      return vi ? 'Lội nước nông' : 'Wading';
    case 'surface_swim':
      return vi ? 'Đang bơi' : 'Swimming';
    case 'underwater_dive':
      return vi ? 'Đang lặn biển' : 'Free-Diving';
    default:
      return vi ? 'Trên đảo' : 'On Foot';
  }
}

export default function ArenaMinimap({
  snapshot,
  snapshotRef,
  timeOfDay = 'daylight',
  onToggleTimeOfDay,
  vi,
  worldMapOpen,
  onWorldMapOpenChange,
  onSelectWaypoint,
  onOpenCollection,
  visitedStationIds,
  shortcutEnabled = true,
}: ArenaMinimapProps) {
  const titleId = useId();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const northRef = useRef<HTMLSpanElement | null>(null);
  const eastRef = useRef<HTMLSpanElement | null>(null);
  const southRef = useRef<HTMLSpanElement | null>(null);
  const westRef = useRef<HTMLSpanElement | null>(null);
  const staticCacheRef = useRef<StaticArchipelagoCache | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isMapOpen = worldMapOpen ?? uncontrolledOpen;

  const setMapOpen = useCallback(
    (next: boolean) => {
      if (worldMapOpen === undefined) setUncontrolledOpen(next);
      onWorldMapOpenChange?.(next);
    },
    [worldMapOpen, onWorldMapOpenChange],
  );

  const [localWaypoint, setLocalWaypoint] = useState<MinimapWaypoint | null>(null);
  const [filterGroup, setFilterGroup] = useState<StationFilterGroup>('all');
  const [selectedStationId, setSelectedStationId] = useState<string>('kiosk-commons');
  const [selectedIslandId, setSelectedIslandId] = useState<string | null>(null);

  // Throttled HUD text snapshot (4 Hz) when driven via `snapshotRef` so labels stay fresh with near-zero React work
  const [hudSnap, setHudSnap] = useState<MinimapSnapshot>(() => snapshot ?? snapshotRef?.current ?? DEFAULT_SNAPSHOT);

  useEffect(() => {
    if (snapshot) setHudSnap(snapshot);
  }, [snapshot]);

  useEffect(() => {
    if (!snapshotRef) return;
    const sync = () => {
      const cur = snapshotRef.current;
      if (!cur) return;
      setHudSnap(prev => {
        if (
          Math.abs(prev.selfX - cur.selfX) < 1.5 &&
          Math.abs(prev.selfZ - cur.selfZ) < 1.5 &&
          prev.swimMode === cur.swimMode &&
          prev.activeIslandId === cur.activeIslandId &&
          prev.waypoint === cur.waypoint
        ) {
          return prev;
        }
        return { ...cur };
      });
    };
    sync();
    const id = window.setInterval(sync, 250);
    return () => window.clearInterval(id);
  }, [snapshotRef]);

  const effectiveWaypoint = hudSnap.waypoint ?? localWaypoint;

  const updateWaypoint = useCallback(
    (wp: MinimapWaypoint | null) => {
      setLocalWaypoint(wp);
      onSelectWaypoint?.(wp);
    },
    [onSelectWaypoint],
  );

  // Precompute all island shoreline and shallow reef polygons once from authoritative `arenaLayout.islands`
  const precomputedIslands = useMemo<readonly PrecomputedIslandCoast[]>(() => {
    return arenaLayout.islands.map(rawIsland => {
      const profile = (rawIsland as { profile?: ArenaIslandProfile }).profile;
      const meta = resolveArchipelagoIslandMeta(rawIsland.id, profile);
      const coastPoints = new Float32Array(COAST_SAMPLES * 2);
      const reefPoints = new Float32Array(COAST_SAMPLES * 2);
      for (let k = 0; k < COAST_SAMPLES; k++) {
        const angle = (k / COAST_SAMPLES) * Math.PI * 2;
        const rShore = arenaShoreRadius(rawIsland as unknown as ArenaIslandSpec, angle);
        const rReef = rShore + Math.max(5.5, rawIsland.radius * 0.22);
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        coastPoints[k * 2] = rawIsland.x + c * rShore;
        coastPoints[k * 2 + 1] = rawIsland.z + s * rShore;
        reefPoints[k * 2] = rawIsland.x + c * rReef;
        reefPoints[k * 2 + 1] = rawIsland.z + s * rReef;
      }
      const isMajor = rawIsland.radius >= 11 && profile !== 'islet' && !rawIsland.id.startsWith('islet');
      return {
        id: rawIsland.id,
        x: rawIsland.x,
        z: rawIsland.z,
        radius: rawIsland.radius,
        profile,
        fillColor: meta.fillColor,
        shoreColor: meta.shoreColor,
        accentColor: meta.accentColor,
        nameEn: arenaIslandNames[rawIsland.id]?.en ?? meta.en,
        nameVi: arenaIslandNames[rawIsland.id]?.vi ?? meta.vi,
        isMajor,
        coastPoints,
        reefPoints,
        svgCoastPath: pointsToSvgPath(coastPoints),
        svgReefPath: pointsToSvgPath(reefPoints),
      };
    });
  }, []);

  // Resolve all 15 distributed station coordinates: prefer authoritative `arenaLayout.interactables`, fallback to parent island + offset
  const stationPins = useMemo<readonly ResolvedStationPin[]>(() => {
    const interactableById = new Map<string, { x: number; z: number }>();
    for (const inter of arenaLayout.interactables) {
      if (inter.kind === 'kiosk') {
        interactableById.set(inter.id, { x: inter.x, z: inter.z });
      }
    }
    return arenaStationList.map(station => {
      const exact =
        interactableById.get(station.id) ??
        (station.id === 'kiosk-commons' ? interactableById.get('kiosk-harbor') : undefined);
      if (exact) {
        return { station, x: exact.x, z: exact.z };
      }
      const parentIsland =
        arenaLayout.islands.find(i => i.id === station.islandId) ??
        arenaLayout.islands.find(i => i.id === station.legacyIslandId) ??
        arenaLayout.islands[0];
      const baseX = parentIsland?.x ?? 0;
      const baseZ = parentIsland?.z ?? 0;
      return {
        station,
        x: baseX + station.mapOffset.dx,
        z: baseZ + station.mapOffset.dz,
      };
    });
  }, []);

  // Compute World Map SVG viewBox bounds + maritime ferry lanes between docks
  const chartBoundsAndRoutes = useMemo(() => {
    let minX = -210;
    let maxX = 210;
    let minZ = -210;
    let maxZ = 210;
    for (const isl of precomputedIslands) {
      const pad = isl.radius + 28;
      if (isl.x - pad < minX) minX = isl.x - pad;
      if (isl.x + pad > maxX) maxX = isl.x + pad;
      if (isl.z - pad < minZ) minZ = isl.z - pad;
      if (isl.z + pad > maxZ) maxZ = isl.z + pad;
    }
    for (const pin of stationPins) {
      if (pin.x - 24 < minX) minX = pin.x - 24;
      if (pin.x + 24 > maxX) maxX = pin.x + 24;
      if (pin.z - 24 < minZ) minZ = pin.z - 24;
      if (pin.z + 24 > maxZ) maxZ = pin.z + 24;
    }

    // Build scenic maritime sea routes connecting Pearl Harbor docks outward to outer island docks
    const harborDocks = arenaLayout.docks.filter(d => d.island === 'commons');
    const outerDocks = arenaLayout.docks.filter(d => d.island !== 'commons');
    const routes: Array<{ id: string; d: string }> = [];
    if (harborDocks.length > 0) {
      for (const od of outerDocks) {
        let nearest = harborDocks[0];
        let bestDist = Infinity;
        for (const hd of harborDocks) {
          const dist = Math.hypot(od.bx - hd.bx, od.bz - hd.bz);
          if (dist < bestDist) {
            bestDist = dist;
            nearest = hd;
          }
        }
        const mx = (nearest.bx + od.bx) * 0.5;
        const mz = (nearest.bz + od.bz) * 0.5;
        // Gentle outward curve away from origin so ferry lanes skirt around central harbor coast
        const norm = Math.max(1, Math.hypot(mx, mz));
        const cx = mx + (mx / norm) * 18;
        const cz = mz + (mz / norm) * 18;
        routes.push({
          id: `${nearest.id}-${od.id}`,
          d: `M ${nearest.bx.toFixed(1)} ${nearest.bz.toFixed(1)} Q ${cx.toFixed(1)} ${cz.toFixed(1)} ${od.bx.toFixed(1)} ${od.bz.toFixed(1)}`,
        });
      }
    }

    const width = maxX - minX;
    const height = maxZ - minZ;
    return {
      viewBox: `${minX.toFixed(1)} ${minZ.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}`,
      minX,
      minZ,
      width,
      height,
      routes,
    };
  }, [precomputedIslands, stationPins]);

  // Resolve current island name from activeIslandId or proximity
  const currentIslandLabel = useMemo(() => {
    if (hudSnap.activeIslandId) {
      const named = arenaIslandNames[hudSnap.activeIslandId];
      if (named) return vi ? named.vi : named.en;
    }
    let best: PrecomputedIslandCoast | null = null;
    let bestGap = Infinity;
    for (const isl of precomputedIslands) {
      const dist = Math.hypot(hudSnap.selfX - isl.x, hudSnap.selfZ - isl.z) - isl.radius;
      if (dist < 14 && dist < bestGap) {
        bestGap = dist;
        best = isl;
      }
    }
    if (best) return vi ? best.nameVi : best.nameEn;
    return vi ? 'Luồng Biển Khơi' : 'Open Sea Channel';
  }, [hudSnap.activeIslandId, hudSnap.selfX, hudSnap.selfZ, precomputedIslands, vi]);

  const isOnBoat = useMemo(() => {
    return hudSnap.boats.some(
      b => b.occupied && Math.hypot(b.x - hudSnap.selfX, b.z - hudSnap.selfZ) < 3.4,
    );
  }, [hudSnap.boats, hudSnap.selfX, hudSnap.selfZ]);

  // Build offscreen static archipelago coast/reef/bridge/pier bitmap once on client (0 per-frame polygon rasterization)
  const ensureStaticArchipelagoCache = useCallback((): StaticArchipelagoCache | null => {
    if (staticCacheRef.current) return staticCacheRef.current;
    if (typeof document === 'undefined') return null;

    let minX = -240;
    let maxX = 240;
    let minZ = -240;
    let maxZ = 240;
    for (let i = 0; i < precomputedIslands.length; i++) {
      const isl = precomputedIslands[i];
      const pad = isl.radius + Math.max(12, isl.radius * 0.28);
      if (isl.x - pad < minX) minX = isl.x - pad;
      if (isl.x + pad > maxX) maxX = isl.x + pad;
      if (isl.z - pad < minZ) minZ = isl.z - pad;
      if (isl.z + pad > maxZ) maxZ = isl.z + pad;
    }
    for (let i = 0; i < arenaLayout.docks.length; i++) {
      const d = arenaLayout.docks[i];
      minX = Math.min(minX, d.ax - 16, d.bx - 16);
      maxX = Math.max(maxX, d.ax + 16, d.bx + 16);
      minZ = Math.min(minZ, d.az - 16, d.bz - 16);
      maxZ = Math.max(maxZ, d.az + 16, d.bz + 16);
    }

    const worldW = maxX - minX;
    const worldH = maxZ - minZ;
    const off = document.createElement('canvas');
    off.width = Math.max(64, Math.ceil(worldW * STATIC_CACHE_PX_PER_M));
    off.height = Math.max(64, Math.ceil(worldH * STATIC_CACHE_PX_PER_M));
    const octx = off.getContext('2d');
    if (!octx) return null;

    octx.save();
    octx.scale(STATIC_CACHE_PX_PER_M, STATIC_CACHE_PX_PER_M);
    octx.translate(-minX, -minZ);

    // 1. Shallow Coral Reef Aprons
    octx.fillStyle = 'rgba(45, 212, 191, 0.24)';
    for (let i = 0; i < precomputedIslands.length; i++) {
      const rp = precomputedIslands[i].reefPoints;
      if (rp.length < 4) continue;
      octx.beginPath();
      octx.moveTo(rp[0], rp[1]);
      for (let k = 2; k < rp.length; k += 2) {
        octx.lineTo(rp[k], rp[k + 1]);
      }
      octx.closePath();
      octx.fill();
    }

    // 2. Sculpted Island Coastlines + Sandy Rims
    for (let i = 0; i < precomputedIslands.length; i++) {
      const isl = precomputedIslands[i];
      const cp = isl.coastPoints;
      if (cp.length < 4) continue;
      octx.beginPath();
      octx.moveTo(cp[0], cp[1]);
      for (let k = 2; k < cp.length; k += 2) {
        octx.lineTo(cp[k], cp[k + 1]);
      }
      octx.closePath();
      octx.fillStyle = isl.fillColor;
      octx.fill();
      octx.lineWidth = 2.2;
      octx.strokeStyle = isl.shoreColor;
      octx.stroke();
    }

    // 3. Timber Bridges
    octx.strokeStyle = '#d9b382';
    octx.lineCap = 'round';
    for (let i = 0; i < arenaLayout.bridges.length; i++) {
      const b = arenaLayout.bridges[i];
      octx.lineWidth = Math.max(3.0, b.width);
      octx.beginPath();
      octx.moveTo(b.ax, b.az);
      octx.lineTo(b.bx, b.bz);
      octx.stroke();
    }

    // 4. Coastal Timber Piers and Docks
    octx.strokeStyle = '#f3d5a5';
    octx.lineCap = 'round';
    for (let i = 0; i < arenaLayout.docks.length; i++) {
      const d = arenaLayout.docks[i];
      octx.lineWidth = Math.max(3.2, d.width);
      octx.beginPath();
      octx.moveTo(d.ax, d.az);
      octx.lineTo(d.bx, d.bz);
      octx.stroke();
    }

    octx.restore();
    const built: StaticArchipelagoCache = { canvas: off, minX, minZ, worldW, worldH };
    staticCacheRef.current = built;
    return built;
  }, [precomputedIslands]);

  // Imperative 12 Hz 2D Circular GTA Radar Drawing (0 React re-renders per frame, 0 object allocations)
  const drawRadar = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    const targetPx = Math.round(RADAR_SIZE_PX * dpr);
    if (canvas.width !== targetPx || canvas.height !== targetPx) {
      canvas.width = targetPx;
      canvas.height = targetPx;
    }

    const snap = snapshot ?? snapshotRef?.current ?? DEFAULT_SNAPSHOT;
    const wp = snap.waypoint ?? localWaypoint;
    const half = RADAR_SIZE_PX * 0.5;
    const scale = half / RADAR_RANGE_METRES;
    const camYaw = Number.isFinite(snap.cameraYaw) ? snap.cameraYaw : Math.PI;
    const selfYaw = Number.isFinite(snap.selfYaw) ? snap.selfYaw : camYaw;

    // Camera-up GTA radar rotation: when camYaw === Math.PI (facing North -Z), rotAngle === 0
    const rotAngle = camYaw - Math.PI;
    const cosR = Math.cos(rotAngle);
    const sinR = Math.sin(rotAngle);

    // Update orbiting N/E/S/W badges on the circular rim via GPU translate3d
    if (northRef.current) {
      const nx = half + sinR * CARDINAL_ORBIT_RADIUS_PX - CARDINAL_BADGE_HALF_PX;
      const ny = half - cosR * CARDINAL_ORBIT_RADIUS_PX - CARDINAL_BADGE_HALF_PX;
      northRef.current.style.transform = `translate3d(${nx.toFixed(1)}px, ${ny.toFixed(1)}px, 0)`;
    }
    if (eastRef.current) {
      const ex = half + cosR * CARDINAL_ORBIT_RADIUS_PX - CARDINAL_BADGE_HALF_PX;
      const ey = half + sinR * CARDINAL_ORBIT_RADIUS_PX - CARDINAL_BADGE_HALF_PX;
      eastRef.current.style.transform = `translate3d(${ex.toFixed(1)}px, ${ey.toFixed(1)}px, 0)`;
    }
    if (southRef.current) {
      const sx = half - sinR * CARDINAL_ORBIT_RADIUS_PX - CARDINAL_BADGE_HALF_PX;
      const sy = half + cosR * CARDINAL_ORBIT_RADIUS_PX - CARDINAL_BADGE_HALF_PX;
      southRef.current.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
    }
    if (westRef.current) {
      const wx = half - cosR * CARDINAL_ORBIT_RADIUS_PX - CARDINAL_BADGE_HALF_PX;
      const wy = half - sinR * CARDINAL_ORBIT_RADIUS_PX - CARDINAL_BADGE_HALF_PX;
      westRef.current.style.transform = `translate3d(${wx.toFixed(1)}px, ${wy.toFixed(1)}px, 0)`;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, RADAR_SIZE_PX, RADAR_SIZE_PX);

    // Circular radar aperture clip
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.clip();

    // 1. Ocean Bathymetric Fill
    const seaGrad = ctx.createRadialGradient(half, half, 8, half, half, half * 1.08);
    if (timeOfDay === 'sunset') {
      seaGrad.addColorStop(0, '#165b73');
      seaGrad.addColorStop(0.65, '#0d3b54');
      seaGrad.addColorStop(1, '#072236');
    } else {
      seaGrad.addColorStop(0, '#187795');
      seaGrad.addColorStop(0.65, '#0d4f6b');
      seaGrad.addColorStop(1, '#072d44');
    }
    ctx.fillStyle = seaGrad;
    ctx.fillRect(0, 0, RADAR_SIZE_PX, RADAR_SIZE_PX);

    // 2. Rotated Offscreen Static Archipelago Bitmap (15 islands, reefs, bridges, and piers in 1 blit)
    const staticCache = ensureStaticArchipelagoCache();
    if (staticCache) {
      ctx.save();
      ctx.translate(half, half);
      ctx.rotate(rotAngle);
      ctx.scale(scale, scale);
      ctx.translate(-snap.selfX, -snap.selfZ);
      ctx.drawImage(
        staticCache.canvas,
        staticCache.minX,
        staticCache.minZ,
        staticCache.worldW,
        staticCache.worldH,
      );
      ctx.restore();
    }

    // Subtle radar range rings (45 m and 90 m)
    ctx.strokeStyle = 'rgba(186, 230, 253, 0.15)';
    ctx.lineWidth = 1;
    for (const ringM of [45, 90]) {
      ctx.beginPath();
      ctx.arc(half, half, ringM * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    // World -> Camera-Rotated Radar pixel transform
    const toRadarX = (wx: number, wz: number) => {
      const dx = wx - snap.selfX;
      const dz = wz - snap.selfZ;
      return half + (dx * cosR - dz * sinR) * scale;
    };
    const toRadarY = (wx: number, wz: number) => {
      const dx = wx - snap.selfX;
      const dz = wz - snap.selfZ;
      return half + (dx * sinR + dz * cosR) * scale;
    };

    // 3. Live Surface Fish Schools (subtle teal shimmer rings + school darts)
    const fishSchools = snap.fishSchools;
    if (fishSchools && fishSchools.length > 0) {
      for (let i = 0; i < fishSchools.length; i++) {
        const school = fishSchools[i];
        const fx = toRadarX(school.x, school.z);
        const fy = toRadarY(school.x, school.z);
        if (Math.hypot(fx - half, fy - half) > half + 6) continue;
        const rPx = Math.max(2.6, Math.min(5.2, school.radius * scale * 0.9));
        ctx.save();
        ctx.translate(fx, fy);
        ctx.rotate(camYaw - (Number.isFinite(school.heading) ? school.heading : 0));
        ctx.beginPath();
        ctx.ellipse(0, 0, rPx * 0.72, rPx * 1.15, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(94, 234, 212, 0.24)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(153, 246, 228, 0.58)';
        ctx.lineWidth = 0.9;
        ctx.stroke();
        ctx.restore();
      }
    }

    // 4. Distributed Speaking Station Pins (upright diamonds regardless of radar rotation)
    for (let i = 0; i < stationPins.length; i++) {
      const pin = stationPins[i];
      const sx = toRadarX(pin.x, pin.z);
      const sy = toRadarY(pin.x, pin.z);
      if (Math.hypot(sx - half, sy - half) > half + 5) continue;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(Math.PI * 0.25);
      ctx.fillStyle = visitedStationIds?.has(pin.station.id) ? '#34d399' : '#38bdf8';
      ctx.strokeStyle = '#082f49';
      ctx.lineWidth = 1;
      ctx.fillRect(-3.0, -3.0, 6.0, 6.0);
      ctx.strokeRect(-3.0, -3.0, 6.0, 6.0);
      ctx.restore();
    }

    // 5. Live Boats (camera-relative vessel heading)
    for (let i = 0; i < snap.boats.length; i++) {
      const b = snap.boats[i];
      const bx = toRadarX(b.x, b.z);
      const by = toRadarY(b.x, b.z);
      if (Math.hypot(bx - half, by - half) > half + 7) continue;
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(camYaw - b.yaw);
      ctx.beginPath();
      ctx.moveTo(0, -4.6);
      ctx.lineTo(2.8, 3.6);
      ctx.lineTo(0, 2.2);
      ctx.lineTo(-2.8, 3.6);
      ctx.closePath();
      ctx.fillStyle = b.occupied ? '#fbbf24' : '#f8fafc';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.restore();
    }

    // 6. Live Multiplayer Peers
    for (let i = 0; i < snap.peers.length; i++) {
      const p = snap.peers[i];
      const px = toRadarX(p.x, p.z);
      const py = toRadarY(p.x, p.z);
      if (Math.hypot(px - half, py - half) > half + 5) continue;
      if (p.speaking) {
        ctx.beginPath();
        ctx.arc(px, py, 6.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.85)';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(px, py, 3.4, 0, Math.PI * 2);
      ctx.fillStyle = p.speaking ? '#34d399' : '#bae6fd';
      ctx.fill();
      ctx.strokeStyle = '#082f49';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 7. Active Navigation Waypoint (inside radar circle or clamped directional arrow on circular rim)
    if (wp) {
      const dx = wp.x - snap.selfX;
      const dz = wp.z - snap.selfZ;
      const wsdx = (dx * cosR - dz * sinR) * scale;
      const wsdy = (dx * sinR + dz * cosR) * scale;
      const radPx = Math.hypot(wsdx, wsdy);
      if (radPx <= half - 14) {
        const wx = half + wsdx;
        const wy = half + wsdy;
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.76)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(half, half);
        ctx.lineTo(wx, wy);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(wx, wy, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#fbbf24';
        ctx.fill();
        ctx.strokeStyle = '#451a03';
        ctx.lineWidth = 1.3;
        ctx.stroke();
      } else {
        const bearing = Math.atan2(wsdy, wsdx);
        const edgeR = half - 12;
        const ex = half + Math.cos(bearing) * edgeR;
        const ey = half + Math.sin(bearing) * edgeR;
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(bearing + Math.PI * 0.5);
        ctx.beginPath();
        ctx.moveTo(0, -5.6);
        ctx.lineTo(4.2, 4.2);
        ctx.lineTo(-4.2, 4.2);
        ctx.closePath();
        ctx.fillStyle = '#fbbf24';
        ctx.fill();
        ctx.strokeStyle = '#451a03';
        ctx.lineWidth = 1.15;
        ctx.stroke();
        ctx.restore();
      }
    }

    // 8. Upward Camera View Frustum Cone + Center Player Heading Arrow
    ctx.beginPath();
    ctx.moveTo(half, half);
    ctx.arc(half, half, 38, -Math.PI * 0.5 - 0.48, -Math.PI * 0.5 + 0.48);
    ctx.closePath();
    const coneGrad = ctx.createRadialGradient(half, half, 2, half, half, 38);
    coneGrad.addColorStop(0, 'rgba(255, 255, 255, 0.34)');
    coneGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = coneGrad;
    ctx.fill();

    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(camYaw - selfYaw);
    ctx.beginPath();
    ctx.moveTo(0, -7.0);
    ctx.lineTo(4.9, 5.2);
    ctx.lineTo(0, 2.8);
    ctx.lineTo(-4.9, 5.2);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#083344';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();

    // 9. Rotating Azimuth Rim Ticks + Circular Specular Inner Bezel
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(rotAngle);
    ctx.strokeStyle = 'rgba(224, 242, 254, 0.28)';
    ctx.lineWidth = 1;
    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg * Math.PI) / 180;
      const inner = deg % 90 === 0 ? half - 6.5 : half - 4.2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(rad) * inner, Math.sin(rad) * inner);
      ctx.lineTo(Math.cos(rad) * (half - 1.5), Math.sin(rad) * (half - 1.5));
      ctx.stroke();
    }
    ctx.restore();

    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(224, 242, 254, 0.38)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    ctx.restore();
  }, [ensureStaticArchipelagoCache, localWaypoint, snapshot, snapshotRef, stationPins, timeOfDay, visitedStationIds]);

  useEffect(() => {
    drawRadar();
    const id = window.setInterval(drawRadar, 83);
    return () => window.clearInterval(id);
  }, [drawRadar]);

  // Native `<dialog>` lifecycle + pointer-outside light-dismiss fallback (`modern-web-guidance` `dialog`)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isMapOpen) {
      if (!dialog.open) {
        try {
          dialog.showModal();
        } catch {
          // Guard if already open in another environment
        }
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isMapOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onNativeClose = () => {
      dialog.returnValue = '';
      setMapOpen(false);
    };
    dialog.addEventListener('close', onNativeClose);

    // Fallback for browsers where `<dialog closedby="any">` is not yet supported
    let cleanOutside: (() => void) | undefined;
    if (typeof HTMLDialogElement !== 'undefined' && !('closedBy' in HTMLDialogElement.prototype)) {
      let pressedOutside = false;
      const isOutside = (e: PointerEvent) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      const onDown = (e: PointerEvent) => {
        pressedOutside = isOutside(e);
      };
      const onUp = (e: PointerEvent) => {
        if (pressedOutside && isOutside(e) && dialog.open) dialog.close();
      };
      dialog.addEventListener('pointerdown', onDown);
      dialog.addEventListener('pointerup', onUp);
      cleanOutside = () => {
        dialog.removeEventListener('pointerdown', onDown);
        dialog.removeEventListener('pointerup', onUp);
      };
    }

    return () => {
      dialog.removeEventListener('close', onNativeClose);
      cleanOutside?.();
    };
  }, [setMapOpen]);

  // Keyboard shortcut `M` for toggling the Expanded Archipelago World Map
  useEffect(() => {
    if (!shortcutEnabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code !== 'KeyM') return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setMapOpen(!isMapOpen);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMapOpen, setMapOpen, shortcutEnabled]);

  const filteredStations = useMemo(
    () => stationPins.filter(p => matchesStationFilter(p.station, filterGroup)),
    [stationPins, filterGroup],
  );

  const inspectedPin = useMemo(
    () => stationPins.find(p => p.station.id === selectedStationId) ?? stationPins[0],
    [stationPins, selectedStationId],
  );

  const inspectedIslandMeta = useMemo(() => {
    if (selectedIslandId) {
      const raw = arenaLayout.islands.find(i => i.id === selectedIslandId);
      const profile = (raw as { profile?: ArenaIslandProfile } | undefined)?.profile;
      return resolveArchipelagoIslandMeta(selectedIslandId, profile);
    }
    return resolveArchipelagoIslandMeta(inspectedPin.station.islandId);
  }, [inspectedPin, selectedIslandId]);

  const waypointDistanceM = effectiveWaypoint
    ? Math.round(Math.hypot(effectiveWaypoint.x - hudSnap.selfX, effectiveWaypoint.z - hudSnap.selfZ))
    : null;

  return (
    <div className={hud.hudScope}>
      {/* ── Top-Right Corner Live Radar Minimap ── */}
      <aside
        className={hud.minimapDock}
        data-testid="arena-minimap-dock"
        aria-label={vi ? 'Bản đồ thu nhỏ quần đảo' : 'Archipelago live minimap'}
      >
        <button
          type="button"
          className={hud.minimapShell}
          onClick={() => setMapOpen(true)}
          aria-label={
            vi
              ? `Mở hải đồ toàn quần đảo (phím M) · Đang ở ${currentIslandLabel}`
              : `Open full archipelago world map (M) · Currently at ${currentIslandLabel}`
          }
          data-testid="arena-minimap-open"
        >
          <canvas
            ref={canvasRef}
            className={hud.minimapCanvas}
            data-testid="arena-minimap-canvas"
            aria-hidden="true"
          />
          <span
            ref={northRef}
            className={`${hud.minimapCardinal} ${hud.minimapNorth}`}
            data-testid="arena-minimap-north"
            aria-hidden="true"
          >
            N
          </span>
          <span
            ref={eastRef}
            className={`${hud.minimapCardinal} ${hud.minimapEast}`}
            data-testid="arena-minimap-east"
            aria-hidden="true"
          >
            E
          </span>
          <span
            ref={southRef}
            className={`${hud.minimapCardinal} ${hud.minimapSouth}`}
            data-testid="arena-minimap-south"
            aria-hidden="true"
          >
            S
          </span>
          <span
            ref={westRef}
            className={`${hud.minimapCardinal} ${hud.minimapWest}`}
            data-testid="arena-minimap-west"
            aria-hidden="true"
          >
            W
          </span>
          <span className={hud.minimapExpandPill} aria-hidden="true">
            <MapIcon size={10} />
            <span>M</span>
          </span>
        </button>

        <div className={hud.minimapMetaStack}>
          <div className={hud.minimapIslandPill} data-testid="arena-minimap-island">
            <Compass size={13} />
            <span>{currentIslandLabel}</span>
          </div>

          <div className={hud.minimapStatusRow}>
            {onToggleTimeOfDay ? (
              <button
                type="button"
                className={hud.statusChip}
                data-mode={timeOfDay === 'sunset' ? 'sunset' : undefined}
                onClick={onToggleTimeOfDay}
                aria-label={
                  vi
                    ? `Đổi ánh sáng bầu trời: hiện tại ${timeOfDay === 'sunset' ? 'Hoàng hôn' : 'Ban ngày'}`
                    : `Switch sky time: currently ${timeOfDay === 'sunset' ? 'Sunset' : 'Daylight'}`
                }
              >
                {timeOfDay === 'sunset' ? <Sunset size={12} /> : <Sun size={12} />}
                <span>{timeOfDay === 'sunset' ? (vi ? 'Hoàng hôn' : 'Sunset') : (vi ? 'Ban ngày' : 'Daylight')}</span>
              </button>
            ) : (
              <span className={hud.statusChip} data-mode={timeOfDay === 'sunset' ? 'sunset' : undefined}>
                {timeOfDay === 'sunset' ? <Sunset size={12} /> : <Sun size={12} />}
                <span>{timeOfDay === 'sunset' ? (vi ? 'Hoàng hôn' : 'Sunset') : (vi ? 'Ban ngày' : 'Daylight')}</span>
              </span>
            )}

            <span
              className={hud.statusChip}
              data-mode={hudSnap.swimMode !== 'land' || isOnBoat ? 'water' : undefined}
              data-testid="arena-minimap-locomotion"
            >
              {isOnBoat ? <Ship size={12} /> : hudSnap.swimMode !== 'land' ? <Waves size={12} /> : <Navigation size={12} />}
              <span>{formatSwimModeLabel(hudSnap.swimMode, isOnBoat, vi)}</span>
            </span>

            {onOpenCollection && (
              <button
                type="button"
                className={hud.statusChip}
                onClick={onOpenCollection}
                aria-label={vi ? 'Mở Sổ tay Sinh vật biển và Trái cây' : 'Open Marine and Fruit Field Guide'}
                data-testid="arena-open-collection"
              >
                <BookOpen size={12} />
                <span>{vi ? 'Sổ tay' : 'Logbook'}</span>
              </button>
            )}
          </div>

          {effectiveWaypoint && waypointDistanceM !== null && (
            <div className={hud.waypointStrip} data-testid="arena-minimap-waypoint">
              <MapPin size={12} />
              <span>
                {vi ? effectiveWaypoint.labelVi : effectiveWaypoint.labelEn} ·{' '}
                <b className={hud.mono}>{waypointDistanceM}m</b>
              </span>
              <button
                type="button"
                onClick={() => updateWaypoint(null)}
                aria-label={vi ? 'Xóa điểm định hướng' : 'Clear waypoint'}
                style={{ all: 'unset', cursor: 'pointer', display: 'inline-grid', placeItems: 'center' }}
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* ── Expanded Interactive Full Archipelago World Map (<dialog>) ── */}
      <dialog
        ref={dialogRef}
        {...({ closedby: 'any' } as React.DialogHTMLAttributes<HTMLDialogElement>)}
        className={hud.modalDialog}
        aria-labelledby={titleId}
        data-testid="arena-world-map-dialog"
      >
        <header className={hud.modalHeader}>
          <div className={hud.modalTitleBlock}>
            <span className={hud.modalEyebrow}>
              {vi ? 'HẢI ĐỒ TƯƠNG TÁC QUẦN ĐẢO ECHO' : 'ECHO ARCHIPELAGO SEA CHART'}
            </span>
            <h2 id={titleId} className={hud.modalTitle}>
              {vi
                ? '7 Quần Đảo Luyện Nói, Luồng Thuyền và 15 Trạm Chủ Đề'
                : '7 Speaking Islands, Sea Lanes and 15 Practice Stations'}
            </h2>
          </div>
          <div className={hud.modalHeaderActions}>
            {effectiveWaypoint && (
              <button
                type="button"
                className={hud.btn}
                onClick={() => updateWaypoint(null)}
                data-testid="arena-world-map-clear-waypoint"
              >
                <X size={14} />
                <span>{vi ? 'Xóa ghim đường đi' : 'Clear Waypoint'}</span>
              </button>
            )}
            <button
              type="button"
              className={hud.iconBtn}
              onClick={() => setMapOpen(false)}
              aria-label={vi ? 'Đóng hải đồ' : 'Close world map'}
              autoFocus
            >
              <X size={17} />
            </button>
          </div>
        </header>

        <div className={hud.worldMapFilterBar}>
          <div className={hud.filterGroup} role="group" aria-label={vi ? 'Bộ lọc trạm luyện nói' : 'Station category filter'}>
            {(
              [
                ['all', vi ? 'Tất cả 15 trạm' : 'All 15 Stations'],
                ['ielts', 'IELTS Part 1-2-3'],
                ['roleplay', vi ? 'Nhập vai và Chợ biển' : 'Roleplay and Market'],
                ['nature', vi ? 'Thiên nhiên và Biển' : 'Nature and Marine'],
                ['stories', vi ? 'Du lịch và Kể chuyện' : 'Travel and Stories'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={hud.filterPill}
                aria-pressed={filterGroup === key}
                onClick={() => setFilterGroup(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className={`${hud.statusChip} ${hud.mono}`}>
            <Crosshair size={12} />
            <span>
              X {hudSnap.selfX >= 0 ? `+${Math.round(hudSnap.selfX)}` : Math.round(hudSnap.selfX)} · Z{' '}
              {hudSnap.selfZ >= 0 ? `+${Math.round(hudSnap.selfZ)}` : Math.round(hudSnap.selfZ)}
            </span>
          </span>
        </div>

        <div className={hud.worldMapBody}>
          {/* Interactive SVG Bathymetric Chart */}
          <div className={hud.seaChartStage}>
            <div className={`${hud.chartCoordReadout} ${hud.mono}`}>
              <Compass size={13} />
              <span>{currentIslandLabel}</span>
            </div>

            <svg
              className={hud.seaChartSvg}
              viewBox={chartBoundsAndRoutes.viewBox}
              role="img"
              aria-label={
                vi
                  ? 'Bản đồ toàn cảnh quần đảo Echo với 7 hòn đảo chính và 15 trạm luyện nói'
                  : 'Full Echo Archipelago chart with 7 major islands and 15 speaking stations'
              }
            >
              {/* Coordinate Sea Grid */}
              {[-200, -100, 0, 100, 200].map(coord => (
                <g key={coord} stroke="rgba(186, 230, 253, 0.08)" strokeWidth={0.8}>
                  <line
                    x1={coord}
                    y1={chartBoundsAndRoutes.minZ}
                    x2={coord}
                    y2={chartBoundsAndRoutes.minZ + chartBoundsAndRoutes.height}
                  />
                  <line
                    x1={chartBoundsAndRoutes.minX}
                    y1={coord}
                    x2={chartBoundsAndRoutes.minX + chartBoundsAndRoutes.width}
                    y2={coord}
                  />
                </g>
              ))}

              {/* Maritime Ferry and Boat Routes */}
              {chartBoundsAndRoutes.routes.map(route => (
                <path
                  key={route.id}
                  d={route.d}
                  fill="none"
                  stroke="rgba(125, 211, 252, 0.34)"
                  strokeWidth={1.6}
                  strokeDasharray="5 5"
                />
              ))}

              {/* Shallow Reefs and Islands */}
              {precomputedIslands.map(isl => {
                const isSelectedIsland = selectedIslandId === isl.id;
                return (
                  <g
                    key={isl.id}
                    className={hud.stationPinHit}
                    onClick={() => {
                      setSelectedIslandId(isl.id);
                      const firstStationOnIsland = stationPins.find(
                        p => p.station.islandId === isl.id || p.station.legacyIslandId === isl.id,
                      );
                      if (firstStationOnIsland) setSelectedStationId(firstStationOnIsland.station.id);
                    }}
                  >
                    <path d={isl.svgReefPath} fill="rgba(45, 212, 191, 0.18)" />
                    <path
                      d={isl.svgCoastPath}
                      fill={isl.fillColor}
                      stroke={isSelectedIsland ? '#fde047' : isl.shoreColor}
                      strokeWidth={isSelectedIsland ? 3.2 : 2.1}
                    />
                  </g>
                );
              })}

              {/* Bridges */}
              {arenaLayout.bridges.map((b, idx) => (
                <line
                  key={`bridge-${idx}`}
                  x1={b.ax}
                  y1={b.az}
                  x2={b.bx}
                  y2={b.bz}
                  stroke="#d9b382"
                  strokeWidth={Math.max(2.6, b.width * 0.65)}
                  strokeLinecap="round"
                />
              ))}

              {/* Docks / Piers */}
              {arenaLayout.docks.map(d => (
                <g key={d.id}>
                  <line
                    x1={d.ax}
                    y1={d.az}
                    x2={d.bx}
                    y2={d.bz}
                    stroke="#f8e3be"
                    strokeWidth={Math.max(2.8, d.width * 0.62)}
                    strokeLinecap="round"
                  />
                  <circle cx={d.bx} cy={d.bz} r={2.3} fill="#083344" stroke="#f8e3be" strokeWidth={1.1} />
                </g>
              ))}

              {/* Live Boats */}
              {hudSnap.boats.map(b => (
                <g key={b.id} transform={`translate(${b.x.toFixed(1)}, ${b.z.toFixed(1)})`}>
                  <circle r={3.2} fill={b.occupied ? '#fbbf24' : '#e2e8f0'} stroke="#0f172a" strokeWidth={1.1} />
                </g>
              ))}

              {/* Active Waypoint Line and Pin */}
              {effectiveWaypoint && (
                <g>
                  <line
                    x1={hudSnap.selfX}
                    y1={hudSnap.selfZ}
                    x2={effectiveWaypoint.x}
                    y2={effectiveWaypoint.z}
                    stroke="#fbbf24"
                    strokeWidth={1.8}
                    strokeDasharray="4 4"
                  />
                  <circle
                    cx={effectiveWaypoint.x}
                    cy={effectiveWaypoint.z}
                    r={7.5}
                    fill="rgba(251, 191, 36, 0.25)"
                    stroke="#fbbf24"
                    strokeWidth={1.8}
                  />
                  <circle cx={effectiveWaypoint.x} cy={effectiveWaypoint.z} r={3.6} fill="#fbbf24" />
                </g>
              )}

              {/* 15 Distributed Speaking Station Pins */}
              {filteredStations.map(({ station, x, z }) => {
                const isSelected = inspectedPin.station.id === station.id;
                const isVisited = visitedStationIds?.has(station.id);
                return (
                  <g
                    key={station.id}
                    transform={`translate(${x.toFixed(1)}, ${z.toFixed(1)})`}
                    className={hud.stationPinHit}
                    onClick={e => {
                      e.stopPropagation();
                      setSelectedIslandId(null);
                      setSelectedStationId(station.id);
                    }}
                  >
                    {isSelected && (
                      <circle r={9.5} fill="rgba(56, 189, 248, 0.26)" stroke="#fde047" strokeWidth={1.6} />
                    )}
                    <rect
                      x={-4.6}
                      y={-4.6}
                      width={9.2}
                      height={9.2}
                      rx={2}
                      transform="rotate(45)"
                      fill={isSelected ? '#fde047' : isVisited ? '#34d399' : '#38bdf8'}
                      stroke="#082f49"
                      strokeWidth={1.5}
                    />
                  </g>
                );
              })}

              {/* Island Name Callouts */}
              {precomputedIslands
                .filter(isl => isl.isMajor)
                .map(isl => (
                  <g
                    key={`label-${isl.id}`}
                    transform={`translate(${isl.x.toFixed(1)}, ${(isl.z - isl.radius - 7).toFixed(1)})`}
                    pointerEvents="none"
                  >
                    <text
                      textAnchor="middle"
                      fill="#f8fafc"
                      stroke="rgba(4, 20, 34, 0.88)"
                      strokeWidth={3.2}
                      paintOrder="stroke"
                      fontSize={8.5}
                      fontWeight={800}
                    >
                      {vi ? isl.nameVi : isl.nameEn}
                    </text>
                  </g>
                ))}

              {/* Multiplayer Peers */}
              {hudSnap.peers.map(p => (
                <circle
                  key={p.id}
                  cx={p.x}
                  cy={p.z}
                  r={4.2}
                  fill={p.speaking ? '#34d399' : '#bae6fd'}
                  stroke="#082f49"
                  strokeWidth={1.3}
                />
              ))}

              {/* Player Marker + Heading */}
              <g
                transform={`translate(${hudSnap.selfX.toFixed(1)}, ${hudSnap.selfZ.toFixed(1)}) rotate(${(
                  (Math.atan2(Math.sin(hudSnap.selfYaw), -Math.cos(hudSnap.selfYaw)) * 180) /
                  Math.PI
                ).toFixed(1)})`}
                pointerEvents="none"
              >
                <circle r={8.5} fill="rgba(255, 255, 255, 0.22)" />
                <polygon points="0,-7.5 5.2,5.6 0,3 -5.2,5.6" fill="#ffffff" stroke="#083344" strokeWidth={1.5} />
              </g>
            </svg>

            <div className={hud.chartLegend}>
              <span className={hud.legendItem}>
                <i className={hud.legendDot} style={{ background: '#ffffff' }} />
                {vi ? 'Vị trí của bạn' : 'You'}
              </span>
              <span className={hud.legendItem}>
                <i className={hud.legendDot} style={{ background: '#38bdf8', borderRadius: 2 }} />
                {vi ? 'Trạm luyện nói (15)' : 'Speaking Station (15)'}
              </span>
              <span className={hud.legendItem}>
                <i className={hud.legendDot} style={{ background: '#f8e3be' }} />
                {vi ? 'Cầu tàu và Tuyến thuyền' : 'Pier and Boat Route'}
              </span>
              <span className={hud.legendItem}>
                <i className={hud.legendDot} style={{ background: '#fbbf24' }} />
                {vi ? 'Điểm ghim đường đi' : 'Active Waypoint'}
              </span>
            </div>
          </div>

          {/* Right Sidebar: Selected Island + Station Scenario Inspector and Directory */}
          <aside className={hud.worldMapSidebar}>
            <div className={hud.inspectorCard} data-testid="arena-world-map-inspector">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span className={hud.badge}>
                  <Anchor size={11} />
                  <span>{vi ? inspectedIslandMeta.vi : inspectedIslandMeta.en}</span>
                </span>
                <span className={hud.cefrBadge} data-cefr={inspectedPin.station.cefr}>
                  CEFR {inspectedPin.station.cefr}
                </span>
                <span className={hud.badge}>
                  {vi ? inspectedPin.station.categoryLabelVi : inspectedPin.station.categoryLabelEn}
                </span>
              </div>

              <h3 className={hud.inspectorTitle}>
                {vi ? inspectedPin.station.titleVi : inspectedPin.station.titleEn}
              </h3>
              <p className={hud.inspectorDesc}>
                {vi ? inspectedIslandMeta.descriptionVi : inspectedIslandMeta.descriptionEn}
              </p>

              <div className={hud.cueBox}>
                <small>{vi ? 'Chủ đề tiêu biểu tại trạm' : 'Featured speaking scenario'}</small>
                <strong style={{ fontSize: 12.5 }}>
                  {vi
                    ? inspectedPin.station.topics[0].headingVi
                    : inspectedPin.station.topics[0].headingEn}
                </strong>
                <span style={{ fontSize: 12, color: 'var(--ah-soft)', lineHeight: 1.5 }}>
                  {vi
                    ? inspectedPin.station.topics[0].promptVi
                    : inspectedPin.station.topics[0].promptEn}
                </span>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className={hud.btnPrimary}
                  data-testid="arena-world-map-set-waypoint"
                  onClick={() => {
                    updateWaypoint({
                      x: inspectedPin.x,
                      z: inspectedPin.z,
                      labelEn: inspectedPin.station.titleEn,
                      labelVi: inspectedPin.station.titleVi,
                    });
                    setMapOpen(false);
                  }}
                >
                  <MapPin size={14} />
                  <span>{vi ? 'Đặt điểm định hướng' : 'Set Navigation Waypoint'}</span>
                </button>
                <span className={`${hud.statusChip} ${hud.mono}`}>
                  {Math.round(Math.hypot(inspectedPin.x - hudSnap.selfX, inspectedPin.z - hudSnap.selfZ))}m
                </span>
              </div>
            </div>

            <div>
              <small
                style={{
                  display: 'block',
                  marginBottom: 8,
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--ah-muted)',
                }}
              >
                {vi
                  ? `Danh mục trạm (${filteredStations.length}/${arenaStationList.length}) · 7 Quần đảo`
                  : `Station Directory (${filteredStations.length}/${arenaStationList.length}) · 7 Islands`}
              </small>
              <div className={hud.stationDirectoryList} role="listbox" aria-label={vi ? 'Danh sách trạm luyện nói' : 'Speaking stations'}>
                {filteredStations.map(pin => {
                  const selected = pin.station.id === inspectedPin.station.id;
                  return (
                    <button
                      key={pin.station.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={hud.stationListItem}
                      onClick={() => {
                        setSelectedIslandId(null);
                        setSelectedStationId(pin.station.id);
                      }}
                    >
                      <div className={hud.stationListText}>
                        <b>{vi ? pin.station.titleVi : pin.station.titleEn}</b>
                        <small>
                          {vi ? pin.station.locationVi : pin.station.locationEn} ·{' '}
                          {vi ? pin.station.categoryLabelVi : pin.station.categoryLabelEn}
                        </small>
                      </div>
                      <span className={hud.cefrBadge} data-cefr={pin.station.cefr}>
                        {pin.station.cefr}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className={hud.inspectorCard}>
              <small style={{ fontSize: 11, fontWeight: 800, color: 'var(--ah-accent)' }}>
                {vi ? '7 QUẦN ĐẢO CHÍNH' : '7 MAJOR ARCHIPELAGO ISLANDS'}
              </small>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {arenaIslandCatalog.map(meta => (
                  <button
                    key={meta.id}
                    type="button"
                    className={hud.filterPill}
                    aria-pressed={inspectedIslandMeta.id === meta.id}
                    onClick={() => {
                      const firstId = meta.stationIds[0];
                      if (firstId) setSelectedStationId(firstId);
                      setSelectedIslandId(meta.id);
                    }}
                  >
                    <span>{vi ? meta.vi : meta.en}</span>
                  </button>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </dialog>
    </div>
  );
}
