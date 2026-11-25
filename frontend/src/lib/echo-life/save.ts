/**
 * Echo Life — the learner's world save: where the body stands outside a study room, which house doors were left open, the
 * room's things carried out and set down in the house. It lives on the server (`/api/v1/echo-life/world`, V129), one document
 * per account; nothing of it is ever written into a study-space layout (that record stays the room's own).
 *
 * The client authors the document (it is where its own body and hands left things); the server bounds it and keeps only the
 * learner's own spaces. Writes are batched; a write based on an old revision is answered 409 with the current document, and
 * the two are merged entry by entry (the newer `at` wins, an entry this tab removed stays removed unless the other side set it
 * later). A copy of what is not yet acknowledged waits in this browser (per account) and is merged in on the next load, so a
 * tab closed between two writes loses nothing. Nothing of value (credits, purchases, rewards) is ever part of this document.
 */
import type { SpaceObject } from '@/lib/study-space/types';
import {
  FACE_MORPH_DEFS,
  OUTFIT_SLOTS,
  encodeLookV2,
  sanitizeCreatorProfile,
  type CharacterCreatorProfile,
  type FaceMorphKey,
  type OutfitSlotConfig,
  type OutfitSlotId,
} from '@/lib/avatar/characterCreator';

export const WORLD_SAVE_VERSION = 1;
export const MAX_SERVER_AVATAR_BYTES = 24 * 1024;

export interface LifePlace { x: number; y?: number; z: number; rotY: number; region: string; at: number }
export interface LifeDoorSave { open: boolean; angle: number; at: number }
export interface LifeObjectSave { held?: boolean; object: SpaceObject; region: string; at: number }

/** Exact outfit slot wire shape accepted by backend `EchoLifeService.normalizeOutfit`. */
export interface ServerAvatarOutfitSlot {
  slot: OutfitSlotId;
  name: string;
  top: string;
  outerwear?: string;
  bottom: string;
  shoes: string;
  accessories: string[];
  colors: {
    outerwear: string;
    top: string;
    bottom: string;
    shoes: string;
    accessory: string;
  };
  fabrics: {
    outerwear: string;
    top: string;
    bottom: string;
    shoes: string;
  };
  patterns: {
    outerwear: string;
    top: string;
    bottom: string;
    shoes: string;
  };
}

/** Exact per-account Character Creator `state.avatar` wire contract validated by `EchoLifeService.java` (<= 24 KB). */
export interface ServerAvatarState {
  version: 1 | 2;
  hero: 'LYRA' | 'KAI';
  hairId: string;
  hairColor: string;
  hairTipColor?: string;
  hairTipMix?: number;
  skinTone: string;
  irisColor: string;
  lipColor?: string;
  face?: Record<string, number | Record<string, number | string>>;
  body?: {
    heightScale: number;
    buildScale: number;
    shoulderWidth: number;
    legRatio: number;
    torsoDepth: number;
    hipWidth: number;
  };
  outfits: ServerAvatarOutfitSlot[];
  activeOutfit: number;
  autoSeasonalOutfit: boolean;
  identity?: {
    traitIds?: string[];
    desiredLifeId?: string;
    values?: string[];
    favorites?: string[];
  };
  wireCode: string;
  at: number;
}

export interface WorldState {
  v: 1;
  places: Record<string, LifePlace>;
  doors: Record<string, LifeDoorSave>;
  objects: Record<string, LifeObjectSave>;
  avatar?: ServerAvatarState;
}
export interface WorldRecord { saveVersion: number; revision: number; state: WorldState; updatedAt: string | null }
export type Section = 'places' | 'doors' | 'objects';

export interface WorldApi {
  get(): Promise<WorldRecord>;
  /** Resolves with the stored record; rejects with `{ status: 409, current }` on a stale revision. */
  put(state: WorldState, revision: number): Promise<WorldRecord>;
}

export const emptyWorld = (): WorldState => ({ v: 1, places: {}, doors: {}, objects: {} });
export const houseDoorKey = (space: string, door: string) => `house:${space}:${door}`;
export const objectKey = (space: string, id: string) => `${space}/${id}`;
const SECTIONS: Section[] = ['places', 'doors', 'objects'];
const OUTFIT_SLOT_IDS: readonly OutfitSlotId[] = OUTFIT_SLOTS.map(s => s.id);
const OUTFIT_LABEL_BY_ID = new Map<OutfitSlotId, string>(OUTFIT_SLOTS.map(s => [s.id, s.label]));

/** Maps a client `CharacterCreatorProfile` into the strict server `EchoLifeService.java` `state.avatar` document. */
export function serializeAvatarForServer(profile: CharacterCreatorProfile, at = Date.now()): ServerAvatarState {
  const safe = sanitizeCreatorProfile(profile);
  const face: Record<string, number | Record<string, number | string>> = {};
  for (const def of FACE_MORPH_DEFS) {
    face[def.key] = safe.faceMorphs[def.key];
  }
  face.makeup = {
    browThickness: safe.makeup.browThickness,
    browDarkness: safe.makeup.browDarkness,
    lipColor: safe.makeup.lipColor,
    lipOpacity: safe.makeup.lipOpacity,
    blushColor: safe.makeup.blushColor,
    blushIntensity: safe.makeup.blushIntensity,
    freckleDensity: safe.makeup.freckleDensity,
    facialHair: safe.makeup.facialHair,
  };

  const outfits: ServerAvatarOutfitSlot[] = OUTFIT_SLOT_IDS.map((slotId) => {
    const cfg: OutfitSlotConfig = safe.outfits[slotId];
    return {
      slot: slotId,
      name: OUTFIT_LABEL_BY_ID.get(slotId) ?? slotId,
      top: cfg.top,
      outerwear: cfg.outerwear,
      bottom: cfg.bottom,
      shoes: cfg.shoes,
      accessories: cfg.accessories.slice(0, 4),
      colors: {
        outerwear: cfg.colors.outerwear,
        top: cfg.colors.top,
        bottom: cfg.colors.bottom,
        shoes: cfg.colors.shoes,
        accessory: cfg.colors.accessory,
      },
      fabrics: {
        outerwear: cfg.fabrics.outerwear,
        top: cfg.fabrics.top,
        bottom: cfg.fabrics.bottom,
        shoes: cfg.fabrics.shoes,
      },
      patterns: {
        outerwear: cfg.patterns.outerwear,
        top: cfg.patterns.top,
        bottom: cfg.patterns.bottom,
        shoes: cfg.patterns.shoes,
      },
    };
  });

  const activeIdx = Math.max(0, Math.min(7, OUTFIT_SLOT_IDS.indexOf(safe.activeOutfitSlot)));
  const wireCode = encodeLookV2(safe);
  const safeAt = Number.isFinite(at) && at >= 0 ? Math.floor(at) : Date.now();

  return {
    version: 2,
    hero: safe.hero,
    hairId: safe.hairId,
    hairColor: safe.hairColor,
    hairTipColor: safe.hairTipColor,
    hairTipMix: safe.hairTipMix,
    skinTone: safe.skinHex,
    irisColor: safe.irisHex,
    lipColor: safe.makeup.lipColor,
    face,
    body: {
      heightScale: safe.body.heightScale,
      buildScale: safe.body.buildScale,
      shoulderWidth: safe.body.shoulderWidth,
      legRatio: safe.body.legRatio,
      torsoDepth: safe.body.torsoDepth,
      hipWidth: safe.body.hipWidth,
    },
    outfits,
    activeOutfit: activeIdx,
    autoSeasonalOutfit: safe.autoSeasonalOutfit,
    identity: {
      traitIds: safe.identity.traitIds.slice(0, 3),
      desiredLifeId: safe.identity.desiredLifeId,
      values: safe.identity.valueIds.slice(0, 3),
      favorites: safe.identity.likes.slice(0, 4),
    },
    wireCode,
    at: safeAt,
  };
}

/** Hydrates a `CharacterCreatorProfile` from either server `state.avatar` wire format or a direct client profile. */
export function deserializeAvatarFromServer(raw: unknown): CharacterCreatorProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const hero = obj.hero === 'KAI' ? 'KAI' : obj.hero === 'LYRA' ? 'LYRA' : null;
  if (!hero) return null;

  // Already a client-shaped profile (e.g. skinHex + outfits record)
  if (typeof obj.skinHex === 'string' && obj.outfits && !Array.isArray(obj.outfits)) {
    return sanitizeCreatorProfile(obj, hero);
  }

  const faceObj = obj.face && typeof obj.face === 'object' && !Array.isArray(obj.face)
    ? (obj.face as Record<string, unknown>)
    : {};
  const faceMorphs: Partial<Record<FaceMorphKey, unknown>> = {};
  for (const def of FACE_MORPH_DEFS) {
    if (faceObj[def.key] !== undefined) faceMorphs[def.key] = faceObj[def.key];
  }
  const rawMakeup = faceObj.makeup && typeof faceObj.makeup === 'object' && !Array.isArray(faceObj.makeup)
    ? (faceObj.makeup as Record<string, unknown>)
    : {};
  const makeup = {
    ...rawMakeup,
    ...(typeof rawMakeup.lipColor === 'string' ? {} : typeof obj.lipColor === 'string' ? { lipColor: obj.lipColor } : {}),
  };

  const outfitsMap: Record<string, unknown> = {};
  let activeOutfitSlot: OutfitSlotId = 'everyday';
  if (Array.isArray(obj.outfits)) {
    obj.outfits.forEach((entry, idx) => {
      if (!entry || typeof entry !== 'object') return;
      const slotRaw = (entry as Record<string, unknown>).slot;
      let slotId: OutfitSlotId | null = null;
      if (typeof slotRaw === 'string' && OUTFIT_SLOT_IDS.includes(slotRaw as OutfitSlotId)) {
        slotId = slotRaw as OutfitSlotId;
      } else if (typeof slotRaw === 'number' && slotRaw >= 0 && slotRaw < OUTFIT_SLOT_IDS.length) {
        slotId = OUTFIT_SLOT_IDS[slotRaw];
      } else if (idx < OUTFIT_SLOT_IDS.length) {
        slotId = OUTFIT_SLOT_IDS[idx];
      }
      if (slotId) {
        outfitsMap[slotId] = entry;
        if (typeof obj.activeOutfit === 'number' && Math.floor(obj.activeOutfit) === idx) {
          activeOutfitSlot = slotId;
        }
      }
    });
  } else if (obj.outfits && typeof obj.outfits === 'object') {
    Object.assign(outfitsMap, obj.outfits);
  }

  const idObj = obj.identity && typeof obj.identity === 'object' && !Array.isArray(obj.identity)
    ? (obj.identity as Record<string, unknown>)
    : {};
  const favs = Array.isArray(idObj.favorites) ? idObj.favorites : Array.isArray(idObj.likes) ? idObj.likes : undefined;
  const vals = Array.isArray(idObj.values) ? idObj.values : Array.isArray(idObj.valueIds) ? idObj.valueIds : undefined;

  return sanitizeCreatorProfile(
    {
      version: 2,
      hero,
      hairId: obj.hairId,
      hairColor: obj.hairColor,
      hairTipColor: obj.hairTipColor,
      hairTipMix: obj.hairTipMix,
      skinHex: typeof obj.skinTone === 'string' ? obj.skinTone : obj.skinHex,
      irisHex: typeof obj.irisColor === 'string' ? obj.irisColor : obj.irisHex,
      faceMorphs,
      makeup,
      body: obj.body,
      activeOutfitSlot,
      autoSeasonalOutfit: obj.autoSeasonalOutfit,
      outfits: outfitsMap,
      identity: {
        traitIds: idObj.traitIds,
        desiredLifeId: idObj.desiredLifeId,
        valueIds: vals,
        likes: favs,
      },
    },
    hero,
  );
}

function readAvatarNode(raw: unknown): ServerAvatarState | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const profile = deserializeAvatarFromServer(raw);
  if (!profile) return undefined;
  const rawAt = (raw as { at?: unknown }).at;
  const at = typeof rawAt === 'number' && Number.isFinite(rawAt) && rawAt >= 0 ? Math.floor(rawAt) : 0;
  return serializeAvatarForServer(profile, at);
}

/** Reads a stored document defensively: anything malformed is left out, never guessed. */
export function readWorld(raw: unknown): WorldState {
  const out = emptyWorld();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return out;
  for (const s of SECTIONS) {
    const m = r[s];
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (!v || typeof v !== 'object' || typeof (v as { at?: unknown }).at !== 'number') continue;
      (out[s] as Record<string, unknown>)[k] = v;
    }
  }
  const avatar = readAvatarNode(r.avatar);
  if (avatar) out.avatar = avatar;
  return out;
}

/**
 * Two versions of the world as one: for every entry the newer `at` wins. `removed` lists entries this side deleted (key → when):
 * the other side's copy survives only if it was set after that.
 */
export function mergeWorld(theirs: WorldState, mine: WorldState, removed: ReadonlyMap<string, number> = new Map()): WorldState {
  const out = emptyWorld();
  for (const s of SECTIONS) {
    const a = theirs[s] as Record<string, { at: number }>, b = mine[s] as Record<string, { at: number }>, o = out[s] as Record<string, { at: number }>;
    for (const [k, v] of Object.entries(a)) {
      const gone = removed.get(`${s}|${k}`);
      if (gone !== undefined && v.at <= gone) continue;
      o[k] = v;
    }
    for (const [k, v] of Object.entries(b)) if (!o[k] || v.at >= o[k].at) o[k] = v;
  }
  const aAv = theirs.avatar;
  const bAv = mine.avatar;
  const avGone = removed.get('avatar|profile');
  const keepA = aAv && (avGone === undefined || aAv.at > avGone) ? aAv : undefined;
  if (keepA && bAv) {
    out.avatar = bAv.at >= keepA.at ? bAv : keepA;
  } else if (bAv) {
    out.avatar = bAv;
  } else if (keepA) {
    out.avatar = keepA;
  }
  return out;
}

const pendingKey = (account: string | number | null | undefined) => {
  const a = String(account ?? '').replace(/[^\w-]/g, '');
  return a ? `ec_echo_life_pending:v1:u${a}` : null;
};

/**
 * One account's world, as this tab sees it. `onChange` fires when the server's copy brought something new (another tab's doors,
 * a merge after a conflict) so the scene can follow.
 */
export class WorldSaver {
  state: WorldState = emptyWorld();
  revision = 0;
  loaded = false;
  /** The last write failed for a reason a retry may fix (offline, 5xx); the copy is safe in this browser meanwhile. */
  failing = false;
  private removed = new Map<string, number>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private writing: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;
  private readonly key: string | null;
  private listeners = new Set<() => void>();

  constructor(private api: WorldApi, account: string | number | null | undefined, private delayMs = 4000) {
    this.key = pendingKey(account);
  }

  onChange(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private changed() { for (const fn of this.listeners) fn(); }

  /** The server's copy, with anything this browser had not yet written merged in (and then written). */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const pending = this.readPending();
      try {
        const rec = await this.api.get();
        if (this.disposed) return;
        this.revision = rec.revision;
        this.state = rec.saveVersion === WORLD_SAVE_VERSION ? mergeWorld(readWorld(rec.state), this.state, this.removed) : this.state;
        if (pending) { this.state = mergeWorld(this.state, pending.state, new Map(pending.removed)); this.dirty = true; }
      } catch {
        // No server answer: this browser's own copy is the best there is until it answers.
        if (pending) { this.state = mergeWorld(this.state, pending.state, new Map(pending.removed)); this.dirty = true; }
      }
      this.loaded = true;
      this.changed();
      if (this.dirty) this.schedule(0);
    })();
    return this.loading;
  }

  place(space: string): LifePlace | null { return this.state.places[space] ?? null; }
  door(key: string): LifeDoorSave | null { return this.state.doors[key] ?? null; }
  objectsOf(space: string): LifeObjectSave[] {
    const prefix = `${space}/`;
    return Object.entries(this.state.objects).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  }

  setPlace(space: string, place: Omit<LifePlace, 'at'> | null) { this.set('places', space, place); }
  /** A door settles once when opened or closed by hand; write promptly so reloads keep the door state. */
  setDoor(key: string, door: Omit<LifeDoorSave, 'at'> | null) { this.set('doors', key, door, 350); }
  /** A thing out of its room is written at once: its record must exist before the room's layout lets it go. */
  setObject(space: string, id: string, entry: Omit<LifeObjectSave, 'at'> | null) { this.set('objects', objectKey(space, id), entry, 0); }

  /** Loads the signed-in account's Character Creator profile persisted in `echo_life_worlds.state.avatar`, or null if none. */
  loadAvatarProfile(): CharacterCreatorProfile | null {
    return this.state.avatar ? deserializeAvatarFromServer(this.state.avatar) : null;
  }

  /** Returns the current validated V2 wire look code for shared-world multiplayer presence, or null if unsaved. */
  avatarWireCode(): string | null {
    return this.state.avatar?.wireCode ?? null;
  }

  /**
   * Persists the learner's Character Creator profile into PostgreSQL `public.echo_life_worlds.state.avatar`.
   * Writes pending local backup immediately, schedules a debounced server PUT (or immediate when `delayMs === 0`),
   * and merges cleanly on 409 conflicts so cross-device logins and reloads keep the newest look.
   */
  saveAvatarProfile(profile: CharacterCreatorProfile | null, delayMs = 250): Promise<void> {
    const at = Date.now();
    if (profile) {
      const encoded = serializeAvatarForServer(profile, at);
      if (new TextEncoder().encode(JSON.stringify(encoded)).length > MAX_SERVER_AVATAR_BYTES) {
        return Promise.resolve();
      }
      this.state.avatar = encoded;
      this.removed.delete('avatar|profile');
    } else if (this.state.avatar) {
      delete this.state.avatar;
      this.removed.set('avatar|profile', at);
    } else {
      return Promise.resolve();
    }
    this.dirty = true;
    this.writePending();
    this.changed();
    if (!this.loaded) {
      return this.load().then(() => this.flush());
    }
    if (delayMs <= 0) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      return this.flush();
    }
    this.schedule(delayMs);
    return Promise.resolve();
  }

  private set<S extends Section>(section: S, key: string, value: object | null, delay = this.delayMs) {
    const at = Date.now(), map = this.state[section] as Record<string, unknown>;
    if (value) { map[key] = { ...value, at }; this.removed.delete(`${section}|${key}`); }
    else if (map[key]) { delete map[key]; this.removed.set(`${section}|${key}`, at); }
    else return;
    this.dirty = true;
    this.writePending();
    this.schedule(delay);
  }

  private schedule(delay: number) {
    if (this.disposed || !this.loaded) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delay);
  }

  /** Writes what changed; a stale revision is merged with the current document and written again (at most three times). */
  flush(): Promise<void> {
    if (!this.loaded || !this.dirty) return this.writing ?? Promise.resolve();
    if (this.writing) return this.writing.then(() => this.flush());
    this.writing = (async () => {
      for (let attempt = 0; attempt < 3 && this.dirty && !this.disposed; attempt++) {
        const sent = this.state, base = this.revision;
        this.dirty = false;
        try {
          const rec = await this.api.put(sent, base);
          this.revision = rec.revision; this.failing = false; this.retryAttempt = 0;
          // Whatever changed while the request was out stays dirty; what the server answered is the truth for the rest.
          if (!this.dirty) { this.state = readWorld(rec.state); this.removed.clear(); this.clearPending(); }
          return;
        } catch (e) {
          const err = e as { status?: number; current?: WorldRecord };
          if (err.status === 409 && err.current) {
            this.revision = err.current.revision;
            this.state = mergeWorld(readWorld(err.current.state), this.state, this.removed);
            this.dirty = true;
            this.changed();
            continue;
          }
          this.dirty = true;
          this.failing = true;
          // Bad request: the document itself is refused, retrying it unchanged cannot help; anything else is retried with backoff.
          if (err.status === 400 || err.status === 413) { this.dirty = false; this.clearPending(); return; }
          if (!this.disposed) {
            if (this.timer) clearTimeout(this.timer);
            const waitMs = Math.round(Math.min(30000, 4000 * Math.pow(2, Math.min(this.retryAttempt++, 3))) * (0.85 + Math.random() * 0.3));
            this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, waitMs);
          }
          return;
        }
      }
    })().finally(() => { this.writing = null; });
    return this.writing;
  }

  private readPending(): { state: WorldState; removed: [string, number][] } | null {
    if (!this.key) return null;
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) ?? 'null') as { state?: unknown; removed?: unknown } | null;
      if (!raw) return null;
      return { state: readWorld(raw.state), removed: Array.isArray(raw.removed) ? raw.removed.filter((x): x is [string, number] => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'number') : [] };
    } catch { return null; }
  }
  private writePending() {
    if (!this.key) return;
    try { localStorage.setItem(this.key, JSON.stringify({ state: this.state, removed: [...this.removed] })); } catch { /* storage refused: the server write is the record */ }
  }
  private clearPending() { if (this.key) try { localStorage.removeItem(this.key); } catch { /* nothing */ } }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }
}
