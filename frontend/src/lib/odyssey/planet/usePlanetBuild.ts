'use client';
/* Builds the planet in a Web Worker and keeps the last results in memory, so leaving and re-entering Odyssey (or a
   module round trip) does not rebuild. No network: the planet is code, not downloaded assets. */
import { useEffect, useState } from 'react';
import type { BuildOptions, PlanetBuild } from './build';

const cache = new Map<string, Promise<PlanetBuild>>();
let seq = 0;

function run(options: BuildOptions): Promise<PlanetBuild> {
  return new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    try { worker = new Worker(new URL('./planet.worker.ts', import.meta.url), { type: 'module', name: 'odyssey-planet' }); }
    catch { worker = null; }
    if (!worker) { void import('./build').then(m => resolve(m.buildPlanet(options))).catch(reject); return; }
    const id = ++seq;
    worker.onmessage = (e: MessageEvent<{ id: number; result?: PlanetBuild; error?: string }>) => {
      if (e.data.id !== id) return;
      worker?.terminate();
      if (e.data.result) resolve(e.data.result); else reject(new Error(e.data.error || 'PLANET_BUILD_FAILED'));
    };
    worker.onerror = () => { worker?.terminate(); void import('./build').then(m => resolve(m.buildPlanet(options))).catch(reject); };
    worker.postMessage({ id, options });
  });
}

export function planetBuild(options: BuildOptions) {
  const key = JSON.stringify(options);
  let p = cache.get(key);
  if (!p) {
    p = run(options); cache.set(key, p);
    p.catch(() => cache.delete(key));
    while (cache.size > 2) cache.delete(cache.keys().next().value!);
  }
  return p;
}

export function usePlanetBuild(options: BuildOptions | null) {
  const key = options ? JSON.stringify(options) : '';
  const [state, setState] = useState<{ key: string; build: PlanetBuild | null; error: boolean }>({ key: '', build: null, error: false });
  useEffect(() => {
    if (!key) return;
    let live = true;
    planetBuild(JSON.parse(key) as BuildOptions).then(build => { if (live) setState({ key, build, error: false }); }, () => { if (live) setState({ key, build: null, error: true }); });
    return () => { live = false; };
  }, [key]);
  return state.key === key ? state : { key, build: null, error: false };
}
