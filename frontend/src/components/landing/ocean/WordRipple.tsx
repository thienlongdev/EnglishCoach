'use client';

import React, { useEffect, useRef } from 'react';
import { oceanSignals } from './oceanSignals';

/**
 * "Every tap writes a word": a tap on open water sends a ripple and a spray of light that gathers into an English
 * word, shows its Vietnamese meaning for a moment, then rises away like bubbles. Echo notices the ripple.
 *
 * Purely decorative and click-through: it never reacts to controls, links, form fields or a text selection, and it
 * is off entirely under prefers-reduced-motion.
 */
const WORDS: Array<[string, string]> = [
  ['hello', 'xin chào'],
  ['curious', 'tò mò'],
  ['brave', 'dũng cảm'],
  ['fluent', 'trôi chảy'],
  ['listen', 'lắng nghe'],
  ['dream', 'ước mơ'],
  ['grow', 'phát triển'],
  ['shine', 'tỏa sáng'],
  ['focus', 'tập trung'],
  ['journey', 'hành trình'],
  ['confident', 'tự tin'],
  ['ocean', 'đại dương'],
  ['wonder', 'điều kỳ diệu'],
  ['echo', 'tiếng vọng'],
  ['speak', 'nói'],
  ['learn', 'học'],
];

// Controls, and text people read or select, never ripple — only open water does.
const NOT_WATER = [
  'a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [tabindex], [contenteditable="true"]',
  'h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, dt, dd, pre, code, img, svg, [data-no-ripple]',
].join(', ');

const BURST = 0.42;
const GATHER = 1.12;
const HOLD = 1.9;
const END = 2.75;

interface Particle {
  bx: number;
  by: number;
  tx: number;
  ty: number;
  delay: number;
  rise: number;
  drift: number;
  r: number;
  color: string;
}

interface Burst {
  x: number;
  y: number;
  cx: number;
  cy: number;
  height: number;
  meaning: string;
  start: number;
  particles: Particle[];
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

function gradientColor(t: number) {
  // cyan-300 → indigo-200 → pink-300, the headline's "bứt phá" gradient.
  const stops = [
    [103, 232, 249],
    [199, 210, 254],
    [249, 168, 212],
  ];
  const s = t < 0.5 ? 0 : 1;
  const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const a = stops[s];
  const b = stops[s + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`;
}

export function WordRipple({ rootId }: { rootId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = document.getElementById(rootId);
    if (!canvas || !root) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    const context = canvas.getContext('2d');
    if (!context) return;
    const ctx: CanvasRenderingContext2D = context;

    const fontFamily = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
    const sampler = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const pointCache = new Map<string, { points: Array<[number, number]>; width: number; height: number }>();
    const bursts: Burst[] = [];
    let wordIndex = Math.floor(Math.random() * WORDS.length);
    let raf = 0;
    let dpr = 1;
    let downX = 0;
    let downY = 0;
    let lastBurst = 0;

    // The backing store exists only while a ripple is alive (a full-screen 2D canvas is tens of MB at 2x).
    const size = () => {
      if (!bursts.length) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(window.innerWidth * dpr);
      const height = Math.round(window.innerHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };

    const wordPoints = (word: string, fontSize: number) => {
      const key = `${word}@${fontSize}`;
      const cached = pointCache.get(key);
      if (cached || !sampler) return cached;
      const font = `800 ${fontSize}px ${fontFamily}`;
      sampler.font = font;
      const width = Math.ceil(sampler.measureText(word).width) + 8;
      const height = Math.ceil(fontSize * 1.3);
      sampler.canvas.width = width;
      sampler.canvas.height = height;
      sampler.font = font;
      sampler.textBaseline = 'middle';
      sampler.fillStyle = '#fff';
      sampler.fillText(word, 4, height / 2);
      const data = sampler.getImageData(0, 0, width, height).data;
      const all: Array<[number, number]> = [];
      const step = fontSize > 40 ? 3 : 2;
      for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
          if (data[(y * width + x) * 4 + 3] > 140) all.push([x, y]);
        }
      }
      const limit = window.innerWidth < 640 ? 170 : 280;
      const points: Array<[number, number]> = [];
      const stride = Math.max(1, all.length / limit);
      for (let i = 0; i < all.length && points.length < limit; i += stride) points.push(all[Math.floor(i)]);
      const entry = { points, width, height };
      pointCache.set(key, entry);
      return entry;
    };

    const spawn = (x: number, y: number) => {
      const [word, meaning] = WORDS[wordIndex];
      wordIndex = (wordIndex + 1 + Math.floor(Math.random() * 3)) % WORDS.length;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const fontSize = vw < 640 ? 38 : 52;
      const shape = wordPoints(word, fontSize);
      if (!shape) return;
      const cx = Math.min(vw - shape.width / 2 - 16, Math.max(shape.width / 2 + 16, x));
      const cy = Math.min(vh - shape.height - 40, Math.max(shape.height, y - 8));
      const particles: Particle[] = shape.points.map(([sx, sy]) => {
        const angle = Math.random() * Math.PI * 2;
        const distance = 40 + Math.random() * 110;
        return {
          bx: x + Math.cos(angle) * distance,
          by: y + Math.sin(angle) * distance,
          tx: cx - shape.width / 2 + sx,
          ty: cy - shape.height / 2 + sy,
          delay: Math.random() * 0.14,
          rise: 18 + Math.random() * 46,
          drift: (Math.random() - 0.5) * 18,
          r: (fontSize > 40 ? 1.35 : 1.1) + Math.random() * 0.6,
          color: gradientColor(sx / shape.width),
        };
      });
      bursts.push({ x, y, cx, cy, height: shape.height, meaning, start: performance.now(), particles });
      if (bursts.length > 3) bursts.shift();
      size();
      oceanSignals.rippleX = x;
      oceanSignals.rippleY = y;
      oceanSignals.rippleAt = performance.now();
      window.dispatchEvent(new Event('ocean:wake'));
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const draw = (now: number) => {
      raf = 0;
      // Clear in backing-store pixels. Under the dpr transform a browser zoomed out (dpr < 1) only cleared `dpr` of the width and height, and the
      // light of every later frame piled up to white in the part left uncleared.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (let b = bursts.length - 1; b >= 0; b--) {
        const burst = bursts[b];
        const t = (now - burst.start) / 1000;
        if (t > END) {
          bursts.splice(b, 1);
          continue;
        }

        // Water rings.
        ctx.globalCompositeOperation = 'source-over';
        for (const [delay, radius] of [
          [0, 120],
          [0.14, 74],
        ] as const) {
          const k = clamp01((t - delay) / 1.0);
          if (k <= 0 || k >= 1) continue;
          ctx.beginPath();
          ctx.ellipse(burst.x, burst.y, radius * easeOut(k), radius * easeOut(k) * 0.42, 0, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(165, 243, 252, ${(0.55 * (1 - k)).toFixed(3)})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Light: burst out, gather into the word, shimmer, rise away.
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < burst.particles.length; i++) {
          const p = burst.particles[i];
          let x: number;
          let y: number;
          let alpha = 1;
          if (t < BURST) {
            const k = easeOut(t / BURST);
            x = burst.x + (p.bx - burst.x) * k;
            y = burst.y + (p.by - burst.y) * k;
            alpha = 0.4 + 0.6 * k;
          } else if (t < GATHER) {
            const k = easeInOut(clamp01((t - BURST - p.delay) / (GATHER - BURST - 0.14)));
            x = p.bx + (p.tx - p.bx) * k;
            y = p.by + (p.ty - p.by) * k;
          } else if (t < HOLD) {
            x = p.tx + Math.sin(now / 160 + i) * 0.35;
            y = p.ty + Math.cos(now / 190 + i * 1.7) * 0.35;
          } else {
            const k = clamp01((t - HOLD) / (END - HOLD));
            x = p.tx + p.drift * k + Math.sin(k * 6 + i) * 2 * k;
            y = p.ty - p.rise * k * k;
            alpha = 1 - k;
          }
          ctx.globalAlpha = 0.16 * alpha;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(x, y, p.r * 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = alpha;
          ctx.beginPath();
          ctx.arc(x, y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }

        // The meaning, in Vietnamese, under the word.
        const captionAlpha = clamp01((t - 1.0) / 0.3) * (1 - clamp01((t - 2.05) / 0.45));
        if (captionAlpha > 0) {
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = captionAlpha;
          ctx.font = `600 13px ${fontFamily}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = 'rgb(203, 213, 225)';
          ctx.fillText(burst.meaning, burst.cx, burst.cy + burst.height / 2 + 6 - (1 - captionAlpha) * 4);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (bursts.length) raf = requestAnimationFrame(draw);
      else canvas.width = canvas.height = 0;
    };

    const onPointerDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
    };

    const onClick = (event: MouseEvent) => {
      if (reduce.matches || event.button !== 0) return;
      const target = event.target as Element | null;
      if (!target || target.closest(NOT_WATER)) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 8) return;
      const now = performance.now();
      if (now - lastBurst < 220) return;
      lastBurst = now;
      spawn(event.clientX, event.clientY);
    };

    canvas.width = canvas.height = 0;
    window.addEventListener('resize', size, { passive: true });
    root.addEventListener('pointerdown', onPointerDown, { passive: true });
    root.addEventListener('click', onClick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', size);
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('click', onClick);
    };
  }, [rootId]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[3] h-full w-full"
      data-purpose="landing-word-ripple"
    />
  );
}
