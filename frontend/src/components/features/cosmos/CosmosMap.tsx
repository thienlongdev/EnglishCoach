'use client';
/**
 * Bản đồ sao — the universe seen from above: every galaxy the learner has, the constellations of the galaxy in view, and
 * where the camera is and looks. Any destination is one press away from anywhere (no climbing back to the root first);
 * the map is a navigation aid only — positions are the layout's, never a relation, and nothing here is counted as knowledge.
 */
import { Compass } from 'lucide-react';
import { useMemo } from 'react';
import type { Focus } from '@/lib/cosmos/view';
import type { CosmosGraph } from '@/lib/cosmos/types';
import s from './cosmos.module.css';

const SIZE = 172, PAD = 14;

export default function CosmosMap({ g, focus, vi, cam, counts, onGo, className, hudEdge }: {
  g: CosmosGraph; focus: Focus; vi: boolean; cam: { target: [number, number, number]; pos: [number, number, number] } | null;
  counts: Int32Array; onGo: (f: Focus) => void; className?: string; hudEdge?: string;
}) {
  const T = (a: string, b: string) => (vi ? a : b);
  // One fit for the whole map: the learner's galaxies with their radii, seen from above (x → right, z → down).
  const fit = useMemo(() => {
    const gs = g.galaxies.filter(x => counts[x.i] > 0);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const x of gs) { minX = Math.min(minX, x.x - x.radius); maxX = Math.max(maxX, x.x + x.radius); minZ = Math.min(minZ, x.z - x.radius); maxZ = Math.max(maxZ, x.z + x.radius); }
    if (!gs.length) { minX = minZ = -1; maxX = maxZ = 1; }
    const span = Math.max(maxX - minX, maxZ - minZ, 1), k = (SIZE - PAD * 2) / span;
    const ox = PAD + ((SIZE - PAD * 2) - (maxX - minX) * k) / 2 - minX * k, oz = PAD + ((SIZE - PAD * 2) - (maxZ - minZ) * k) / 2 - minZ * k;
    return { gs, k, at: (x: number, z: number) => [ox + x * k, oz + z * k] as const };
  }, [g, counts]);
  const cons = focus.galaxy >= 0 ? g.constellations.filter(c => c.galaxy === focus.galaxy && c.count > 0) : [];
  const marker = cam ? (() => {
    const [tx, , tz] = cam.target, [px, , pz] = cam.pos;
    const [x, y] = fit.at(tx, tz), dx = tx - px, dz = tz - pz, l = Math.hypot(dx, dz) || 1;
    return { x: Math.max(4, Math.min(SIZE - 4, x)), y: Math.max(4, Math.min(SIZE - 4, y)), a: Math.atan2(dz / l, dx / l) * 180 / Math.PI };
  })() : null;
  return (
    <nav className={`${s.panel} ${s.starMap} ${className ?? ''}`} data-hud-chrome={hudEdge} aria-label={T('Bản đồ sao: đi thẳng đến thiên hà hay chòm sao', 'Star map: go straight to a galaxy or constellation')} data-testid="cosmos-map">
      <div className={s.mapHead}><b>{T('Bản đồ sao', 'Star map')}</b>
        <button className={s.mapHome} onClick={() => onGo({ level: 'universe', galaxy: -1, constellation: -1, system: -1, node: -1 })} aria-label={T('Toàn cảnh vũ trụ (Home)', 'Whole universe (Home)')} title={T('Toàn cảnh (Home)', 'Overview (Home)')} data-testid="cosmos-map-home"><Compass size={14} /></button></div>
      <div className={s.mapField} style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} aria-hidden="true" className={s.mapSvg}>
          {fit.gs.map(x => { const [cx, cy] = fit.at(x.x, x.z); return <circle key={x.i} cx={cx} cy={cy} r={Math.max(5, x.radius * fit.k * 0.8)} fill={x.color} fillOpacity={x.i === focus.galaxy ? 0.32 : 0.16} stroke={x.color} strokeOpacity={x.i === focus.galaxy ? 0.95 : 0.45} strokeWidth={x.i === focus.galaxy ? 1.6 : 1} />; })}
          {marker && <g transform={`translate(${marker.x} ${marker.y}) rotate(${marker.a})`}><path d="M 7 0 L -4 -4.5 L -2 0 L -4 4.5 Z" fill="#fff" stroke="#0e7490" strokeWidth="1" /></g>}
        </svg>
        {fit.gs.map(x => {
          const [cx, cy] = fit.at(x.x, x.z), r = Math.max(9, x.radius * fit.k * 0.8);
          return <button key={x.i} className={s.mapGalaxy} style={{ left: cx - r, top: cy - r, width: r * 2, height: r * 2 }} aria-current={x.i === focus.galaxy && focus.level === 'galaxy' ? 'location' : undefined}
            onClick={() => onGo({ level: 'galaxy', galaxy: x.i, constellation: -1, system: -1, node: -1 })} data-testid="cosmos-map-galaxy"
            aria-label={T(`Bay đến thiên hà ${x.vi} (${counts[x.i]} ngôi sao)`, `Fly to the ${x.en} galaxy (${counts[x.i]} stars)`)} title={`${vi ? x.vi : x.en} · ${counts[x.i]}`} />;
        })}
        {cons.map(c => {
          const [cx, cy] = fit.at(c.x, c.z);
          return <button key={c.i} className={s.mapCons} style={{ left: cx - 6, top: cy - 6 }} aria-current={c.i === focus.constellation ? 'location' : undefined}
            onClick={() => onGo({ level: 'constellation', galaxy: c.galaxy, constellation: c.i, system: -1, node: -1 })} data-testid="cosmos-map-constellation"
            aria-label={T(`Bay đến chòm sao ${c.vi}`, `Fly to the ${c.en} constellation`)} title={vi ? c.vi : c.en} />;
        })}
      </div>
    </nav>
  );
}
