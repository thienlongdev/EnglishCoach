/// <reference lib="webworker" />
/* Builds the Echo Living Planet off the main thread. Input: quality options. Output: transferable typed arrays. */
import { buildPlanet, type BuildOptions, type PlanetBuild } from './build';

function buffers(build: PlanetBuild) {
  const set = new Set<ArrayBuffer>();
  const add = (a: { buffer: ArrayBufferLike }) => { if (a.buffer instanceof ArrayBuffer) set.add(a.buffer); };
  Object.values(build.terrain).forEach(add); Object.values(build.ocean).forEach(add); Object.values(build.landmarks).forEach(add);
  for (const list of Object.values(build.props)) for (const c of list) { add(c.matrices); add(c.colors); }
  for (const s of build.sites) add(s.sockets);
  return [...set];
}

self.onmessage = (event: MessageEvent<{ id: number; options: BuildOptions }>) => {
  const { id, options } = event.data;
  try {
    const result = buildPlanet(options);
    (self as unknown as Worker).postMessage({ id, result }, buffers(result));
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: String((error as Error)?.message || error) });
  }
};
