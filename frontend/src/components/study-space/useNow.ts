'use client';

import { useEffect, useState } from 'react';

/** The current time, re-read every `ms` (a view only: the timer itself never counts these ticks). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    const wake = () => setNow(Date.now());
    document.addEventListener('visibilitychange', wake);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', wake); };
  }, [ms]);
  return now;
}
