import React from 'react';
import styles from '../landing.module.css';

/**
 * Foreground reef framing a section's lower corner: hazed far rock, dark near rocks lit along their crests,
 * branching coral with glowing polyps that twinkle, and sea grass that sways. Pure SVG + CSS (works without WebGL,
 * stills under reduced motion), generated from a fixed seed so the server and the browser draw the same reef.
 */
interface OceanReefProps {
  side: 'left' | 'right';
  /** `final` glows a little warmer (violet / pink polyps) for the closing section. */
  variant?: 'hero' | 'final';
  seed?: number;
  className?: string;
}

const W = 640;
const H = 340;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number) => n.toFixed(1);

/** A rock mass: a bumpy crest from x0 to x1 rising to `height`, closed along the bottom edge. */
function rockPath(rand: () => number, x0: number, x1: number, height: number) {
  const points: Array<[number, number]> = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const x = x0 + (x1 - x0) * u;
    const crest = Math.pow(Math.sin(Math.PI * u), 0.75);
    const bump = (rand() - 0.5) * height * 0.22;
    points.push([x, H - Math.max(0, crest * height + (i > 0 && i < steps ? bump : 0))]);
  }
  let rim = `M ${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 1; i < points.length; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    rim += ` Q ${f(px)} ${f(py)} ${f((px + x) / 2)} ${f((py + y) / 2)}`;
  }
  const last = points[points.length - 1];
  const d = `M ${f(points[0][0])} ${H} L ${rim.slice(2)} L ${f(last[0])} ${H} Z`;
  return { d, rim, crest: points };
}

interface Branch {
  d: string;
  width: number;
}
interface Polyp {
  x: number;
  y: number;
  r: number;
  hue: number;
  delay: number;
}

function coral(rand: () => number, x: number, y: number, angle: number, length: number, width: number, depth: number, out: Branch[], tips: Polyp[]) {
  const x2 = x + Math.sin(angle) * length;
  const y2 = y - Math.cos(angle) * length;
  const bend = (rand() - 0.5) * length * 0.35;
  const cx = (x + x2) / 2 + Math.cos(angle) * bend;
  const cy = (y + y2) / 2 + Math.sin(angle) * bend;
  out.push({ d: `M ${f(x)} ${f(y)} Q ${f(cx)} ${f(cy)} ${f(x2)} ${f(y2)}`, width });
  if (depth === 0 || length < 9) {
    if (rand() > 0.45) return; // only some tips glow
    tips.push({ x: x2, y: y2, r: 1.6 + rand() * 1.8, hue: rand(), delay: rand() * 4 });
    return;
  }
  const spread = 0.32 + rand() * 0.3;
  coral(rand, x2, y2, angle - spread, length * (0.68 + rand() * 0.12), width * 0.7, depth - 1, out, tips);
  coral(rand, x2, y2, angle + spread, length * (0.68 + rand() * 0.12), width * 0.7, depth - 1, out, tips);
  if (rand() < 0.3) coral(rand, x2, y2, angle + (rand() - 0.5) * 0.3, length * 0.6, width * 0.6, depth - 1, out, tips);
}

function buildReef(seed: number) {
  const rand = rng(seed);
  const far = rockPath(rand, 120, W, 150 + rand() * 40);
  const near = [rockPath(rand, -20, 330, 120 + rand() * 30), rockPath(rand, 240, 520, 70 + rand() * 25)];
  const branches: Branch[] = [];
  const polyps: Polyp[] = [];
  // Corals stand on the near crests.
  for (const rock of near) {
    const count = 2;
    for (let c = 0; c < count; c++) {
      const [x, y] = rock.crest[3 + Math.floor(rand() * (rock.crest.length - 6))];
      coral(rand, x, y + 4, (rand() - 0.5) * 0.5, 30 + rand() * 22, 5 + rand() * 2, 4, branches, polyps);
    }
  }
  // Sea grass blades along the base.
  const grass = Array.from({ length: 7 }, () => {
    const x = 20 + rand() * 420;
    const h = 60 + rand() * 80;
    const lean = (rand() - 0.5) * 40;
    return { d: `M ${f(x)} ${H} C ${f(x + lean * 0.2)} ${f(H - h * 0.45)} ${f(x + lean)} ${f(H - h * 0.7)} ${f(x + lean * 1.3)} ${f(H - h)}`, delay: rand() * 5, x };
  });
  return { far, near, branches, polyps, grass };
}

export function OceanReef({ side, variant = 'hero', seed = 7, className = '' }: OceanReefProps) {
  const reef = buildReef(seed + (side === 'right' ? 101 : 0));
  const id = `reef-${variant}-${side}-${seed}`;
  const palette =
    variant === 'final'
      ? ['#8be9ff', '#c4b5fd', '#f9a8d4']
      : ['#7fe3ff', '#a5f3fc', '#c4b5fd'];
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute bottom-0 ${styles.reefFade} ${side === 'left' ? 'left-0' : 'right-0'} ${className}`}
      style={side === 'right' ? { transform: 'scaleX(-1)' } : undefined}
      data-purpose="landing-reef"
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMax meet" className="block h-full w-full overflow-visible">
        <defs>
          <linearGradient id={`${id}-far`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1a5fb0" stopOpacity="0.55" />
            <stop offset="1" stopColor="#0a2d66" stopOpacity="0.75" />
          </linearGradient>
          <linearGradient id={`${id}-near`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0a3270" />
            <stop offset="0.3" stopColor="#051c48" />
            <stop offset="1" stopColor="#020c28" />
          </linearGradient>
          <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#7dd3fc" stopOpacity="0" />
            <stop offset="0.5" stopColor="#7dd3fc" stopOpacity="0.55" />
            <stop offset="1" stopColor="#7dd3fc" stopOpacity="0.1" />
          </linearGradient>
          <radialGradient id={`${id}-glow`}>
            <stop offset="0" stopColor="currentColor" stopOpacity="0.9" />
            <stop offset="0.4" stopColor="currentColor" stopOpacity="0.35" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </radialGradient>
        </defs>

        <path d={reef.far.d} fill={`url(#${id}-far)`} />

        <g className={styles.reefGrass} stroke="#0b3570" strokeWidth="3" fill="none" strokeLinecap="round">
          {reef.grass.map((blade, i) => (
            <path key={i} d={blade.d} style={{ animationDelay: `-${blade.delay.toFixed(2)}s`, transformOrigin: `${blade.x.toFixed(0)}px ${H}px` }} />
          ))}
        </g>

        <g stroke="#06275a" fill="none" strokeLinecap="round">
          {reef.branches.map((b, i) => (
            <path key={i} d={b.d} strokeWidth={b.width.toFixed(1)} />
          ))}
        </g>
        {/* light from above catching the upper side of each branch */}
        <g stroke="#5fb4ff" strokeOpacity="0.32" fill="none" strokeLinecap="round" transform="translate(-0.8 -1.2)">
          {reef.branches.map((b, i) => (
            <path key={i} d={b.d} strokeWidth={(b.width * 0.35).toFixed(1)} />
          ))}
        </g>

        {reef.near.map((rock, i) => (
          <g key={i}>
            <path d={rock.d} fill={`url(#${id}-near)`} />
            <path
              d={rock.rim}
              fill="none"
              stroke={`url(#${id}-rim)`}
              strokeWidth="2.2"
            />
          </g>
        ))}

        {reef.polyps.map((p, i) => (
          <g key={i} className={styles.reefPolyp} style={{ animationDelay: `-${p.delay.toFixed(2)}s`, color: palette[Math.floor(p.hue * 3)] }}>
            <circle cx={f(p.x)} cy={f(p.y)} r={f(p.r * 2.4)} fill={`url(#${id}-glow)`} opacity="0.75" />
            <circle cx={f(p.x)} cy={f(p.y)} r={f(p.r * 0.55)} fill="currentColor" />
          </g>
        ))}
      </svg>
    </div>
  );
}
