'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { makeBridge } from '@/lib/spatial/engine/controller';
import { plainText } from '@/lib/spatial/engine/typography';
import type { SpatialPreference } from '@/lib/spatial/preference';
import { PALETTES } from '@/lib/spatial/catalog';
import type { GalleryLayout, PaletteId } from '@/lib/spatial/types';
import { startWorld, type WorldRuntime } from '@/lib/wallpaper/worlds/runtime';

/**
 * Phòng trưng bày. The current page's REAL items as bent planes in a 3D room: the same cards, their own pictures and titles, and opening one clicks the real element, so navigation, handlers and
 * permissions are exactly the page's. Entered only by the learner's click, because this room owns the wheel and the keyboard while it is open (the page underneath never lost its scroll).
 * Everything here is also a real list of buttons for a keyboard or a screen reader.
 */

interface RoomItem {
  title: string;
  image: string | null;
  source: HTMLElement;
  click: HTMLElement;
}

const TILE_W = 416;
const TILE_H = 264;
const MAX_ITEMS = 36;

function readItems(elements: HTMLElement[]): RoomItem[] {
  const out: RoomItem[] = [];
  const seen = new Set<string>();
  for (const source of elements) {
    if (out.length >= MAX_ITEMS) break;
    const click = (source.matches('a[href],button,[role="button"],[role="link"]') ? source : source.querySelector('a[href],button:not([aria-haspopup]),[role="button"]')) as HTMLElement | null;
    if (!click) continue;
    const heading = source.querySelector('h1,h2,h3,h4,h5,strong,[class*="title" i]');
    const raw = plainText(heading ?? source);
    if (!raw) continue;
    const title = raw.length > 72 ? `${raw.slice(0, 70)}…` : raw;
    if (seen.has(title)) continue;
    seen.add(title);
    const img = source.querySelector('img') as HTMLImageElement | null;
    out.push({ title, image: img?.currentSrc || img?.src || null, source, click });
  }
  return out;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, line: number, maxLines: number) {
  const words = text.split(' ');
  let current = '';
  let row = 0;
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width > width && current) {
      ctx.fillText(current, x, y + row * line);
      row += 1;
      current = word;
      if (row >= maxLines) return;
    } else current = next;
  }
  if (current) ctx.fillText(current, x, y + row * line);
}

function drawTile(ctx: CanvasRenderingContext2D, x: number, y: number, item: RoomItem, tones: string[], image: HTMLImageElement | null, index: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, TILE_W, TILE_H);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x + TILE_W, y + TILE_H);
  g.addColorStop(0, tones[1]);
  g.addColorStop(1, tones[index % 2 ? 2 : 3]);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, TILE_W, TILE_H);
  if (image) {
    const scale = Math.max(TILE_W / image.naturalWidth, TILE_H / image.naturalHeight);
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;
    ctx.drawImage(image, x + (TILE_W - w) / 2, y + (TILE_H - h) / 2, w, h);
  }
  const band = ctx.createLinearGradient(x, y + TILE_H * 0.35, x, y + TILE_H);
  band.addColorStop(0, 'rgba(4,8,20,0)');
  band.addColorStop(1, 'rgba(4,8,20,0.9)');
  ctx.fillStyle = band;
  ctx.fillRect(x, y, TILE_W, TILE_H);
  ctx.fillStyle = '#f8fafc';
  ctx.font = `700 26px ${getComputedStyle(document.body).fontFamily}`;
  ctx.textBaseline = 'alphabetic';
  wrapText(ctx, item.title, x + 22, y + TILE_H - 68, TILE_W - 44, 31, 2);
  ctx.restore();
}

export default function SpatialGalleryRoom({
  layout,
  palette,
  items: elements,
  pref,
  dark,
  reduced,
  vi,
  onClose,
  onHold,
}: {
  layout: GalleryLayout;
  palette: PaletteId;
  items: HTMLElement[];
  pref: SpatialPreference;
  dark: boolean;
  reduced: boolean;
  vi: boolean;
  onClose: () => void;
  onHold: (held: boolean) => void;
}) {
  const items = useMemo(() => readItems(elements), [elements]);
  const hostRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);
  const [focus, setFocus] = useState(0);
  const [ready, setReady] = useState(false);
  const apiRef = useRef<import('@/lib/spatial/scenes/gallery').GalleryScene | null>(null);
  const motion = useRef({ phase: 0, phaseV: 0, yaw: 0, yawV: 0, pitch: 0, pitchV: 0, dragging: false, moved: 0, lastX: 0, lastY: 0 });

  const planes = Math.max(items.length, Math.min(14, items.length * 2));
  const itemAt = (plane: number) => items[plane % Math.max(1, items.length)];

  useEffect(() => {
    openerRef.current = document.activeElement;
    onHold(true);
    closeRef.current?.focus();
    return () => {
      onHold(false);
      (openerRef.current as HTMLElement | null)?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !items.length) return;
    const cols = 6;
    const rows = Math.ceil(items.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = cols * TILE_W;
    canvas.height = rows * TILE_H;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const tones = dark ? PALETTES[palette].dark : PALETTES[palette].light;
    const tileXY = (i: number): [number, number] => [(i % items.length) % cols, Math.floor((i % items.length) / cols)];
    items.forEach((item, i) => {
      const [c, r] = tileXY(i);
      drawTile(ctx, c * TILE_W, r * TILE_H, item, tones, null, i);
    });
    let disposed = false;
    // A picture that cannot be read by the GPU (another site without permission) keeps its typographic tile: never a broken plane.
    items.forEach((item, i) => {
      if (!item.image) return;
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      image.onload = () => {
        if (disposed) return;
        const [c, r] = tileXY(i);
        drawTile(ctx, c * TILE_W, r * TILE_H, item, tones, image, i);
        const tex = (canvas as HTMLCanvasElement & { __tex?: { needsUpdate: boolean } }).__tex;
        if (tex) tex.needsUpdate = true;
      };
      image.src = item.image;
    });
    const bridge = makeBridge(pref);
    let runtime: WorldRuntime | null = null;
    runtime = startWorld({
      id: `spatial-room:${layout}`,
      host,
      params: { motion: pref.motion, pointer: pref.pointer, calm: 0, dark },
      still: false,
      context: { antialias: true, depth: true },
      load: async () => {
        const { buildGallery } = await import('@/lib/spatial/scenes/gallery');
        return (env) =>
          buildGallery(env, bridge, palette, {
            layout,
            urls: [],
            count: planes,
            room: true,
            atlasCanvas: { canvas, cols, rows, tileOf: tileXY },
            onReady: (api) => {
              apiRef.current = api;
            },
          });
      },
      onFirstFrame: () => setReady(true),
      onFail: () => setReady(false),
    });
    // Inertia lives here (the scene only reads the state).
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
      last = now;
      const m = motion.current;
      const api = apiRef.current;
      if (api) {
        const drag = reduced ? 30 : 3.4;
        m.phase += m.phaseV * dt;
        m.yaw += m.yawV * dt;
        m.pitch += m.pitchV * dt;
        if (!m.dragging) {
          m.phaseV *= Math.exp(-dt * drag);
          m.yawV *= Math.exp(-dt * drag);
          m.pitchV *= Math.exp(-dt * drag);
        }
        m.pitch = Math.max(-1, Math.min(1, m.pitch));
        api.state.phase = m.phase;
        api.state.yaw = m.yaw;
        api.state.pitch = m.pitch;
        setFocus((prev) => (prev === api.state.focus ? prev : api.state.focus));
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(raf);
      runtime?.dispose();
      apiRef.current = null;
    };
    // The room is built once, from the items it opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activate = (plane: number) => {
    const item = itemAt(plane);
    if (!item) return;
    const target = item.click;
    onClose();
    // After the room is gone: the page's own element, its own handler.
    window.setTimeout(() => {
      if (target.isConnected) target.click();
    }, 30);
  };

  // The room owns the keyboard while it is open, wherever the focus went after a drag on the canvas.
  const latest = useRef({ focus, activate, onClose });
  latest.current = { focus, activate, onClose };
  useEffect(() => {
    const onWindowKey = (event: KeyboardEvent) => {
      const m = motion.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        latest.current.onClose();
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        m.phaseV = 2.4;
        m.yawV = -0.7;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        m.phaseV = -2.4;
        m.yawV = 0.7;
      } else if (event.key === 'Enter' && (event.target as HTMLElement).tagName !== 'BUTTON') {
        latest.current.activate(latest.current.focus);
      }
    };
    window.addEventListener('keydown', onWindowKey, true);
    return () => window.removeEventListener('keydown', onWindowKey, true);
  }, []);

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') {
      const root = event.currentTarget as HTMLElement;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>('button'));
      if (!nodes.length) return;
      const first = nodes[0];
      const lastNode = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        lastNode.focus();
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const current = itemAt(focus);
  return (
    <div
      className="ec-sp-lens"
      role="dialog"
      aria-modal="true"
      aria-label={vi ? 'Phòng trưng bày nội dung của trang này' : "A gallery room of this page's content"}
      data-testid="spatial-room"
      onKeyDown={onKey}
      onWheel={(event) => {
        const m = motion.current;
        m.phaseV += event.deltaY * 0.0042;
        m.yawV -= event.deltaY * 0.0012;
        m.phaseV = Math.max(-8, Math.min(8, m.phaseV));
      }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        const m = motion.current;
        m.dragging = true;
        m.moved = 0;
        m.lastX = event.clientX;
        m.lastY = event.clientY;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const m = motion.current;
        if (!m.dragging) return;
        const dx = event.clientX - m.lastX;
        const dy = event.clientY - m.lastY;
        m.lastX = event.clientX;
        m.lastY = event.clientY;
        m.moved += Math.abs(dx) + Math.abs(dy);
        m.yawV = dx * 0.14;
        m.phaseV = -dx * 0.22;
        m.pitchV = dy * 0.09;
      }}
      onPointerUp={(event) => {
        const m = motion.current;
        if (!m.dragging) return;
        m.dragging = false;
        if (m.moved < 6 && !(event.target as HTMLElement).closest('button')) {
          const u = event.clientX / window.innerWidth;
          const v = 1 - event.clientY / window.innerHeight;
          const plane = apiRef.current?.pick(u, v) ?? -1;
          if (plane >= 0) {
            if (plane === focus) activate(plane);
            else m.phaseV = plane > focus ? 2 : -2;
          }
        }
      }}
    >
      <div ref={hostRef} className="ec-sp-lens-host" aria-hidden="true" />
      <div className="ec-sp-lens-top">
        <p className="ec-sp-lens-title">{vi ? `Phòng trưng bày · ${items.length} mục thật của trang này · kéo, cuộn hoặc dùng phím mũi tên` : `Gallery room · ${items.length} real items of this page · drag, scroll or use the arrow keys`}</p>
        <button ref={closeRef} type="button" className="ec-sp-lens-close" onClick={onClose} data-testid="spatial-room-close">
          <X size={14} style={{ display: 'inline', marginRight: 4, verticalAlign: '-2px' }} aria-hidden="true" />
          {vi ? 'Đóng' : 'Close'}
        </button>
      </div>
      {!ready && <p className="ec-sp-lens-title" style={{ position: 'absolute', left: 16, top: 60 }}>{vi ? 'Đang dựng phòng trưng bày…' : 'Building the room…'}</p>}
      {current && (
        <div className="ec-sp-lens-focus" aria-live="polite">
          <span className="ec-sp-lens-name" data-testid="spatial-room-focus">{current.title}</span>
          <button type="button" className="ec-sp-lens-open" onClick={() => activate(focus)} data-testid="spatial-room-activate">
            {vi ? 'Mở' : 'Open'}
          </button>
        </div>
      )}
      <ul className="ec-sp-sr" aria-label={vi ? 'Danh sách mục' : 'Items'}>
        {items.map((item, i) => (
          <li key={item.title}>
            <button type="button" onClick={() => activate(i)}>{item.title}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
