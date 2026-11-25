/**
 * Echo Life Phase 3 — proves the residents' navigation graph off the page (≈ 41 000 legs at 3.5 cm ≈ 5 s of CPU on a desktop).
 * The house and city plans are deterministic in the study room's size, so the worker rebuilds the very same graph and sends
 * back only which legs are walkable (`LifeNav.exportEdges`). Pure computation: no network, no DOM.
 */
import { housePlan } from '../plan';
import { cityPlan } from '../city';
import { LifeNav } from './nav';

self.onmessage = (e: MessageEvent<{ size: number; furniture: LifeNav['walk']['furniture'] }>) => {
  const house = housePlan(e.data.size);
  const nav = new LifeNav(house, cityPlan(house));
  nav.setFurniture(e.data.furniture);
  while (!nav.warm(1e9)) { /* proves every candidate leg */ }
  const out = nav.exportEdges();
  (self as unknown as Worker).postMessage({ size: e.data.size, ...out }, [out.keys.buffer, out.ok.buffer]);
};
