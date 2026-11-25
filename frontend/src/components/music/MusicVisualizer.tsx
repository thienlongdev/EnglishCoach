'use client';
import { useEffect, useRef, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { useMusic } from './MusicProvider';
import styles from './Music.module.css';

export default function MusicVisualizer({ vi }: { vi: boolean }) {
  const { engine, playing, current } = useMusic();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [enabled, setEnabled] = useState(false);
  useEffect(() => { setEnabled(false); }, [current?.id]);
  useEffect(() => {
    if (!enabled || !playing || !engine?.analyser) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const data = new Uint8Array(engine.analyser.frequencyBinCount);
    let frame = 0, last = 0;
    const draw = (time: number) => {
      if (document.hidden || reduced.matches) { frame = 0; return; }
      frame = requestAnimationFrame(draw);
      if (time - last < 50 || !canvas.current || !engine.analyser) return;
      last = time;
      const ctx = canvas.current.getContext('2d'); if (!ctx) return;
      engine.analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, 480, 64);
      const accent = current?.accent ?? '#c3a2ed';
      const fill = ctx.createLinearGradient(0, 0, 0, 64); fill.addColorStop(0, '#ffffff'); fill.addColorStop(.5, accent); fill.addColorStop(1, '#ffffff'); ctx.fillStyle = fill;
      // Mirrored, rounded bars of the real analyser data (local recordings only).
      for (let index = 0; index < 48; index++) {
        const magnitude = data[Math.floor(index * data.length / 48)];
        const height = Math.max(3, magnitude / 255 * 60); ctx.globalAlpha = .3 + magnitude / 360;
        ctx.beginPath(); ctx.roundRect(index * 10 + 3, 32 - height / 2, 4, height, 2); ctx.fill();
      }
    };
    const resume = () => { if (!frame && !document.hidden && !reduced.matches) frame = requestAnimationFrame(draw); };
    resume(); document.addEventListener('visibilitychange', resume); reduced.addEventListener('change', resume);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', resume); reduced.removeEventListener('change', resume); };
  }, [enabled, playing, engine, current?.accent]);
  if (current?.source !== 'local') return <div className={styles.signalNote}><span className={styles.signalDot} data-playing={playing} />{vi ? 'Âm thanh nguyên bản · không lời' : 'Original recording · instrumental'}</div>;
  return <div className={styles.visualizer}>
    {enabled ? <canvas ref={canvas} width={480} height={64} aria-label={vi ? 'Phổ âm thanh thực' : 'Live audio spectrum'} data-testid="music-spectrum" /> : <button onClick={async () => setEnabled(await engine?.enableAnalysis() ?? false)}><AudioLines size={15} />{vi ? 'Bật phổ âm thanh' : 'Enable audio spectrum'}</button>}
  </div>;
}
