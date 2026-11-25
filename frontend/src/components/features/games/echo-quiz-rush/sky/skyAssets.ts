import { arenaCast } from '@/components/features/speaking/arena/arenaAssets';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SKY_ASSET_URLS } from './skyAssets.manifest';

/**
 * The Skybound art, made in Blender and by the texture generator (imports/sources-assets/owner-authored/
 * echo-quiz-rush-skybound/). Loaded once per page and shared by every world (lobby and race); a failed or slow file
 * never blocks a race — each consumer has a procedural stand-in and swaps in the authored art when it arrives.
 */
export interface SkyArt {
  /** The two playable heroes of the Skybound collection (one skeleton, one clip set): Lyra (`runner`) and Kai. */
  runner: GLTF | null; runnerKai: GLTF | null; props: GLTF | null; world: GLTF | null;
  runnerOrm: THREE.Texture | null; propsOrm: THREE.Texture | null;
  /** Course version 6 props (saws, crushers, gale bridge, tiles, stones, orbs, shutters, wheels). */
  props6: GLTF | null; props6Orm: THREE.Texture | null;
  /** Course version 7 props (spiked rollers, stepping stones, tilting deck, wind beam). */
  props7: GLTF | null; props7Orm: THREE.Texture | null;
  road: { albedo: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture } | null;
  ashlar: { albedo: THREE.Texture; normal: THREE.Texture } | null;
  rock: { detail: THREE.Texture; normal: THREE.Texture } | null;
}

let art: Promise<SkyArt> | null = null;
let ready: SkyArt | null = null;

function texture(url: string, color: boolean, nearest = false) {
  return new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader().load(url, t => {
      t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      if (nearest) { t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.flipY = false; }
      else { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
      resolve(t);
    }, undefined, reject);
  });
}
const glb = (url: string) => new GLTFLoader().loadAsync(url).catch(() => null);
const optional = <T,>(p: Promise<T>) => p.catch(() => null);

/** Starts (once) and returns the art; never rejects — missing pieces are null. */
export function loadSkyArt(): Promise<SkyArt> {
  art ??= (async () => {
    const u = SKY_ASSET_URLS as typeof SKY_ASSET_URLS & { props6?: string; props6Orm?: string; props7?: string; props7Orm?: string; runnerKai?: string };
    const [runner, props, world, runnerOrm, propsOrm, ra, rn, rr, aa, an, kd, kn, props6, props6Orm, props7, props7Orm] = await Promise.all([
      glb(u.runner), glb(u.props), glb(u.world), optional(texture(u.runnerOrm, false, true)), optional(texture(u.propsOrm, false, true)),
      optional(texture(u.roadAlbedo, true)), optional(texture(u.roadNormal, false)), optional(texture(u.roadRough, false)),
      optional(texture(u.ashlarAlbedo, true)), optional(texture(u.ashlarNormal, false)),
      optional(texture(u.rockDetail, false)), optional(texture(u.rockNormal, false)),
      u.props6 ? glb(u.props6) : Promise.resolve(null), u.props6Orm ? optional(texture(u.props6Orm, false, true)) : Promise.resolve(null),
      u.props7 ? glb(u.props7) : Promise.resolve(null), u.props7Orm ? optional(texture(u.props7Orm, false, true)) : Promise.resolve(null),
    ]);
    ready = {
      runner, runnerKai: kaiReady, props, world, runnerOrm, propsOrm, props6, props6Orm, props7, props7Orm,
      road: ra && rn && rr ? { albedo: ra, normal: rn, rough: rr } : null,
      ashlar: aa && an ? { albedo: aa, normal: an } : null,
      rock: kd && kn ? { detail: kd, normal: kn } : null,
    };
    return ready;
  })();
  return art;
}
/** The art if it has finished loading (synchronous, for per-frame swaps). */
export const skyArt = () => ready;

/**
 * The same people as in the Study Space and the Arena, for real players in a race: loaded when a real player needs them, shared by everyone
 * who wears that body. Until they arrive the Skybound runner stands in, so a race never waits.
 */
const casts = new Map<'LYRA' | 'KAI', Promise<GLTF | null>>(), castsReady = new Map<'LYRA' | 'KAI', GLTF>();
export const castArt = (hero: 'LYRA' | 'KAI') => castsReady.get(hero) ?? null;
export function loadCastArt(hero: 'LYRA' | 'KAI') {
  let p = casts.get(hero);
  if (!p) { p = glb(arenaCast[hero]).then(g => { if (g) castsReady.set(hero, g); return g; }); casts.set(hero, p); }
  return p;
}

let kai: Promise<GLTF | null> | null = null;
let kaiReady: GLTF | null = null;
/**
 * Kai's model loads only when a Kai is on screen (the player chose him, or a rival did): a Lyra-only race never downloads
 * him. Until he arrives a Kai racer is drawn with Lyra's model; the world swaps the model when this resolves.
 */
export function loadKai(): Promise<GLTF | null> {
  kai ??= (async () => {
    const url = (SKY_ASSET_URLS as { runnerKai?: string }).runnerKai;
    kaiReady = url ? await glb(url) : null;
    if (ready) ready.runnerKai = kaiReady;
    return kaiReady;
  })();
  return kai;
}
