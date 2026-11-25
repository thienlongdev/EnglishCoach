import type { WorldFactory } from './types';

/** One lazy chunk per world: selecting a world downloads only its own code. */
const LOADERS: Record<string, () => Promise<{ default: WorldFactory }>> = {
  'echo-abyss': () => import('./scenes/echoAbyss'),
  'ascii-dreamscape': () => import('./ascii/dreamscape'),
  'aurora-silk': () => import('./scenes/auroraSilk'),
  'luminous-garden': () => import('./scenes/luminousGarden'),
  'sakura-breeze': () => import('./scenes/sakuraBreeze'),
  'crystal-mirage': () => import('./scenes/crystalMirage'),
  'celestial-observatory': () => import('./scenes/celestialObservatory'),
  'ink-and-paper': () => import('./scenes/inkAndPaper'),
  'terminal-rain': () => import('./ascii/terminalRain'),
  'cloud-sanctuary': () => import('./scenes/cloudSanctuary'),
  'echo-code-garden': () => import('./ascii/codeGarden'),
  'cloud-drift': () => import('./ascii/cloudDrift'),
  'lagoon-letters': () => import('./ascii/lagoonLetters'),
  'koi-pond': () => import('./ascii/koiPond'),
  'jellyfish-ballet': () => import('./ascii/jellyfishBallet'),
  'paper-boats': () => import('./ascii/paperBoats'),
  'fireflies-at-dusk': () => import('./ascii/firefliesAtDusk'),
  'moonlit-characters': () => import('./ascii/moonlitCharacters'),
  'liquid-lab': () => import('./scenes/liquidLab'),
  'particle-constellation': () => import('./scenes/particleConstellation'),
};

export async function loadWorld(id: string): Promise<WorldFactory> {
  const loader = LOADERS[id];
  if (!loader) throw new Error('unknown world');
  return (await loader()).default;
}

export const LOADER_IDS = Object.keys(LOADERS);
