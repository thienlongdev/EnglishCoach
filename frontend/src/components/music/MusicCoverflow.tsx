'use client';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import type { MusicTrack } from '@/lib/music/model';
import { MusicArtwork } from './MusicArtwork';
import styles from './Music.module.css';

// Slot geometry in "card widths": x, depth, turn, scale, opacity per |offset|.
const SLOTS = [[0, 70, 0, 1, 1], [.78, -90, 34, .9, .92], [1.38, -240, 44, .8, .6], [1.86, -380, 50, .7, .22]] as const;

/**
 * A glassy coverflow of the curated recordings. Cards sit on a ring (the list is doubled when short, so the card that wraps
 * around always travels behind the scenes). Centre card plays; side cards bring themselves to the centre.
 */
export default function MusicCoverflow({ tracks, currentId, playing, vi, moodLabel, onPlay }: {
  tracks: MusicTrack[]; currentId?: string; playing: boolean; vi: boolean; moodLabel: (track: MusicTrack) => string; onPlay: (id: string) => void;
}) {
  const ring = tracks.length && tracks.length < 8 ? [...tracks, ...tracks] : tracks;
  const count = ring.length;
  const [active, setActive] = useState(() => Math.max(0, tracks.findIndex(t => t.id === currentId)));
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; id: number; moved: boolean } | null>(null);
  // Follow the player: when another recording starts, bring its nearest copy to the centre.
  useEffect(() => {
    if (!currentId) return;
    setActive(now => {
      let best = now, distance = Infinity;
      ring.forEach((track, index) => { if (track.id !== currentId) return; const d = Math.abs(wrap(index - now, count)); if (d < distance) { distance = d; best = index; } });
      return best;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, count]);
  if (!count) return null;
  const move = (delta: number) => setActive(now => (now + delta + count) % count);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    drag.current = { x: event.clientX, id: event.pointerId, moved: false };
  };
  const over = (event: PointerEvent) => {
    const state = drag.current; if (!state || state.id !== event.pointerId || !stage.current) return;
    const dx = event.clientX - state.x;
    if (!state.moved && Math.abs(dx) > 8) { state.moved = true; stage.current.setPointerCapture(event.pointerId); stage.current.dataset.dragging = 'true'; }
    if (state.moved) stage.current.style.setProperty('--drag', `${dx * .6}px`);
  };
  const up = (event: PointerEvent) => {
    const state = drag.current; drag.current = null; if (!state || !stage.current) return;
    stage.current.style.setProperty('--drag', '0px'); delete stage.current.dataset.dragging;
    if (!state.moved) return;
    const dx = event.clientX - state.x, card = stage.current.querySelector<HTMLElement>('[data-offset="0"]')?.offsetWidth ?? 220;
    const steps = Math.max(1, Math.round(Math.abs(dx) / (card * .7)));
    if (Math.abs(dx) > 36) move(dx < 0 ? steps : -steps);
    // Swallow the click that ends a drag (only that one).
    const element = stage.current;
    element.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => element.removeEventListener('click', swallow, { capture: true }), 0);
  };

  return <div className={styles.coverflow} role="group" aria-roledescription={vi ? 'băng chuyền' : 'carousel'} aria-label={vi ? 'Bản nhạc tuyển chọn' : 'Curated recordings'} onKeyDown={onKey}>
    <div ref={stage} className={styles.flowStage} onPointerDown={down} onPointerMove={over} onPointerUp={up} onPointerCancel={up} data-testid="music-coverflow">
      {ring.map((track, index) => {
        const offset = wrap(index - active, count), distance = Math.abs(offset), [x, z, turn, scale, opacity] = SLOTS[Math.min(distance, 3)];
        const hidden = distance > 2, centre = offset === 0, current = track.id === currentId;
        return <div key={index} className={styles.flowCard} data-offset={offset} data-current={current || undefined} aria-hidden={hidden || undefined} inert={hidden || undefined}
          style={{ '--x': Math.sign(offset) * x, '--z': `${distance > 3 ? -520 : z}px`, '--turn': `${-Math.sign(offset) * turn}deg`, '--s': scale, '--o': distance > 3 ? 0 : opacity, zIndex: 10 - distance, '--music-accent': track.accent } as CSSProperties}>
          <button type="button" className={styles.flowFace} tabIndex={centre ? -1 : 0} aria-hidden={centre || undefined}
            onClick={() => !centre && move(offset)} aria-label={`${vi ? 'Xem' : 'Show'} ${track.title}`}>
            <MusicArtwork track={track} className={styles.flowArt} priority={distance < 2} />
            <span className={styles.flowShade} aria-hidden="true" />
          </button>
          <div className={styles.flowCaption}>
            <span><small>{moodLabel(track)}</small><strong>{track.title}</strong><em>{track.artist}</em></span>
            {centre && <button type="button" className={styles.flowPlay} onClick={() => onPlay(track.id)} data-testid="music-coverflow-play"
              aria-label={`${current && playing ? (vi ? 'Tạm dừng' : 'Pause') : (vi ? 'Phát' : 'Play')} ${track.title}`}>
              {current && playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            </button>}
          </div>
          {current && playing && <span className={styles.flowLive} aria-hidden="true"><i /><i /><i /></span>}
        </div>;
      })}
    </div>
    <div className={styles.flowNav}>
      <button type="button" onClick={() => move(-1)} aria-label={vi ? 'Bản trước' : 'Previous recording'}><ChevronLeft size={19} /></button>
      <div className={styles.flowDots} aria-hidden="true">{tracks.map((track, index) => <i key={track.id} data-on={active % tracks.length === index || undefined} />)}</div>
      <button type="button" onClick={() => move(1)} aria-label={vi ? 'Bản kế tiếp' : 'Next recording'}><ChevronRight size={19} /></button>
    </div>
  </div>;
}

function wrap(value: number, count: number) { const half = Math.floor(count / 2); return ((value + half) % count + count) % count - half; }
function swallow(event: Event) { event.stopPropagation(); event.preventDefault(); }
