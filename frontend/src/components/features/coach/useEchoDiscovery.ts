import { useEffect, useRef, useState } from 'react';
import { authEnding, authSignal } from '@/lib/auth-lifecycle';

const KEY = 'echo_discovery_session';
export const DISCOVERY_DELAY = 4500;
export const DISCOVERY_MOTION = 380;
export const DISCOVERY_DWELL = 5000;
type Phase = 'hidden' | 'entering' | 'visible' | 'leaving';
type Visit = { scope: string; consumed: boolean; due: number };
let visit: Visit | null = null;
const greetings = [
  ['Echo ở đây nếu bạn cần mình nhé!', 'Echo is here whenever you need a hand!'],
  ['Gặp từ nào khó cứ gọi Echo nhé.', 'Found a tricky word? Ask Echo.'],
  ['Hôm nay mình cùng học một chút tiếng Anh nha!', 'Let’s learn a little English together today!'],
  ['Có gì chưa rõ cứ hỏi mình nhé.', 'If anything is unclear, just ask me.'],
];
function persist() {
  try { if (visit) localStorage.setItem(KEY, JSON.stringify(visit)); } catch {}
}
function sessionVisit(scope: string): Visit {
  if (!visit) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (saved?.scope === scope && typeof saved.consumed === 'boolean' && Number.isFinite(saved.due)) visit = saved;
    } catch {}
  }
  if (!visit || visit.scope !== scope) {
    visit = { scope, consumed: false, due: Date.now() + DISCOVERY_DELAY };
    persist();
  }
  return visit;
}

/** Global Echo owns this hook; the non-private session marker survives route/remount/refresh/tabs. */
export function useEchoDiscovery(scope: string, authenticated: boolean, open: boolean, vi: boolean) {
  const [phase, setPhase] = useState<Phase>('hidden');
  const [copy] = useState(() => Math.floor(Math.random() * greetings.length));
  const activeTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    setPhase('hidden');
    if (!scope || !authenticated || authEnding()) return;
    const current = sessionVisit(scope);
    const signal = authSignal();
    const timers: ReturnType<typeof setTimeout>[] = [];
    activeTimers.current = timers;
    const clear = () => timers.forEach(clearTimeout);
    const cancel = () => {
      clear(); setPhase('hidden');
      if (visit === current) { visit = null; try { localStorage.removeItem(KEY); } catch {} }
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (open) { current.consumed = true; persist(); }
    if (!current.consumed) {
      timers.push(setTimeout(() => {
        if (signal.aborted || authEnding() || visit !== current || current.consumed) return;
        // Another tab may already have shown/opened Echo during this login.
        try {
          const shared = JSON.parse(localStorage.getItem(KEY) || 'null');
          if (shared?.scope === scope && shared.consumed === true) { current.consumed = true; return; }
        } catch {}
        current.consumed = true; persist(); setPhase('entering');
        timers.push(setTimeout(() => setPhase('visible'), DISCOVERY_MOTION));
        timers.push(setTimeout(() => setPhase('leaving'), DISCOVERY_MOTION + DISCOVERY_DWELL));
        timers.push(setTimeout(() => setPhase('hidden'), DISCOVERY_MOTION * 2 + DISCOVERY_DWELL));
      }, Math.max(0, current.due - Date.now())));
    }
    return () => { clear(); signal.removeEventListener('abort', cancel); };
  }, [scope, authenticated]);
  useEffect(() => {
    if (!open || !scope || !authenticated) return;
    activeTimers.current.forEach(clearTimeout);
    const current = sessionVisit(scope); current.consumed = true; persist();
    setPhase(previous => previous === 'entering' || previous === 'visible' ? 'leaving' : previous);
  }, [open, scope, authenticated]);
  useEffect(() => {
    if (phase !== 'leaving') return;
    const timer = setTimeout(() => setPhase('hidden'), DISCOVERY_MOTION);
    return () => clearTimeout(timer);
  }, [phase]);
  return { phase, text: greetings[copy][vi ? 0 : 1] };
}
